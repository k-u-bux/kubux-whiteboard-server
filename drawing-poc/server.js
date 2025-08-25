const WebSocket = require('ws');
const fs = require('fs');
const http = require('http');
const path = require('path');
const url = require('url');

const { hashAny, hashNext, generateUuid, MESSAGES, MOD_ACTIONS, STROKE, POINT } = require('./shared');

// Data storage configuration
const DATA_DIR = './data';

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  console.log(`[SERVER] Created data directory: ${DATA_DIR}`);
}

// Path helpers
const getBoardsFilePath = () => path.join(DATA_DIR, 'boards.json');
const getRemovalLogPath = () => path.join(DATA_DIR, 'to_be_removed.json');
const getPageFilePath = (pageId) => path.join(DATA_DIR, `${pageId}.json`);

// Server state structures
const boards = {};
const deletionMap = {};
const clients = {}; // Map client IDs to WebSocket instances
let pingInterval;

// Initialize the server from persisted data
function initializeFromDisk() {
  try {
    const boardsFilePath = getBoardsFilePath();
    if (fs.existsSync(boardsFilePath)) {
      const boardsData = JSON.parse(fs.readFileSync(boardsFilePath, 'utf8'));
      
      // Load board structures without page content (loaded on demand)
      Object.keys(boardsData).forEach(boardId => {
        boards[boardId] = {
          pageOrder: boardsData[boardId].pageOrder || [],
          pages: {}
        };
      });
      
      console.log(`[SERVER] Loaded ${Object.keys(boards).length} boards from disk`);
    }
    
    // Load deletion map if it exists
    const removalLogPath = getRemovalLogPath();
    if (fs.existsSync(removalLogPath)) {
      const removalEntries = fs.readFileSync(removalLogPath, 'utf8')
        .split('\n')
        .filter(line => line.trim())
        .map(line => JSON.parse(line));
      
      removalEntries.forEach(entry => {
        if (entry.type === 'page' && entry.replacementId) {
          deletionMap[entry.uuid] = entry.replacementId;
        }
      });
      
      console.log(`[SERVER] Loaded ${Object.keys(deletionMap).length} deletion mappings`);
    }
  } catch (error) {
    console.error('[SERVER] Error initializing from disk:', error);
  }
}

// Save board metadata to disk
function saveBoardMetadata() {
  try {
    const boardsData = {};
    
    Object.keys(boards).forEach(boardId => {
      boardsData[boardId] = {
        pageOrder: boards[boardId].pageOrder
        // Add any other board metadata here
      };
    });
    
    fs.writeFileSync(getBoardsFilePath(), JSON.stringify(boardsData, null, 2), 'utf8');
  } catch (error) {
    console.error('[SERVER] Error saving board metadata:', error);
  }
}

// Mark an entity for deletion
function markForDeletion(uuid, type = 'page', metadata = {}) {
  try {
    const timestamp = new Date().toISOString();
    const entryData = {
      uuid,
      type,
      timestamp,
      ...metadata
    };
    
    const entryJson = JSON.stringify(entryData) + '\n';
    fs.appendFileSync(getRemovalLogPath(), entryJson, 'utf8');
    
    console.log(`[SERVER] Marked ${type} ${uuid} for deletion at ${timestamp}`);
  } catch (error) {
    console.error('[SERVER] Error marking for deletion:', error);
  }
}

// Load a page from disk
function loadPageFromDisk(pageId) {
  try {
    const pageFilePath = getPageFilePath(pageId);
    
    if (!fs.existsSync(pageFilePath)) {
      return { modActions: [], currentHash: hashAny([]) };
    }
    
    const modActionsJson = fs.readFileSync(pageFilePath, 'utf8');
    const modActions = JSON.parse(modActionsJson);
    
    // Calculate the current hash based on the loaded mod actions
    let currentHash = hashAny([]);
    for (const action of modActions) {
      if (action.hashes && action.hashes[MESSAGES.SERVER_TO_CLIENT.ACCEPT_MESSAGE.AFTER_HASH]) {
        currentHash = action.hashes[MESSAGES.SERVER_TO_CLIENT.ACCEPT_MESSAGE.AFTER_HASH];
      }
    }
    
    return { modActions, currentHash };
  } catch (error) {
    console.error(`[SERVER] Error loading page ${pageId} from disk:`, error);
    return { modActions: [], currentHash: hashAny([]) };
  }
}

// Save a page to disk
function savePageToDisk(pageId, modActions) {
  try {
    const pageFilePath = getPageFilePath(pageId);
    fs.writeFileSync(pageFilePath, JSON.stringify(modActions, null, 2), 'utf8');
  } catch (error) {
    console.error(`[SERVER] Error saving page ${pageId} to disk:`, error);
  }
}

