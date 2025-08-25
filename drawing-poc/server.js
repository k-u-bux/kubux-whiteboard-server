const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');
const {
  generateUuid,
  hashAny,
  hashNext,
  MESSAGES,
  MOD_ACTIONS,
  isUndoAction,
  isRedoAction,
  getUndoTarget,
  getRedoTarget,
  isActionUndone,
  findUndoActionFor
} = require('./shared.js');

// Server configuration
const PORT = process.env.PORT || 8080;
const BOARD_DIR = path.join(__dirname, 'data', 'boards');
const PENDING_DELETION_DIR = path.join(__dirname, 'data', 'pending_deletion');
const LOG_DIR = path.join(__dirname, 'logs');

// Ensure directories exist
[BOARD_DIR, PENDING_DELETION_DIR, LOG_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

// In-memory state
const boards = {};
const clients = {};
const deletionMap = {};

// Create HTTP server
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('WebSocket server for Xournal++ Clone');
});

// Create WebSocket server
const wss = new WebSocket.Server({ server });

// Logging setup
const logStream = fs.createWriteStream(path.join(LOG_DIR, `server-${new Date().toISOString().replace(/:/g, '-')}.log`), { flags: 'a' });

function log(message) {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] ${message}`;
  console.log(logMessage);
  logStream.write(logMessage + '\n');
}

function logReceivedMessage(type, data, requestId) {
  log(`[RECEIVED] ${type}${requestId ? ` (request: ${requestId})` : ''}`);
}

function logSentMessage(type, data, requestId) {
  log(`[SENT] ${type}${requestId ? ` (request: ${requestId})` : ''}`);
}

// Save board metadata to disk
function saveBoardMetadata() {
  Object.keys(boards).forEach(boardId => {
    const board = boards[boardId];
    const metadataPath = path.join(BOARD_DIR, boardId, 'metadata.json');
    
    // Ensure board directory exists
    const boardDir = path.join(BOARD_DIR, boardId);
    if (!fs.existsSync(boardDir)) {
      fs.mkdirSync(boardDir, { recursive: true });
    }
    
    // Create metadata object (excluding page content for efficiency)
    const metadata = {
      pageOrder: board.pageOrder,
      deletionMap: {} // Store relevant deletion mappings
    };
    
    // Add relevant deletion mappings
    board.pageOrder.forEach(pageId => {
      if (deletionMap[pageId]) {
        metadata.deletionMap[pageId] = deletionMap[pageId];
      }
    });
    
    // Write to file
    fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));
  });
}

// Save a page to disk
function savePageToDisk(pageUuid, modActions) {
  // Find which board this page belongs to
  let boardId = null;
  Object.keys(boards).forEach(bid => {
    if (boards[bid].pages[pageUuid]) {
      boardId = bid;
    }
  });
  
  if (!boardId) {
    log(`[ERROR] Cannot save page ${pageUuid}: not found in any board`);
    return;
  }
  
  const pagePath = path.join(BOARD_DIR, boardId, `${pageUuid}.json`);
  
  // Ensure board directory exists
  const boardDir = path.join(BOARD_DIR, boardId);
  if (!fs.existsSync(boardDir)) {
    fs.mkdirSync(boardDir, { recursive: true });
  }
  
  // Write to file
  fs.writeFileSync(pagePath, JSON.stringify(modActions, null, 2));
}

// Append a mod action to the page file on disk
function appendModActionToDisk(pageUuid, modAction) {
  // Find which board this page belongs to
  let boardId = null;
  Object.keys(boards).forEach(bid => {
    if (boards[bid].pages[pageUuid]) {
      boardId = bid;
    }
  });
  
  if (!boardId) {
    log(`[ERROR] Cannot append action to page ${pageUuid}: not found in any board`);
    return;
  }
  
  const pagePath = path.join(BOARD_DIR, boardId, `${pageUuid}.json`);
  
  // Ensure board directory exists
  const boardDir = path.join(BOARD_DIR, boardId);
  if (!fs.existsSync(boardDir)) {
    fs.mkdirSync(boardDir, { recursive: true });
  }
  
  // Read existing actions
  let modActions = [];
  if (fs.existsSync(pagePath)) {
    modActions = JSON.parse(fs.readFileSync(pagePath, 'utf8'));
  }
  
  // Append new action
  modActions.push(modAction);
  
  // Write back to file
  fs.writeFileSync(pagePath, JSON.stringify(modActions, null, 2));
}

// Ensure a page is loaded in memory
function ensurePageLoaded(boardId, pageId) {
  // If board doesn't exist, return false
  if (!boards[boardId]) {
    return false;
  }
  
  // If page is already loaded, return true
  if (boards[boardId].pages[pageId]) {
    return true;
  }
  
  // Check if page exists on disk
  const pagePath = path.join(BOARD_DIR, boardId, `${pageId}.json`);
  if (!fs.existsSync(pagePath)) {
    return false;
  }
  
  // Load page from disk
  try {
    const modActions = JSON.parse(fs.readFileSync(pagePath, 'utf8'));
    
    // Calculate current hash
    let currentHash = hashAny([]);
    modActions.forEach(action => {
      if (action.hashes && action.hashes[MESSAGES.SERVER_TO_CLIENT.ACCEPT_MESSAGE.AFTER_HASH]) {
        currentHash = action.hashes[MESSAGES.SERVER_TO_CLIENT.ACCEPT_MESSAGE.AFTER_HASH];
      }
    });
    
    // Add page to in-memory state
    boards[boardId].pages[pageId] = {
      modActions: modActions,
      currentHash: currentHash
    };
    
    return true;
  } catch (error) {
    log(`[ERROR] Failed to load page ${pageId} from disk: ${error.message}`);
    return false;
  }
}

// Load an existing board or create a new one
function loadOrCreateBoard(boardId) {
  // If board is already loaded, return it
  if (boards[boardId]) {
    return boards[boardId];
  }
  
  // Check if board exists on disk
  const boardDir = path.join(BOARD_DIR, boardId);
  const metadataPath = path.join(boardDir, 'metadata.json');
  
  if (fs.existsSync(metadataPath)) {
    // Load existing board
    try {
      const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
      
      // Initialize board with metadata
      boards[boardId] = {
        pageOrder: metadata.pageOrder || [],
        pages: {}
      };
      
      // Add to deletion map
      if (metadata.deletionMap) {
        Object.assign(deletionMap, metadata.deletionMap);
      }
      
      // Return the loaded board (pages will be loaded on demand)
      return boards[boardId];
    } catch (error) {
      log(`[ERROR] Failed to load board ${boardId} from disk: ${error.message}`);
    }
  }
  
  // Create new board
  const newBoard = {
    pageOrder: [],
    pages: {}
  };
  
  // Create initial page
  const initialPageId = generateUuid();
  newBoard.pageOrder.push(initialPageId);
  newBoard.pages[initialPageId] = {
    modActions: [],
    currentHash: hashAny([])
  };
  
  // Save to memory and disk
  boards[boardId] = newBoard;
  
  // Ensure board directory exists
  if (!fs.existsSync(boardDir)) {
    fs.mkdirSync(boardDir, { recursive: true });
  }
  
  // Save metadata and initial page
  saveBoardMetadata();
  savePageToDisk(initialPageId, []);
  
  return newBoard;
}

// Mark an item for deletion (move to pending_deletion directory)
function markForDeletion(uuid, type, metadata) {
  // Find which board this item belongs to
  let boardId = metadata.boardId;
  
  if (!boardId) {
    log(`[ERROR] Cannot mark ${type} ${uuid} for deletion: no board ID provided`);
    return;
  }
  
  // Ensure pending_deletion directory exists
  if (!fs.existsSync(PENDING_DELETION_DIR)) {
    fs.mkdirSync(PENDING_DELETION_DIR, { recursive: true });
  }
  
  // Create deletion metadata
  const deletionMetadata = {
    uuid: uuid,
    type: type,
    deletedAt: new Date().toISOString(),
    ...metadata
  };
  
  // Write deletion metadata
  const metadataPath = path.join(PENDING_DELETION_DIR, `${uuid}.json`);
  fs.writeFileSync(metadataPath, JSON.stringify(deletionMetadata, null, 2));
  
  // If it's a page, move the page file to pending_deletion
  if (type === 'page') {
    const sourcePath = path.join(BOARD_DIR, boardId, `${uuid}.json`);
    const destPath = path.join(PENDING_DELETION_DIR, `${uuid}-content.json`);
    
    if (fs.existsSync(sourcePath)) {
      try {
        // Copy the file to pending_deletion
        fs.copyFileSync(sourcePath, destPath);
        // Note: We don't delete from the source yet to allow for potential undeletion
        // This will be handled by a separate cleanup process
      } catch (error) {
        log(`[ERROR] Failed to move deleted page ${uuid} to pending_deletion: ${error.message}`);
      }
    }
  }
}

// Send a full page to a client
function sendFullPage(ws, boardId, pageId, requestId) {
  let finalPageId = pageId;
  let redirectCount = 0;
  const MAX_REDIRECTS = 10; // Safety limit
  
  // Follow the deletion chain with a safety counter
  while (deletionMap[finalPageId] && !boards[boardId].pages[finalPageId] && redirectCount < MAX_REDIRECTS) {
    log(`[SERVER] Following deletion redirect: ${finalPageId} -> ${deletionMap[finalPageId]}`);
    finalPageId = deletionMap[finalPageId];
    redirectCount++;
  }
  
  // Safety check - if we hit the redirect limit
  if (redirectCount >= MAX_REDIRECTS) {
    log(`[ERROR] Too many page redirects when loading page ${pageId}. Falling back to first page.`);
    // Fall back to the first page of the board
    const currentBoard = boards[boardId];
    if (currentBoard && currentBoard.pageOrder.length > 0) {
      finalPageId = currentBoard.pageOrder[0];
    } else {
      log(`[ERROR] Cannot find any pages for board ${boardId}`);
      return;
    }
  }
  
  const currentBoard = boards[boardId];
  if (!currentBoard) {
    log(`[ERROR] Board not found: ${boardId}`);
    return;
  }
  
  // Ensure the page is loaded in memory
  if (!ensurePageLoaded(boardId, finalPageId)) {
    log(`[ERROR] Page not found: ${finalPageId} on board: ${boardId}`);
    
    // If page not found, fall back to the first available page
    if (currentBoard.pageOrder.length > 0) {
      log(`[SERVER] Falling back to first page: ${currentBoard.pageOrder[0]}`);
      finalPageId = currentBoard.pageOrder[0];
      if (!ensurePageLoaded(boardId, finalPageId)) {
        log(`[ERROR] Cannot load any pages for board ${boardId}`);
        return;
      }
    } else {
      log(`[ERROR] No pages available for board ${boardId}`);
      return;
    }
  }
  
  ws.boardId = boardId;
  ws.pageId = finalPageId;
  
  const pageState = currentBoard.pages[finalPageId].modActions;
  const pageHash = currentBoard.pages[finalPageId].currentHash;
  const pageNr = currentBoard.pageOrder.indexOf(finalPageId) + 1;
  const totalPages = currentBoard.pageOrder.length;
  
  const message = {
    type: MESSAGES.SERVER_TO_CLIENT.FULL_PAGE.TYPE,
    boardId: boardId,
    [MESSAGES.SERVER_TO_CLIENT.FULL_PAGE.PAGE]: finalPageId,
    [MESSAGES.SERVER_TO_CLIENT.FULL_PAGE.STATE]: pageState,
    [MESSAGES.SERVER_TO_CLIENT.FULL_PAGE.HASH]: pageHash,
    [MESSAGES.SERVER_TO_CLIENT.FULL_PAGE.PAGE_NR]: pageNr,
    [MESSAGES.SERVER_TO_CLIENT.FULL_PAGE.TOTAL_PAGES]: totalPages
  };
  
  ws.send(JSON.stringify(message));
  logSentMessage(message.type, message, requestId);
}

// Send a decline message to a client
function sendDeclineMessage(ws, boardId, pageUuid, actionUuid, reason = "") {
  const declineMessage = {
    type: MESSAGES.SERVER_TO_CLIENT.DECLINE_MESSAGE.TYPE,
    boardId: boardId,
    [MESSAGES.SERVER_TO_CLIENT.DECLINE_MESSAGE.PAGE_UUID]: pageUuid,
    [MESSAGES.SERVER_TO_CLIENT.DECLINE_MESSAGE.ACTION_UUID]: actionUuid
  };
  
  // Add reason if provided
  if (reason) {
    declineMessage[MESSAGES.SERVER_TO_CLIENT.DECLINE_MESSAGE.REASON] = reason;
  }
  
  ws.send(JSON.stringify(declineMessage));
  logSentMessage(declineMessage.type, declineMessage);
}

// Broadcast a message to all clients on a board
function broadcastMessageToBoard(message, boardId) {
  Object.values(clients).forEach(client => {
    if (client.boardId === boardId && client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(message));
    }
  });
}

// Message handlers
const messageHandlers = {};

// Handle board registration
messageHandlers[MESSAGES.CLIENT_TO_SERVER.REGISTER_BOARD.TYPE] = (ws, data, requestId) => {
  const boardId = data[MESSAGES.CLIENT_TO_SERVER.REGISTER_BOARD.BOARD_ID];
  const clientId = data[MESSAGES.CLIENT_TO_SERVER.REGISTER_BOARD.CLIENT_ID];
  
  if (!boardId) {
    log(`[ERROR] Missing boardId in registration message`);
    return;
  }
  
  // Load or create the board
  const board = loadOrCreateBoard(boardId);
  
  // Register the client
  ws.boardId = boardId;
  if (clientId) {
    ws.clientId = clientId;
    clients[clientId] = ws;
  }
  
  // Select initial page
  const initialPageId = board.pageOrder[0];
  
  // Send registration acknowledgment
  const registrationResponse = {
    type: MESSAGES.SERVER_TO_CLIENT.BOARD_REGISTERED.TYPE,
    [MESSAGES.SERVER_TO_CLIENT.BOARD_REGISTERED.BOARD_ID]: boardId,
    [MESSAGES.SERVER_TO_CLIENT.BOARD_REGISTERED.INITIAL_PAGE_ID]: initialPageId,
    [MESSAGES.SERVER_TO_CLIENT.BOARD_REGISTERED.TOTAL_PAGES]: board.pageOrder.length,
    [MESSAGES.SERVER_TO_CLIENT.BOARD_REGISTERED.REQUEST_ID]: requestId
  };
  
  ws.send(JSON.stringify(registrationResponse));
  logSentMessage(registrationResponse.type, registrationResponse, requestId);
  
  // Send full page for initial page
  sendFullPage(ws, boardId, initialPageId, requestId);
};

// Handle full page requests
messageHandlers[MESSAGES.CLIENT_TO_SERVER.FULL_PAGE_REQUESTS.TYPE] = (ws, data, requestId) => {
  const boardId = data.boardId || ws.boardId;
  const board = boards[boardId];
  
  if (!board) {
    log(`[ERROR] Board not found: ${boardId}`);
    return;
  }
  
  // Determine which page to send
  let targetPageId;
  
  if (data[MESSAGES.CLIENT_TO_SERVER.FULL_PAGE_REQUESTS.PAGE_ID]) {
    // Direct page request
    targetPageId = data[MESSAGES.CLIENT_TO_SERVER.FULL_PAGE_REQUESTS.PAGE_ID];
  } else if (data.pageNumber !== undefined) {
    // Page number request (1-based)
    const pageNumber = parseInt(data.pageNumber);
    if (pageNumber >= 1 && pageNumber <= board.pageOrder.length) {
      targetPageId = board.pageOrder[pageNumber - 1];
    } else {
      log(`[ERROR] Invalid page number: ${pageNumber}`);
      return;
    }
  } else if (data[MESSAGES.CLIENT_TO_SERVER.FULL_PAGE_REQUESTS.DELTA] !== undefined) {
    // Relative navigation
    const delta = parseInt(data[MESSAGES.CLIENT_TO_SERVER.FULL_PAGE_REQUESTS.DELTA]);
    const currentPageId = ws.pageId;
    const currentIndex = board.pageOrder.indexOf(currentPageId);
    
    if (currentIndex === -1) {
      log(`[ERROR] Current page not found in board: ${currentPageId}`);
      return;
    }
    
    const newIndex = Math.max(0, Math.min(currentIndex + delta, board.pageOrder.length - 1));
    targetPageId = board.pageOrder[newIndex];
  } else {
    log(`[ERROR] Invalid fullPage request: missing pageId, pageNumber, or delta`);
    return;
  }
  
  // Send the requested page
  sendFullPage(ws, boardId, targetPageId, requestId);
};

// Handle replay requests
messageHandlers[MESSAGES.CLIENT_TO_SERVER.REPLAY_REQUESTS.TYPE] = (ws, data, requestId) => {
  const boardId = data.boardId || ws.boardId;
  const pageUuid = data[MESSAGES.CLIENT_TO_SERVER.REPLAY_REQUESTS.PAGE_UUID];
  const beforeHash = data[MESSAGES.CLIENT_TO_SERVER.REPLAY_REQUESTS.BEFORE_HASH];
  
  const board = boards[boardId];
  if (!board) {
    log(`[ERROR] Board not found: ${boardId}`);
    return;
  }
  
  // Ensure the page is loaded
  if (!ensurePageLoaded(boardId, pageUuid)) {
    log(`[ERROR] Page not found: ${pageUuid}`);
    return;
  }
  
  const page = board.pages[pageUuid];
  
  // Find the action with the matching before-hash
  let startIndex = -1;
  for (let i = 0; i < page.modActions.length; i++) {
    const action = page.modActions[i];
    if (action.hashes && action.hashes[MESSAGES.SERVER_TO_CLIENT.ACCEPT_MESSAGE.BEFORE_HASH] === beforeHash) {
      startIndex = i;
      break;
    }
  }
  
  if (startIndex === -1) {
    log(`[ERROR] No action found with before-hash: ${beforeHash}`);
    // Send full page instead
    sendFullPage(ws, boardId, pageUuid, requestId);
    return;
  }
  
  // Collect all actions from the starting point
  const sequence = page.modActions.slice(startIndex);
  
  // Send replay message
  const replayMessage = {
    type: MESSAGES.SERVER_TO_CLIENT.REPLAY_MESSAGE.TYPE,
    boardId: boardId,
    [MESSAGES.SERVER_TO_CLIENT.REPLAY_MESSAGE.PAGE_UUID]: pageUuid,
    [MESSAGES.SERVER_TO_CLIENT.REPLAY_MESSAGE.BEFORE_HASH]: beforeHash,
    [MESSAGES.SERVER_TO_CLIENT.REPLAY_MESSAGE.AFTER_HASH]: page.currentHash,
    [MESSAGES.SERVER_TO_CLIENT.REPLAY_MESSAGE.SEQUENCE]: sequence,
    [MESSAGES.SERVER_TO_CLIENT.REPLAY_MESSAGE.CURRENT_PAGE_NR]: board.pageOrder.indexOf(pageUuid) + 1,
    [MESSAGES.SERVER_TO_CLIENT.REPLAY_MESSAGE.CURRENT_TOTAL_PAGES]: board.pageOrder.length
  };
  
  ws.send(JSON.stringify(replayMessage));
  logSentMessage(replayMessage.type, replayMessage, requestId);
};

// Handle mod action proposals
messageHandlers[MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.TYPE] = (ws, data, requestId) => {
  const boardId = data.boardId || ws.boardId;
  const pageUuid = data[MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.PAGE_UUID];
  const actionUuid = data[MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.ACTION_UUID];
  const payload = data[MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.PAYLOAD];
  const beforeHash = data[MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.BEFORE_HASH];
  
  // Verify board exists
  const board = boards[boardId];
  if (!board) {
    log(`[ERROR] Board not found: ${boardId}`);
    return sendDeclineMessage(ws, boardId, pageUuid, actionUuid, "Board not found");
  }
  
  // Route to specific handler based on action type
  const actionType = payload.type;
  if (modActionHandlers[actionType]) {
    modActionHandlers[actionType](ws, data, requestId);
  } else {
    log(`[ERROR] Unknown mod action type: ${actionType}`);
    sendDeclineMessage(ws, boardId, pageUuid, actionUuid, `Unknown action type: ${actionType}`);
  }
};

// Mod action handlers
const modActionHandlers = {};

// Handle draw actions
modActionHandlers[MOD_ACTIONS.DRAW.TYPE] = (ws, data, requestId) => {
  const boardId = data.boardId || ws.boardId;
  const pageUuid = data[MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.PAGE_UUID];
  const actionUuid = data[MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.ACTION_UUID];
  const payload = data[MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.PAYLOAD];
  const beforeHash = data[MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.BEFORE_HASH];
  
  // Ensure the page is loaded
  if (!ensurePageLoaded(boardId, pageUuid)) {
    return sendDeclineMessage(ws, boardId, pageUuid, actionUuid, "Page not found");
  }
  
  const page = boards[boardId].pages[pageUuid];
  
  // Calculate new hash
  const serverHash = page.currentHash;
  const afterHash = hashNext(serverHash, payload);
  
  // Create the mod action
  const modAction = {
    [MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.ACTION_UUID]: actionUuid,
    [MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.PAYLOAD]: payload,
    hashes: {
      [MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.BEFORE_HASH]: serverHash,
      [MESSAGES.SERVER_TO_CLIENT.ACCEPT_MESSAGE.AFTER_HASH]: afterHash
    }
  };
  
  // Add client ID if available
  if (ws.clientId) {
    modAction.clientId = ws.clientId;
  }
  
  // Update page state
  page.modActions.push(modAction);
  page.currentHash = afterHash;
  
  // Save to disk
  appendModActionToDisk(pageUuid, modAction);
  
  // Send accept message
  const acceptMessage = {
    type: MESSAGES.SERVER_TO_CLIENT.ACCEPT_MESSAGE.TYPE,
    boardId: boardId,
    [MESSAGES.SERVER_TO_CLIENT.ACCEPT_MESSAGE.PAGE_UUID]: pageUuid,
    [MESSAGES.SERVER_TO_CLIENT.ACCEPT_MESSAGE.ACTION_UUID]: actionUuid,
    [MESSAGES.SERVER_TO_CLIENT.ACCEPT_MESSAGE.BEFORE_HASH]: serverHash,
    [MESSAGES.SERVER_TO_CLIENT.ACCEPT_MESSAGE.AFTER_HASH]: afterHash,
    [MESSAGES.SERVER_TO_CLIENT.ACCEPT_MESSAGE.CURRENT_PAGE_NR]: boards[boardId].pageOrder.indexOf(pageUuid) + 1,
    [MESSAGES.SERVER_TO_CLIENT.ACCEPT_MESSAGE.CURRENT_TOTAL_PAGES]: boards[boardId].pageOrder.length
  };
  
  broadcastMessageToBoard(acceptMessage, boardId);
  logSentMessage(acceptMessage.type, acceptMessage, requestId);
};

// Handle erase actions
modActionHandlers[MOD_ACTIONS.ERASE.TYPE] = (ws, data, requestId) => {
  const boardId = data.boardId || ws.boardId;
  const pageUuid = data[MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.PAGE_UUID];
  const actionUuid = data[MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.ACTION_UUID];
  const payload = data[MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.PAYLOAD];
  const beforeHash = data[MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.BEFORE_HASH];
  
  // Ensure the page is loaded
  if (!ensurePageLoaded(boardId, pageUuid)) {
    return sendDeclineMessage(ws, boardId, pageUuid, actionUuid, "Page not found");
  }
  
  const page = boards[boardId].pages[pageUuid];
  
  // Verify the target stroke exists
  const targetActionUuid = payload[MOD_ACTIONS.ERASE.ACTION_UUID];
  const targetExists = page.modActions.some(action => 
    action[MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.ACTION_UUID] === targetActionUuid
  );
  
  if (!targetExists) {
    return sendDeclineMessage(ws, boardId, pageUuid, actionUuid, "Target stroke not found");
  }
  
  // Calculate new hash
  const serverHash = page.currentHash;
  const afterHash = hashNext(serverHash, payload);
  
  // Create the mod action
  const modAction = {
    [MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.ACTION_UUID]: actionUuid,
    [MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.PAYLOAD]: payload,
    hashes: {
      [MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.BEFORE_HASH]: serverHash,
      [MESSAGES.SERVER_TO_CLIENT.ACCEPT_MESSAGE.AFTER_HASH]: afterHash
    }
  };
  
  // Add client ID if available
  if (ws.clientId) {
    modAction.clientId = ws.clientId;
  }
  
  // Update page state
  page.modActions.push(modAction);
  page.currentHash = afterHash;
  
  // Save to disk
  appendModActionToDisk(pageUuid, modAction);
  
  // Send accept message
  const acceptMessage = {
    type: MESSAGES.SERVER_TO_CLIENT.ACCEPT_MESSAGE.TYPE,
    boardId: boardId,
    [MESSAGES.SERVER_TO_CLIENT.ACCEPT_MESSAGE.PAGE_UUID]: pageUuid,
    [MESSAGES.SERVER_TO_CLIENT.ACCEPT_MESSAGE.ACTION_UUID]: actionUuid,
    [MESSAGES.SERVER_TO_CLIENT.ACCEPT_MESSAGE.BEFORE_HASH]: serverHash,
    [MESSAGES.SERVER_TO_CLIENT.ACCEPT_MESSAGE.AFTER_HASH]: afterHash,
    [MESSAGES.SERVER_TO_CLIENT.ACCEPT_MESSAGE.CURRENT_PAGE_NR]: boards[boardId].pageOrder.indexOf(pageUuid) + 1,
    [MESSAGES.SERVER_TO_CLIENT.ACCEPT_MESSAGE.CURRENT_TOTAL_PAGES]: boards[boardId].pageOrder.length
  };
  
  broadcastMessageToBoard(acceptMessage, boardId);
  logSentMessage(acceptMessage.type, acceptMessage, requestId);
};

// Handle new page actions
modActionHandlers[MOD_ACTIONS.NEW_PAGE.TYPE] = (ws, data, requestId) => {
  const boardId = data.boardId || ws.boardId;
  const pageUuid = data[MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.PAGE_UUID];
  const actionUuid = data[MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.ACTION_UUID];
  
  const board = boards[boardId];
  if (!board) {
    return sendDeclineMessage(ws, boardId, pageUuid, actionUuid, "Board not found");
  }
  
  // Create a new page
  const newPageId = generateUuid();
  const newPage = {
    modActions: [],
    currentHash: hashAny([])
  };
  
  // Add the page to the board
  board.pages[newPageId] = newPage;
  
  // Insert the page after the current page
  const currentIndex = board.pageOrder.indexOf(pageUuid);
  if (currentIndex !== -1) {
    board.pageOrder.splice(currentIndex + 1, 0, newPageId);
  } else {
    // If current page not found, add to the end
    board.pageOrder.push(newPageId);
  }
  
  // Save the empty page and board metadata
  savePageToDisk(newPageId, []);
  saveBoardMetadata();
  
  // Calculate new hash for the action on the current page
  const currentPage = board.pages[pageUuid];
  const serverHash = currentPage.currentHash;
  const payload = data[MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.PAYLOAD];
  const afterHash = hashNext(serverHash, payload);
  
  // Create the mod action for the current page
  const modAction = {
    [MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.ACTION_UUID]: actionUuid,
    [MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.PAYLOAD]: {
      ...payload,
      newPageId: newPageId // Add the new page ID to the payload
    },
    hashes: {
      [MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.BEFORE_HASH]: serverHash,
      [MESSAGES.SERVER_TO_CLIENT.ACCEPT_MESSAGE.AFTER_HASH]: afterHash
    }
  };
  
  // Add client ID if available
  if (ws.clientId) {
    modAction.clientId = ws.clientId;
  }
  
  // Update current page state
  currentPage.modActions.push(modAction);
  currentPage.currentHash = afterHash;
  
  // Save to disk
  appendModActionToDisk(pageUuid, modAction);
  
  // Send accept message
  const acceptMessage = {
    type: MESSAGES.SERVER_TO_CLIENT.ACCEPT_MESSAGE.TYPE,
    boardId: boardId,
    [MESSAGES.SERVER_TO_CLIENT.ACCEPT_MESSAGE.PAGE_UUID]: pageUuid,
    [MESSAGES.SERVER_TO_CLIENT.ACCEPT_MESSAGE.ACTION_UUID]: actionUuid,
    [MESSAGES.SERVER_TO_CLIENT.ACCEPT_MESSAGE.BEFORE_HASH]: serverHash,
    [MESSAGES.SERVER_TO_CLIENT.ACCEPT_MESSAGE.AFTER_HASH]: afterHash,
    [MESSAGES.SERVER_TO_CLIENT.ACCEPT_MESSAGE.CURRENT_PAGE_NR]: board.pageOrder.indexOf(pageUuid) + 1,
    [MESSAGES.SERVER_TO_CLIENT.ACCEPT_MESSAGE.CURRENT_TOTAL_PAGES]: board.pageOrder.length
  };
  
  broadcastMessageToBoard(acceptMessage, boardId);
  logSentMessage(acceptMessage.type, acceptMessage, requestId);
};

// Handle delete page actions
modActionHandlers[MOD_ACTIONS.DELETE_PAGE.TYPE] = (ws, data, requestId) => {
  const boardId = data.boardId || ws.boardId;
  const pageUuid = data[MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.PAGE_UUID];
  const actionUuid = data[MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.ACTION_UUID];
  
  const board = boards[boardId];
  
  if (!board) {
    log(`[ERROR] Board not found: ${boardId}`);
    return sendDeclineMessage(ws, boardId, pageUuid, actionUuid, "Board not found");
  }
  
  if (board.pageOrder.length <= 1) {
    return sendDeclineMessage(ws, boardId, pageUuid, actionUuid, "Cannot delete the last page");
  }
  
  // Find the index of the page to delete
  const index = board.pageOrder.indexOf(pageUuid);
  
  // First remove the page from the order and memory
  board.pageOrder.splice(index, 1);
  delete board.pages[pageUuid];
  
  // Then select a replacement page
  const replacementPageId = board.pageOrder[Math.min(index, board.pageOrder.length - 1)];
  
  log(`[SERVER] replace page ${pageUuid} with ${replacementPageId} on board ${boardId}`);
  
  // Update deletion map
  deletionMap[pageUuid] = replacementPageId;
  
  // Mark for deletion
  markForDeletion(pageUuid, 'page', {
    boardId: boardId,
    deletedBy: ws.clientId || 'unknown',
    pagePosition: index,
    replacementId: replacementPageId
  });
  
  // Persist the updated board metadata
  saveBoardMetadata();
  
  // Calculate hash for the action
  const payload = data[MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.PAYLOAD];
  const serverHash = hashAny([]); // Deleted page, so no real hash
  const afterHash = hashNext(serverHash, payload);
  
  // Send accept message
  const acceptMessage = {
    type: MESSAGES.SERVER_TO_CLIENT.ACCEPT_MESSAGE.TYPE,
    boardId: boardId,
    [MESSAGES.SERVER_TO_CLIENT.ACCEPT_MESSAGE.PAGE_UUID]: pageUuid,
    [MESSAGES.SERVER_TO_CLIENT.ACCEPT_MESSAGE.ACTION_UUID]: actionUuid,
    [MESSAGES.SERVER_TO_CLIENT.ACCEPT_MESSAGE.BEFORE_HASH]: serverHash,
    [MESSAGES.SERVER_TO_CLIENT.ACCEPT_MESSAGE.AFTER_HASH]: afterHash,
    [MESSAGES.SERVER_TO_CLIENT.ACCEPT_MESSAGE.CURRENT_PAGE_NR]: 1, // Not relevant for deleted page
    [MESSAGES.SERVER_TO_CLIENT.ACCEPT_MESSAGE.CURRENT_TOTAL_PAGES]: board.pageOrder.length
  };
  
  broadcastMessageToBoard(acceptMessage, boardId);
  logSentMessage(acceptMessage.type, acceptMessage, requestId);
  
  // Update client to replacement page
  ws.pageId = replacementPageId;
  sendFullPage(ws, boardId, replacementPageId, requestId);
};

// Handle undo actions
modActionHandlers[MOD_ACTIONS.UNDO.TYPE] = (ws, data, requestId) => {
  const boardId = data.boardId || ws.boardId;
  const pageUuid = data[MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.PAGE_UUID];
  const actionUuid = data[MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.ACTION_UUID];
  const payload = data[MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.PAYLOAD];
  const targetActionUuid = payload[MOD_ACTIONS.UNDO.TARGET_ACTION_UUID];
  
  const board = boards[boardId];
  if (!board || !ensurePageLoaded(boardId, pageUuid)) {
    return sendDeclineMessage(ws, boardId, pageUuid, actionUuid, "Board or page not found");
  }
  
  const page = board.pages[pageUuid];
  
  // Find the target action
  const targetActionIndex = page.modActions.findIndex(action => 
    action[MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.ACTION_UUID] === targetActionUuid
  );
  
  if (targetActionIndex === -1) {
    // Target action not found - already undone or never existed
    return sendDeclineMessage(ws, boardId, pageUuid, actionUuid, "Target action not found");
  }
  
  // Check if the action can be undone
  if (isActionUndone(page.modActions, targetActionUuid)) {
    return sendDeclineMessage(ws, boardId, pageUuid, actionUuid, "Action already undone");
  }
  
  // Check if we're allowed to undo this action
  // Only check if clientId restrictions are in place
  if (payload[MOD_ACTIONS.UNDO.CLIENT_ID] && 
      page.modActions[targetActionIndex].clientId &&
      payload[MOD_ACTIONS.UNDO.CLIENT_ID] !== page.modActions[targetActionIndex].clientId) {
    return sendDeclineMessage(ws, boardId, pageUuid, actionUuid, "Cannot undo another user's action");
  }
  
  // Calculate new hash
  const serverHash = page.currentHash;
  const afterHash = hashNext(serverHash, payload);
  
  // Create the undo mod action
  const undoModAction = {
    [MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.ACTION_UUID]: actionUuid,
    [MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.PAYLOAD]: payload,
    hashes: {
      [MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.BEFORE_HASH]: serverHash,
      [MESSAGES.SERVER_TO_CLIENT.ACCEPT_MESSAGE.AFTER_HASH]: afterHash
    }
  };
  
  // Add client ID if available
  if (ws.clientId) {
    undoModAction.clientId = ws.clientId;
  }
  
  // Update page state
  page.modActions.push(undoModAction);
  page.currentHash = afterHash;
  
  // Save to disk
  appendModActionToDisk(pageUuid, undoModAction);
  
  // Send accept message
  const acceptMessage = {
    type: MESSAGES.SERVER_TO_CLIENT.ACCEPT_MESSAGE.TYPE,
    boardId: boardId,
    [MESSAGES.SERVER_TO_CLIENT.ACCEPT_MESSAGE.PAGE_UUID]: pageUuid,
    [MESSAGES.SERVER_TO_CLIENT.ACCEPT_MESSAGE.ACTION_UUID]: actionUuid,
    [MESSAGES.SERVER_TO_CLIENT.ACCEPT_MESSAGE.BEFORE_HASH]: serverHash,
    [MESSAGES.SERVER_TO_CLIENT.ACCEPT_MESSAGE.AFTER_HASH]: afterHash,
    [MESSAGES.SERVER_TO_CLIENT.ACCEPT_MESSAGE.CURRENT_PAGE_NR]: board.pageOrder.indexOf(pageUuid) + 1,
    [MESSAGES.SERVER_TO_CLIENT.ACCEPT_MESSAGE.CURRENT_TOTAL_PAGES]: board.pageOrder.length
  };
  
  broadcastMessageToBoard(acceptMessage, boardId);
  logSentMessage(acceptMessage.type, acceptMessage, requestId);
};

// Handle redo actions
modActionHandlers[MOD_ACTIONS.REDO.TYPE] = (ws, data, requestId) => {
  const boardId = data.boardId || ws.boardId;
  const pageUuid = data[MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.PAGE_UUID];
  const actionUuid = data[MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.ACTION_UUID];
  const payload = data[MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.PAYLOAD];
  const targetUndoActionUuid = payload[MOD_ACTIONS.REDO.TARGET_UNDO_ACTION_UUID];
  
  const board = boards[boardId];
  if (!board || !ensurePageLoaded(boardId, pageUuid)) {
    return sendDeclineMessage(ws, boardId, pageUuid, actionUuid, "Board or page not found");
  }
  
  const page = board.pages[pageUuid];
  
  // Find the undo action we want to undo (redo)
  const undoAction = page.modActions.find(action => 
    action[MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.ACTION_UUID] === targetUndoActionUuid &&
    isUndoAction(action)
  );
  
  if (!undoAction) {
    return sendDeclineMessage(ws, boardId, pageUuid, actionUuid, "Target undo action not found");
  }
  
  // Check if this undo action has already been undone (redone)
  if (isActionUndone(page.modActions, targetUndoActionUuid)) {
    return sendDeclineMessage(ws, boardId, pageUuid, actionUuid, "Action already redone");
  }
  
  // Check if we're allowed to redo this action
  if (payload[MOD_ACTIONS.REDO.CLIENT_ID] && 
      undoAction.clientId &&
      payload[MOD_ACTIONS.REDO.CLIENT_ID] !== undoAction.clientId) {
    return sendDeclineMessage(ws, boardId, pageUuid, actionUuid, "Cannot redo another user's undo");
  }
  
  // Calculate new hash
  const serverHash = page.currentHash;
  const afterHash = hashNext(serverHash, payload);
  
  // Create the redo mod action (which is an undo of an undo)
  const redoModAction = {
    [MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.ACTION_UUID]: actionUuid,
    [MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.PAYLOAD]: payload,
    hashes: {
      [MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.BEFORE_HASH]: serverHash,
      [MESSAGES.SERVER_TO_CLIENT.ACCEPT_MESSAGE.AFTER_HASH]: afterHash
    }
  };
  
  // Add client ID if available
  if (ws.clientId) {
    redoModAction.clientId = ws.clientId;
  }
  
  // Update page state
  page.modActions.push(redoModAction);
  page.currentHash = afterHash;
  
  // Save to disk
  appendModActionToDisk(pageUuid, redoModAction);
  
  // Send accept message
  const acceptMessage = {
    type: MESSAGES.SERVER_TO_CLIENT.ACCEPT_MESSAGE.TYPE,
    boardId: boardId,
    [MESSAGES.SERVER_TO_CLIENT.ACCEPT_MESSAGE.PAGE_UUID]: pageUuid,
    [MESSAGES.SERVER_TO_CLIENT.ACCEPT_MESSAGE.ACTION_UUID]: actionUuid,
    [MESSAGES.SERVER_TO_CLIENT.ACCEPT_MESSAGE.BEFORE_HASH]: serverHash,
    [MESSAGES.SERVER_TO_CLIENT.ACCEPT_MESSAGE.AFTER_HASH]: afterHash,
    [MESSAGES.SERVER_TO_CLIENT.ACCEPT_MESSAGE.CURRENT_PAGE_NR]: board.pageOrder.indexOf(pageUuid) + 1,
    [MESSAGES.SERVER_TO_CLIENT.ACCEPT_MESSAGE.CURRENT_TOTAL_PAGES]: board.pageOrder.length
  };
  
  broadcastMessageToBoard(acceptMessage, boardId);
  logSentMessage(acceptMessage.type, acceptMessage, requestId);
};

// Route incoming messages to their handlers
function routeMessage(ws, message) {
  try {
    const data = JSON.parse(message);
    const messageType = data.type;
    const requestId = data.requestId;
    
    logReceivedMessage(messageType, data, requestId);
    
    if (messageHandlers[messageType]) {
      messageHandlers[messageType](ws, data, requestId);
    } else {
      log(`[ERROR] Unknown message type: ${messageType}`);
    }
  } catch (error) {
    log(`[ERROR] Failed to process message: ${error.message}`);
  }
}

// WebSocket connection handling
wss.on('connection', (ws) => {
  log(`[SERVER] New client connected`);
  
  // Set up message handler
  ws.on('message', (message) => {
    routeMessage(ws, message);
  });
  
  // Handle disconnection
  ws.on('close', () => {
    log(`[SERVER] Client disconnected`);
    
    // Remove client from tracking if it had a clientId
    if (ws.clientId && clients[ws.clientId] === ws) {
      delete clients[ws.clientId];
    }
  });
  
  // Set up ping interval to keep connection alive
  const pingInterval = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      if (ws.boardId && ws.pageId) {
        // Get current board and page info
        const board = boards[ws.boardId];
        if (board && board.pages[ws.pageId]) {
          const page = board.pages[ws.pageId];
          const pageNr = board.pageOrder.indexOf(ws.pageId) + 1;
          
          // Send ping with current page info
          const pingMessage = {
            type: MESSAGES.SERVER_TO_CLIENT.PING.TYPE,
            boardId: ws.boardId,
            [MESSAGES.SERVER_TO_CLIENT.PING.PAGE_UUID]: ws.pageId,
            [MESSAGES.SERVER_TO_CLIENT.PING.HASH]: page.currentHash,
            [MESSAGES.SERVER_TO_CLIENT.PING.CURRENT_PAGE_NR]: pageNr,
            [MESSAGES.SERVER_TO_CLIENT.PING.CURRENT_TOTAL_PAGES]: board.pageOrder.length
          };
          
          ws.send(JSON.stringify(pingMessage));
        }
      }
    } else {
      clearInterval(pingInterval);
    }
  }, 30000); // Ping every 30 seconds
  
  // Clean up ping interval on disconnect
  ws.on('close', () => {
    clearInterval(pingInterval);
  });
});

// Start the server
server.listen(PORT, () => {
  log(`[SERVER] Server started on port ${PORT}`);
});

// Handle graceful shutdown
process.on('SIGTERM', () => {
  log('[SERVER] SIGTERM received. Shutting down gracefully...');
  
  // Save all board metadata
  saveBoardMetadata();
  
  // Close WebSocket server
  wss.close(() => {
    log('[SERVER] WebSocket server closed');
    
    // Close HTTP server
    server.close(() => {
      log('[SERVER] HTTP server closed');
      process.exit(0);
    });
  });
  
  // Force exit if not closed in 10 seconds
  setTimeout(() => {
    log('[SERVER] Forced shutdown after timeout');
    process.exit(1);
  }, 10000);
});

// Handle uncaught exceptions
process.on('uncaughtException', (err) => {
  log(`[SERVER] Uncaught exception: ${err.message}`);
  log(err.stack);
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  log(`[SERVER] Unhandled promise rejection: ${reason}`);
});