// Append a modification action to a page file
function appendModActionToDisk(pageId, modAction) {
  try {
    const pageFilePath = getPageFilePath(pageId);
    
    // If the file doesn't exist yet, initialize it with an array
    if (!fs.existsSync(pageFilePath)) {
      fs.writeFileSync(pageFilePath, JSON.stringify([modAction], null, 2), 'utf8');
      return;
    }
    
    // Load existing actions, append the new one, and save
    const modActionsJson = fs.readFileSync(pageFilePath, 'utf8');
    const modActions = JSON.parse(modActionsJson);
    modActions.push(modAction);
    fs.writeFileSync(pageFilePath, JSON.stringify(modActions, null, 2), 'utf8');
  } catch (error) {
    console.error(`[SERVER] Error appending mod action to page ${pageId}:`, error);
  }
}

function getOrCreateBoard(boardId) {
  if (!boards[boardId]) {
    const initialPageId = generateUuid();
    const initialHash = hashAny([]); // Empty state hash
    
    boards[boardId] = {
      pageOrder: [initialPageId],
      pages: { [initialPageId]: { modActions: [], currentHash: initialHash } }
    };
    
    // Save the new page and board metadata
    savePageToDisk(initialPageId, []);
    saveBoardMetadata();
    
    console.log(`[SERVER] Created new board: ${boardId} with initial page: ${initialPageId}`);
  }
  return boards[boardId];
}

// Ensure a page is loaded in memory
function ensurePageLoaded(boardId, pageId) {
  const board = boards[boardId];
  if (!board) return false;
  
  if (!board.pages[pageId]) {
    // Load the page from disk
    board.pages[pageId] = loadPageFromDisk(pageId);
  }
  
  return true;
}

const wss = new WebSocket.Server({ 
  port: 3001, 
  path: '/ws',
  perMessageDeflate: {
    zlibDeflateOptions: { level: 6 },
    zlibInflateOptions: { chunkSize: 16 * 1024 },
    serverNoContextTakeover: false,
    clientNoContextTakeover: false,
    threshold: 512
  }
});

const httpServer = http.createServer((req, res) => {
  const requestUrl = url.parse(req.url);
  const pathname = requestUrl.pathname;

  let filePath;
  let contentType = 'application/octet-stream';

  if (pathname === '/' || path.extname(pathname) === '') {
    filePath = path.join(__dirname, 'index.html');
    contentType = 'text/html';
  } else {
    filePath = path.join(__dirname, pathname);
    const extname = String(path.extname(filePath)).toLowerCase();
    const mimeTypes = {
      '.html': 'text/html',
      '.js': 'application/javascript',
      '.css': 'text/css',
      '.json': 'application/json',
      '.png': 'image/png',
      '.jpg': 'image/jpg',
      '.gif': 'image/gif',
      '.svg': 'image/svg+xml',
      '.wav': 'audio/wav',
      '.mp4': 'video/mp4',
      '.woff': 'application/font-woff',
      '.ttf': 'application/font-ttf',
      '.eot': 'application/vnd.ms-fontobject',
      '.otf': 'application/font-otf',
      '.wasm': 'application/wasm'
    };
    contentType = mimeTypes[extname] || contentType;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      if (err.code === 'ENOENT') {
        res.writeHead(404, { 'Content-Type': 'text/html' });
        res.end('<h1>404 Not Found</h1><p>The requested URL was not found on this server.</p>');
      } else {
        res.writeHead(500);
        res.end('Sorry, check with the site admin for the error: ' + err.code + ' ..\n');
      }
      return;
    }

    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
});

httpServer.listen(8080, '0.0.0.0', () => {
  console.log('[SERVER] HTTP server is running on port 8080');
  
  // Initialize server from disk
  initializeFromDisk();
});

function logSentMessage(type, payload, requestId = 'N/A') {
  console.log(`[SERVER > CLIENT] Sending message of type '${type}' in response to '${requestId}' with payload:`, payload);
}

function broadcastMessageToBoard(message, boardId, excludeWs = null) {
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN && client.boardId === boardId && client !== excludeWs) {
      client.send(JSON.stringify(message));
    }
  });
}

function sendFullPage(ws, boardId, pageId, requestId) {
  let finalPageId = pageId;
  while (deletionMap[finalPageId] && !boards[boardId].pages[finalPageId]) {
    finalPageId = deletionMap[finalPageId];
  }
  
  const currentBoard = boards[boardId];
  if (!currentBoard) {
    console.error(`[SERVER] Board not found: ${boardId}`);
    return;
  }
  
  // Ensure the page is loaded in memory
  if (!ensurePageLoaded(boardId, finalPageId)) {
    console.error(`[SERVER] Page not found: ${finalPageId} on board: ${boardId}`);
    return;
  }
  
  ws.boardId = boardId;
  ws.pageId = finalPageId;
  
  const pageState = currentBoard.pages[finalPageId].modActions;
  const pageHash = currentBoard.pages[finalPageId].currentHash;
  const pageNr = currentBoard.pageOrder.indexOf(finalPageId) + 1;
  const totalPages = currentBoard.pageOrder.length;
  
  const message = {
    type: MESSAGES.SERVER_TO_CLIENT.FULL_PAGE.TYPE,
    [MESSAGES.SERVER_TO_CLIENT.FULL_PAGE.PAGE]: finalPageId,
    [MESSAGES.SERVER_TO_CLIENT.FULL_PAGE.STATE]: pageState,
    [MESSAGES.SERVER_TO_CLIENT.FULL_PAGE.HASH]: pageHash,
    [MESSAGES.SERVER_TO_CLIENT.FULL_PAGE.PAGE_NR]: pageNr,
    [MESSAGES.SERVER_TO_CLIENT.FULL_PAGE.TOTAL_PAGES]: totalPages
  };
  ws.send(JSON.stringify(message));
  logSentMessage(message.type, message, requestId);
}

function sendPing() {
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN && client.boardId && client.pageId) {
      const currentBoard = boards[client.boardId];
      if (!currentBoard) return;
      
      const pageId = client.pageId;
      
      // Ensure the page is loaded
      if (!ensurePageLoaded(client.boardId, pageId)) return;
      
      const page = currentBoard.pages[pageId];
      if (!page) return;
      
      const pageHash = page.currentHash;
      const pageNr = currentBoard.pageOrder.indexOf(pageId) + 1;
      const totalPages = currentBoard.pageOrder.length;
      
      const message = {
        type: MESSAGES.SERVER_TO_CLIENT.PING.TYPE,
        [MESSAGES.SERVER_TO_CLIENT.PING.PAGE_UUID]: pageId,
        [MESSAGES.SERVER_TO_CLIENT.PING.HASH]: pageHash,
        [MESSAGES.SERVER_TO_CLIENT.PING.CURRENT_PAGE_NR]: pageNr,
        [MESSAGES.SERVER_TO_CLIENT.PING.CURRENT_TOTAL_PAGES]: totalPages
      };
      client.send(JSON.stringify(message));
      logSentMessage(message.type, message, 'N/A');
    }
  });
}

const messageHandlers = {};

// New handler for board registration
messageHandlers[MESSAGES.CLIENT_TO_SERVER.REGISTER_BOARD.TYPE] = (ws, data, requestId) => {
  const clientId = data[MESSAGES.CLIENT_TO_SERVER.REGISTER_BOARD.CLIENT_ID];
  let boardId = data[MESSAGES.CLIENT_TO_SERVER.REGISTER_BOARD.BOARD_ID];
  
  // If no board ID provided, generate one
  if (!boardId) {
    boardId = generateUuid();
  }
  
  const board = getOrCreateBoard(boardId);
  ws.boardId = boardId; // Store boardId in WebSocket client
  ws.clientId = clientId; // Optional: store client ID for tracking
  ws.pageId = board.pageOrder[0]; // Default to first page
  
  // Store client reference by ID if provided
  if (clientId) {
    clients[clientId] = ws;
  }
  
  console.log(`[SERVER] Client ${clientId} registered with board: ${boardId}`);
  
  // Send board registration acknowledgment
  const registrationResponse = {
    type: MESSAGES.SERVER_TO_CLIENT.BOARD_REGISTERED.TYPE,
    [MESSAGES.SERVER_TO_CLIENT.BOARD_REGISTERED.BOARD_ID]: boardId,
    [MESSAGES.SERVER_TO_CLIENT.BOARD_REGISTERED.INITIAL_PAGE_ID]: ws.pageId,
    [MESSAGES.SERVER_TO_CLIENT.BOARD_REGISTERED.TOTAL_PAGES]: board.pageOrder.length,
    [MESSAGES.SERVER_TO_CLIENT.BOARD_REGISTERED.REQUEST_ID]: requestId
  };
  ws.send(JSON.stringify(registrationResponse));
  
  // Follow up with a full page message for the initial page
  sendFullPage(ws, boardId, ws.pageId, requestId);
};

function routeMessage(ws, message) {
  try {
    const data = JSON.parse(message);
    const requestId = data.requestId || data['action-uuid'] || 'N/A';
    
    // Extract boardId from message or use stored one
    const boardId = data.boardId || ws.boardId;
    
    // If the message includes a boardId, update the WebSocket client
    if (data.boardId && data.boardId !== ws.boardId) {
      ws.boardId = data.boardId;
    }
    
    console.log(`[CLIENT > SERVER] Received message of type '${data.type}' with requestId '${requestId}' from client on board '${boardId}':`, data);
    
    const handler = messageHandlers[data.type];
    if (handler) {
      handler(ws, data, requestId);
    } else {
      console.warn(`[SERVER] Unhandled message type: ${data.type}`);
    }
  } catch (e) {
    console.error('[SERVER] Invalid message received:', message, e);
  }
}

messageHandlers[MESSAGES.CLIENT_TO_SERVER.FULL_PAGE_REQUESTS.TYPE] = (ws, data, requestId) => {
  const boardId = data.boardId || ws.boardId;
  const board = boards[boardId];
  if (!board) return;

  let pageId;
  if (data[MESSAGES.CLIENT_TO_SERVER.FULL_PAGE_REQUESTS.PAGE_NUMBER]) {
    const pageNumber = data[MESSAGES.CLIENT_TO_SERVER.FULL_PAGE_REQUESTS.PAGE_NUMBER];
    pageId = board.pageOrder[pageNumber - 1];
  } else if (data[MESSAGES.CLIENT_TO_SERVER.FULL_PAGE_REQUESTS.PAGE_ID] && 
             data[MESSAGES.CLIENT_TO_SERVER.FULL_PAGE_REQUESTS.DELTA] !== undefined) {
    const index = board.pageOrder.indexOf(data[MESSAGES.CLIENT_TO_SERVER.FULL_PAGE_REQUESTS.PAGE_ID]);
    if (index !== -1) {
      const newIndex = index + data[MESSAGES.CLIENT_TO_SERVER.FULL_PAGE_REQUESTS.DELTA];
      if (newIndex >= 0 && newIndex < board.pageOrder.length) {
        pageId = board.pageOrder[newIndex];
      }
    }
  }
  
  if (pageId) {
    ws.pageId = pageId;
    sendFullPage(ws, boardId, pageId, requestId);
  }
};

const modActionHandlers = {};

modActionHandlers[MOD_ACTIONS.DRAW.TYPE] = (ws, data, requestId) => {
  const boardId = data.boardId || ws.boardId;
  const pageUuid = data[MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.PAGE_UUID];
  const payload = data[MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.PAYLOAD];
  const beforeHash = data[MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.BEFORE_HASH];
  const actionUuid = data[MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.ACTION_UUID];
  const board = boards[boardId];
  
  // Ensure the board exists
  if (!board) {
    console.error(`[SERVER] Board not found: ${boardId}`);
    return;
  }
  
  // Ensure the page is loaded
  if (!ensurePageLoaded(boardId, pageUuid)) {
    sendFullPage(ws, boardId, pageUuid, requestId);
    return;
  }
  
  const currentPage = board.pages[pageUuid];
  const serverHash = currentPage.currentHash;

  // Calculate new hash by adding this action to the current state
  const afterHash = hashNext(serverHash, payload);
  
  const modAction = {
    [MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.ACTION_UUID]: actionUuid,
    [MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.PAYLOAD]: payload,
    hashes: {
      [MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.BEFORE_HASH]: serverHash,
      [MESSAGES.SERVER_TO_CLIENT.ACCEPT_MESSAGE.AFTER_HASH]: afterHash
    }
  };
  
  // Add to in-memory representation
  currentPage.modActions.push(modAction);
  currentPage.currentHash = afterHash;
  
  // Persist to disk
  appendModActionToDisk(pageUuid, modAction);
  
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

modActionHandlers[MOD_ACTIONS.ERASE.TYPE] = (ws, data, requestId) => {
  const boardId = data.boardId || ws.boardId;
  const pageUuid = data[MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.PAGE_UUID];
  const payload = data[MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.PAYLOAD];
  const beforeHash = data[MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.BEFORE_HASH];
  const actionUuid = data[MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.ACTION_UUID];
  const board = boards[boardId];
  
  // Ensure the board exists
  if (!board) {
    console.error(`[SERVER] Board not found: ${boardId}`);
    return;
  }
  
  // Ensure the page is loaded
  if (!ensurePageLoaded(boardId, pageUuid)) {
    sendFullPage(ws, boardId, pageUuid, requestId);
    return;
  }
  
  const currentPage = board.pages[pageUuid];
  const serverHash = currentPage.currentHash;
  
  // Check if the stroke to be erased exists
  const erasedStrokeActionUuid = payload[MOD_ACTIONS.ERASE.ACTION_UUID];
  const strokeExists = currentPage.modActions.some(action => 
    action[MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.ACTION_UUID] === erasedStrokeActionUuid
  );
  
  if (!strokeExists) {
    // The stroke doesn't exist or was already erased
    const declineMessage = {
      type: MESSAGES.SERVER_TO_CLIENT.DECLINE_MESSAGE.TYPE,
      boardId: boardId,
      [MESSAGES.SERVER_TO_CLIENT.DECLINE_MESSAGE.PAGE_UUID]: pageUuid,
      [MESSAGES.SERVER_TO_CLIENT.DECLINE_MESSAGE.ACTION_UUID]: actionUuid,
    };
    ws.send(JSON.stringify(declineMessage));
    logSentMessage(declineMessage.type, declineMessage, requestId);
    return;
  }
  
  // Remove the stroke from in-memory representation
  const newModActions = currentPage.modActions.filter(action => 
    action[MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.ACTION_UUID] !== erasedStrokeActionUuid
  );
  
  // Calculate new hash
  const afterHash = hashNext(serverHash, payload);
  
  // Update in-memory state
  currentPage.modActions = newModActions;
  currentPage.currentHash = afterHash;
  
  // For erase operations, we rewrite the entire page file since we're removing an action
  savePageToDisk(pageUuid, newModActions);
  
  // Create an erase mod action
  const eraseModAction = {
    [MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.ACTION_UUID]: actionUuid,
    [MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.PAYLOAD]: payload,
    hashes: {
      [MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.BEFORE_HASH]: serverHash,
      [MESSAGES.SERVER_TO_CLIENT.ACCEPT_MESSAGE.AFTER_HASH]: afterHash
    }
  };
  
  // We don't append this to disk since we've already rewritten the file
  
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

modActionHandlers[MOD_ACTIONS.NEW_PAGE.TYPE] = (ws, data, requestId) => {
  const boardId = data.boardId || ws.boardId;
  const pageUuid = data[MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.PAGE_UUID];
  const actionUuid = data[MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.ACTION_UUID];
  const board = boards[boardId];
  
  if (!board) {
    console.error(`[SERVER] Board not found: ${boardId}`);
    return;
  }
  
  // Ensure current page is loaded
  ensurePageLoaded(boardId, pageUuid);
  
  const newPageId = generateUuid();
  const initialHash = hashAny([]);
  
  const index = board.pageOrder.indexOf(pageUuid);
  board.pageOrder.splice(index + 1, 0, newPageId);
  board.pages[newPageId] = { 
    modActions: [], 
    currentHash: initialHash 
  };
  
  // Persist the new page and updated board metadata
  savePageToDisk(newPageId, []);
  saveBoardMetadata();
  
  ws.pageId = newPageId;
  sendFullPage(ws, boardId, newPageId, requestId);
};

modActionHandlers[MOD_ACTIONS.DELETE_PAGE.TYPE] = (ws, data, requestId) => {
  const boardId = data.boardId || ws.boardId;
  const pageUuid = data[MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.PAGE_UUID];
  const actionUuid = data[MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.ACTION_UUID];
  const board = boards[boardId];
  
  if (!board) {
    console.error(`[SERVER] Board not found: ${boardId}`);
    return;
  }
  
  if (board.pageOrder.length <= 1) {
    const declineMessage = {
      type: MESSAGES.SERVER_TO_CLIENT.DECLINE_MESSAGE.TYPE,
      boardId: boardId,
      [MESSAGES.SERVER_TO_CLIENT.DECLINE_MESSAGE.PAGE_UUID]: pageUuid,
      [MESSAGES.SERVER_TO_CLIENT.DECLINE_MESSAGE.ACTION_UUID]: actionUuid
    };
    ws.send(JSON.stringify(declineMessage));
    logSentMessage(declineMessage.type, declineMessage, requestId);
    return;
  }
  
  const index = board.pageOrder.indexOf(pageUuid);
  board.pageOrder.splice(index, 1);
  delete board.pages[pageUuid];
  const replacementPageId = board.pageOrder[Math.min(index, board.pageOrder.length - 1)];

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
  
  // We don't delete the file - it will be handled by the garbage collector
  
  // Update client to replacement page
  ws.pageId = replacementPageId;
  sendFullPage(ws, boardId, replacementPageId, requestId);
};

messageHandlers[MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.TYPE] = (ws, data, requestId) => {
  const handler = modActionHandlers[data[MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.PAYLOAD].type];
  if (handler) {
    handler(ws, data, requestId);
  }
};

messageHandlers[MESSAGES.CLIENT_TO_SERVER.REPLAY_REQUESTS.TYPE] = (ws, data, requestId) => {
  const boardId = data.boardId || ws.boardId;
  const pageUuid = data[MESSAGES.CLIENT_TO_SERVER.REPLAY_REQUESTS.PAGE_UUID];
  const beforeHash = data[MESSAGES.CLIENT_TO_SERVER.REPLAY_REQUESTS.BEFORE_HASH];
  
  const board = boards[boardId];
  if (!board) {
    console.error(`[SERVER] Board not found: ${boardId}`);
    return;
  }
  
  // Ensure the page is loaded
  if (!ensurePageLoaded(boardId, pageUuid)) {
    sendFullPage(ws, boardId, ws.pageId, requestId);
    return;
  }
  
  const page = board.pages[pageUuid];
  
  const replayActions = [];
  let found = false;
  let finalHash = beforeHash;

  for (const action of page.modActions) {
    if (action.hashes[MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.BEFORE_HASH] === beforeHash) {
      found = true;
    }
    if (found) {
      replayActions.push(action);
      finalHash = action.hashes[MESSAGES.SERVER_TO_CLIENT.ACCEPT_MESSAGE.AFTER_HASH];
    }
  }
  
  const replayMessage = {
    type: MESSAGES.SERVER_TO_CLIENT.REPLAY_MESSAGE.TYPE,
    boardId: boardId,
    [MESSAGES.SERVER_TO_CLIENT.REPLAY_MESSAGE.PAGE_UUID]: pageUuid,
    [MESSAGES.SERVER_TO_CLIENT.REPLAY_MESSAGE.BEFORE_HASH]: beforeHash,
    [MESSAGES.SERVER_TO_CLIENT.REPLAY_MESSAGE.AFTER_HASH]: finalHash,
    [MESSAGES.SERVER_TO_CLIENT.REPLAY_MESSAGE.SEQUENCE]: replayActions,
    [MESSAGES.SERVER_TO_CLIENT.REPLAY_MESSAGE.CURRENT_PAGE_NR]: board.pageOrder.indexOf(pageUuid) + 1,
    [MESSAGES.SERVER_TO_CLIENT.REPLAY_MESSAGE.CURRENT_TOTAL_PAGES]: board.pageOrder.length
  };
  ws.send(JSON.stringify(replayMessage));
  logSentMessage(replayMessage.type, replayMessage, requestId);
};

// Add these handlers to the modActionHandlers object in server.js

// Handle undo actions
modActionHandlers[MOD_ACTIONS.UNDO.TYPE] = (ws, data, requestId) => {
  const boardId = data.boardId || ws.boardId;
  const pageUuid = data[MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.PAGE_UUID];
  const actionUuid = data[MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.ACTION_UUID];
  const payload = data[MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.PAYLOAD];
  const targetActionUuid = payload[MOD_ACTIONS.UNDO.TARGET_ACTION_UUID];
  const clientId = payload[MOD_ACTIONS.UNDO.CLIENT_ID];
  
  // Ensure the board exists
  const board = boards[boardId];
  if (!board) {
    console.error(`[SERVER] Board not found: ${boardId}`);
    const declineMessage = {
      type: MESSAGES.SERVER_TO_CLIENT.DECLINE_MESSAGE.TYPE,
      boardId: boardId,
      [MESSAGES.SERVER_TO_CLIENT.DECLINE_MESSAGE.PAGE_UUID]: pageUuid,
      [MESSAGES.SERVER_TO_CLIENT.DECLINE_MESSAGE.ACTION_UUID]: actionUuid,
      [MESSAGES.SERVER_TO_CLIENT.DECLINE_MESSAGE.REASON]: "Board not found"
    };
    ws.send(JSON.stringify(declineMessage));
    return;
  }
  
  // Ensure the page is loaded
  if (!ensurePageLoaded(boardId, pageUuid)) {
    console.error(`[SERVER] Page not found: ${pageUuid}`);
    const declineMessage = {
      type: MESSAGES.SERVER_TO_CLIENT.DECLINE_MESSAGE.TYPE,
      boardId: boardId,
      [MESSAGES.SERVER_TO_CLIENT.DECLINE_MESSAGE.PAGE_UUID]: pageUuid,
      [MESSAGES.SERVER_TO_CLIENT.DECLINE_MESSAGE.ACTION_UUID]: actionUuid,
      [MESSAGES.SERVER_TO_CLIENT.DECLINE_MESSAGE.REASON]: "Page not found"
    };
    ws.send(JSON.stringify(declineMessage));
    return;
  }
  
  const page = board.pages[pageUuid];
  
  // Find the target action to undo
  const targetAction = page.modActions.find(action => 
    action[MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.ACTION_UUID] === targetActionUuid
  );
  
  if (!targetAction) {
    console.error(`[SERVER] Target action not found: ${targetActionUuid}`);
    const declineMessage = {
      type: MESSAGES.SERVER_TO_CLIENT.DECLINE_MESSAGE.TYPE,
      boardId: boardId,
      [MESSAGES.SERVER_TO_CLIENT.DECLINE_MESSAGE.PAGE_UUID]: pageUuid,
      [MESSAGES.SERVER_TO_CLIENT.DECLINE_MESSAGE.ACTION_UUID]: actionUuid,
      [MESSAGES.SERVER_TO_CLIENT.DECLINE_MESSAGE.REASON]: "Target action not found"
    };
    ws.send(JSON.stringify(declineMessage));
    return;
  }
  
  // Check if this action has already been undone
  const alreadyUndone = page.modActions.some(action => {
    const actionPayload = action[MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.PAYLOAD];
    return actionPayload && 
           actionPayload.type === MOD_ACTIONS.UNDO.TYPE && 
           actionPayload[MOD_ACTIONS.UNDO.TARGET_ACTION_UUID] === targetActionUuid;
  });
  
  if (alreadyUndone) {
    console.error(`[SERVER] Action already undone: ${targetActionUuid}`);
    const declineMessage = {
      type: MESSAGES.SERVER_TO_CLIENT.DECLINE_MESSAGE.TYPE,
      boardId: boardId,
      [MESSAGES.SERVER_TO_CLIENT.DECLINE_MESSAGE.PAGE_UUID]: pageUuid,
      [MESSAGES.SERVER_TO_CLIENT.DECLINE_MESSAGE.ACTION_UUID]: actionUuid,
      [MESSAGES.SERVER_TO_CLIENT.DECLINE_MESSAGE.REASON]: "Action already undone"
    };
    ws.send(JSON.stringify(declineMessage));
    return;
  }
  
  // Optional: Check if the client is allowed to undo this action
  // For example, you might only allow clients to undo their own actions
  if (targetAction.clientId && clientId && targetAction.clientId !== clientId) {
    console.error(`[SERVER] Client ${clientId} not allowed to undo action by client ${targetAction.clientId}`);
    const declineMessage = {
      type: MESSAGES.SERVER_TO_CLIENT.DECLINE_MESSAGE.TYPE,
      boardId: boardId,
      [MESSAGES.SERVER_TO_CLIENT.DECLINE_MESSAGE.PAGE_UUID]: pageUuid,
      [MESSAGES.SERVER_TO_CLIENT.DECLINE_MESSAGE.ACTION_UUID]: actionUuid,
      [MESSAGES.SERVER_TO_CLIENT.DECLINE_MESSAGE.REASON]: "Not allowed to undo another client's action"
    };
    ws.send(JSON.stringify(declineMessage));
    return;
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
    },
    clientId: clientId // Store client ID for tracking
  };
  
  // Update page state
  page.modActions.push(modAction);
  page.currentHash = afterHash;
  
  // Persist to disk
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

// Handle redo actions
modActionHandlers[MOD_ACTIONS.REDO.TYPE] = (ws, data, requestId) => {
  const boardId = data.boardId || ws.boardId;
  const pageUuid = data[MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.PAGE_UUID];
  const actionUuid = data[MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.ACTION_UUID];
  const payload = data[MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.PAYLOAD];
  const targetUndoActionUuid = payload[MOD_ACTIONS.REDO.TARGET_UNDO_ACTION_UUID];
  const clientId = payload[MOD_ACTIONS.REDO.CLIENT_ID];
  
  // Ensure the board exists
  const board = boards[boardId];
  if (!board) {
    console.error(`[SERVER] Board not found: ${boardId}`);
    const declineMessage = {
      type: MESSAGES.SERVER_TO_CLIENT.DECLINE_MESSAGE.TYPE,
      boardId: boardId,
      [MESSAGES.SERVER_TO_CLIENT.DECLINE_MESSAGE.PAGE_UUID]: pageUuid,
      [MESSAGES.SERVER_TO_CLIENT.DECLINE_MESSAGE.ACTION_UUID]: actionUuid,
      [MESSAGES.SERVER_TO_CLIENT.DECLINE_MESSAGE.REASON]: "Board not found"
    };
    ws.send(JSON.stringify(declineMessage));
    return;
  }
  
  // Ensure the page is loaded
  if (!ensurePageLoaded(boardId, pageUuid)) {
    console.error(`[SERVER] Page not found: ${pageUuid}`);
    const declineMessage = {
      type: MESSAGES.SERVER_TO_CLIENT.DECLINE_MESSAGE.TYPE,
      boardId: boardId,
      [MESSAGES.SERVER_TO_CLIENT.DECLINE_MESSAGE.PAGE_UUID]: pageUuid,
      [MESSAGES.SERVER_TO_CLIENT.DECLINE_MESSAGE.ACTION_UUID]: actionUuid,
      [MESSAGES.SERVER_TO_CLIENT.DECLINE_MESSAGE.REASON]: "Page not found"
    };
    ws.send(JSON.stringify(declineMessage));
    return;
  }
  
  const page = board.pages[pageUuid];
  
  // Find the undo action to redo
  const undoAction = page.modActions.find(action => 
    action[MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.ACTION_UUID] === targetUndoActionUuid &&
    action[MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.PAYLOAD]?.type === MOD_ACTIONS.UNDO.TYPE
  );
  
  if (!undoAction) {
    console.error(`[SERVER] Target undo action not found: ${targetUndoActionUuid}`);
    const declineMessage = {
      type: MESSAGES.SERVER_TO_CLIENT.DECLINE_MESSAGE.TYPE,
      boardId: boardId,
      [MESSAGES.SERVER_TO_CLIENT.DECLINE_MESSAGE.PAGE_UUID]: pageUuid,
      [MESSAGES.SERVER_TO_CLIENT.DECLINE_MESSAGE.ACTION_UUID]: actionUuid,
      [MESSAGES.SERVER_TO_CLIENT.DECLINE_MESSAGE.REASON]: "Target undo action not found"
    };
    ws.send(JSON.stringify(declineMessage));
    return;
  }
  
  // Check if this undo action has already been redone
  const alreadyRedone = page.modActions.some(action => {
    const actionPayload = action[MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.PAYLOAD];
    return actionPayload && 
           actionPayload.type === MOD_ACTIONS.REDO.TYPE && 
           actionPayload[MOD_ACTIONS.REDO.TARGET_UNDO_ACTION_UUID] === targetUndoActionUuid;
  });
  
  if (alreadyRedone) {
    console.error(`[SERVER] Action already redone: ${targetUndoActionUuid}`);
    const declineMessage = {
      type: MESSAGES.SERVER_TO_CLIENT.DECLINE_MESSAGE.TYPE,
      boardId: boardId,
      [MESSAGES.SERVER_TO_CLIENT.DECLINE_MESSAGE.PAGE_UUID]: pageUuid,
      [MESSAGES.SERVER_TO_CLIENT.DECLINE_MESSAGE.ACTION_UUID]: actionUuid,
      [MESSAGES.SERVER_TO_CLIENT.DECLINE_MESSAGE.REASON]: "Action already redone"
    };
    ws.send(JSON.stringify(declineMessage));
    return;
  }
  
  // Optional: Check if the client is allowed to redo this action
  // For example, you might only allow clients to redo their own undos
  if (undoAction.clientId && clientId && undoAction.clientId !== clientId) {
    console.error(`[SERVER] Client ${clientId} not allowed to redo undo by client ${undoAction.clientId}`);
    const declineMessage = {
      type: MESSAGES.SERVER_TO_CLIENT.DECLINE_MESSAGE.TYPE,
      boardId: boardId,
      [MESSAGES.SERVER_TO_CLIENT.DECLINE_MESSAGE.PAGE_UUID]: pageUuid,
      [MESSAGES.SERVER_TO_CLIENT.DECLINE_MESSAGE.ACTION_UUID]: actionUuid,
      [MESSAGES.SERVER_TO_CLIENT.DECLINE_MESSAGE.REASON]: "Not allowed to redo another client's undo"
    };
    ws.send(JSON.stringify(declineMessage));
    return;
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
    },
    clientId: clientId // Store client ID for tracking
  };
  
  // Update page state
  page.modActions.push(modAction);
  page.currentHash = afterHash;
  
  // Persist to disk
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


wss.on('connection', (ws, req) => {
  console.log(`[SERVER] New WebSocket connection established`);
  
  // We don't set boardId here anymore - client will send it in registration message
  
  if (!pingInterval) {
    pingInterval = setInterval(() => {
        sendPing();
    }, 5000);
  }

  ws.on('message', message => routeMessage(ws, message));
  
  ws.on('close', () => {
    console.log(`[SERVER] Client disconnected from board: ${ws.boardId || 'unknown'}`);
    
    // Clean up client reference if client ID was stored
    if (ws.clientId && clients[ws.clientId] === ws) {
      delete clients[ws.clientId];
    }
  });
});

process.on('SIGINT', () => {
  console.log('[SERVER] Shutting down gracefully...');
  // Make sure all data is persisted before exit
  saveBoardMetadata();
  process.exit(0);
});
