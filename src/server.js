const WebSocket = require('ws');
const fs = require('fs');
const http = require('http');
const path = require('path');
const url = require('url');

const { 
  hashAny, 
  hashNext, 
  generateUuid, 
  MESSAGES, 
  MOD_ACTIONS, 
  STROKE, 
  POINT,
  createEmptyVisualState,
  compileVisualState,
  applyModAction
} = require('./shared');

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

/**
 * Resolves a potentially deleted page to its current valid replacement.
 * Follows the deletion chain until it finds a page that hasn't been deleted.
 * 
 * @param {string} pageId - The original page UUID to check
 * @param {Object} boardId - The board ID (to check page existence)
 * @returns {string} - A valid page UUID (either the original or its replacement)
 */
function existingPage(pageId, boardId) {
  // First check if the page exists directly (fast path)
  if (boards[boardId] && boards[boardId].pages[pageId]) {
    return pageId;
  }
  
  // Follow the deletion chain
  let currentId = pageId;
  let replacementId = deletionMap[currentId];
  
  while (replacementId) {
    currentId = replacementId;
    replacementId = deletionMap[currentId];
    
    // Guard against circular references
    if (replacementId === pageId) {
      console.error(`Circular reference detected in deletion map for page ${pageId}`);
      break;
    }
  }
  
  // Verify the final replacement actually exists
  if (boards[boardId] && boards[boardId].pages[currentId]) {
    return currentId;
  }
  
  // Fallback: if we still don't have a valid page, return the first page of the board
  if (boards[boardId] && boards[boardId].pageOrder.length > 0) {
    return boards[boardId].pageOrder[0];
  }
  
  // Last resort: return the input ID (caller should handle this case)
  return currentId;
}

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
    
    // Compile visual state
    const visualState = compileVisualState(modActions);
    if (visualState === null) {
      console.error(`[SERVER] Error compiling visual state for page ${pageId}`);
      return { modActions: [], currentHash: hashAny([]), visualState: createEmptyVisualState() };
    }
    
    return { modActions, currentHash, visualState };
  } catch (error) {
    console.error(`[SERVER] Error loading page ${pageId} from disk:`, error);
    return { modActions: [], currentHash: hashAny([]), visualState: createEmptyVisualState() };
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
      pages: { 
        [initialPageId]: { 
          modActions: [], 
          currentHash: initialHash,
          visualState: createEmptyVisualState() 
        }
      }
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
  const finalPageId = existingPage(pageId, boardId)
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
      
      // Get valid page ID (either current or replacement)
      const pageId = existingPage(client.pageId, client.boardId);
      client.pageId = pageId;
      
      const page = currentBoard.pages[pageId];
      if (!page) {
        console.error(`[SERVER] Page not found: should never happen at this point`);
        return;
      }

      // Get current state information
      const pageHash = page.currentHash;
      const pageNr = currentBoard.pageOrder.indexOf(pageId) + 1;
      const totalPages = currentBoard.pageOrder.length;
      
      // Construct ping message with state information
      const message = {
        type: MESSAGES.SERVER_TO_CLIENT.PING.TYPE,
        [MESSAGES.SERVER_TO_CLIENT.PING.PAGE_UUID]: pageId,
        [MESSAGES.SERVER_TO_CLIENT.PING.HASH]: pageHash,
        [MESSAGES.SERVER_TO_CLIENT.PING.CURRENT_PAGE_NR]: pageNr,
        [MESSAGES.SERVER_TO_CLIENT.PING.CURRENT_TOTAL_PAGES]: totalPages
      };
      
      // Send the ping to this client
      client.send(JSON.stringify(message));
      logSentMessage(message.type, message, 'N/A');
    }
  });
}

// ======= ACTION HANDLING WITH NEW VISUAL STATE INFRASTRUCTURE =======

// Create an action context with all necessary information
function createActionContext(ws, data) {
  const boardId = data.boardId || ws.boardId;
  const pageUuid = data[MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.PAGE_UUID];
  const payload = data[MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.PAYLOAD];
  const beforeHash = data[MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.BEFORE_HASH];
  const actionUuid = data[MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.ACTION_UUID];
  const clientId = ws.clientId;
  
  // Get board and page references
  const board = boards[boardId];
  let currentPage = null;
  let serverHash = null;
  let visualState = null;
  
  if (board && board.pages[pageUuid]) {
    currentPage = board.pages[pageUuid];
    serverHash = currentPage.currentHash;
    visualState = currentPage.visualState;
  }
  
  return {
    boardId,
    pageUuid,
    payload,
    beforeHash,
    actionUuid,
    clientId,
    board,
    currentPage,
    serverHash,
    visualState,
    ws
  };
}

// Basic validation shared by all action handlers
function validateBasicContext(context, requestId) {
  // Check if board exists
  if (!context.board) {
    console.error(`[SERVER] Board not found: ${context.boardId}`);
    return false;
  }
  
  // Ensure page is loaded
  if (!ensurePageLoaded(context.boardId, context.pageUuid)) {
    console.error(`[SERVER] Failed to load page: ${context.pageUuid}`);
    sendFullPage(context.ws, context.boardId, context.pageUuid, requestId);
    return false;
  }
  
  // Update context with loaded page, hash and visual state
  context.currentPage = context.board.pages[context.pageUuid];
  context.serverHash = context.currentPage.currentHash;
  context.visualState = context.currentPage.visualState;
  
  return true;
}

// Create a standard mod action object
function createModAction(context, afterHash) {
  return {
    [MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.ACTION_UUID]: context.actionUuid,
    [MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.PAYLOAD]: context.payload,
    hashes: {
      [MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.BEFORE_HASH]: context.serverHash,
      [MESSAGES.SERVER_TO_CLIENT.ACCEPT_MESSAGE.AFTER_HASH]: afterHash
    },
    clientId: context.clientId // Include client ID for tracking
  };
}

// Update page state with new action
function updatePageState(context, modAction, afterHash, newVisualState) {
  context.currentPage.modActions.push(modAction);
  context.currentPage.currentHash = afterHash;
  context.currentPage.visualState = newVisualState;
}

// Create standard accept message
function createAcceptMessage(context, afterHash) {
  return {
    type: MESSAGES.SERVER_TO_CLIENT.ACCEPT_MESSAGE.TYPE,
    boardId: context.boardId,
    [MESSAGES.SERVER_TO_CLIENT.ACCEPT_MESSAGE.PAGE_UUID]: context.pageUuid,
    [MESSAGES.SERVER_TO_CLIENT.ACCEPT_MESSAGE.ACTION_UUID]: context.actionUuid,
    [MESSAGES.SERVER_TO_CLIENT.ACCEPT_MESSAGE.BEFORE_HASH]: context.serverHash,
    [MESSAGES.SERVER_TO_CLIENT.ACCEPT_MESSAGE.AFTER_HASH]: afterHash,
    [MESSAGES.SERVER_TO_CLIENT.ACCEPT_MESSAGE.CURRENT_PAGE_NR]: context.board.pageOrder.indexOf(context.pageUuid) + 1,
    [MESSAGES.SERVER_TO_CLIENT.ACCEPT_MESSAGE.CURRENT_TOTAL_PAGES]: context.board.pageOrder.length
  };
}

// Create standard decline message
function createDeclineMessage(context, reason = "") {
  return {
    type: MESSAGES.SERVER_TO_CLIENT.DECLINE_MESSAGE.TYPE,
    boardId: context.boardId,
    [MESSAGES.SERVER_TO_CLIENT.DECLINE_MESSAGE.PAGE_UUID]: context.pageUuid,
    [MESSAGES.SERVER_TO_CLIENT.DECLINE_MESSAGE.ACTION_UUID]: context.actionUuid,
    [MESSAGES.SERVER_TO_CLIENT.DECLINE_MESSAGE.REASON]: reason
  };
}

// Send a decline message to client
function sendDeclineMessage(context, reason, requestId) {
  const declineMessage = createDeclineMessage(context, reason);
  context.ws.send(JSON.stringify(declineMessage));
  logSentMessage(declineMessage.type, declineMessage, requestId);
}

// Process a mod action
function processModAction(context, requestId) {
  const actionType = context.payload.type;
  
  // Use the shared.js applyModAction function to create a new visual state
  const newVisualState = applyModAction(context.visualState, {
    [MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.ACTION_UUID]: context.actionUuid,
    [MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.PAYLOAD]: context.payload
  });
  
  // If the action failed, decline it
  if (newVisualState === null) {
    sendDeclineMessage(context, `Failed to apply action of type ${actionType}`, requestId);
    return;
  }
  
  // Calculate the new hash
  const afterHash = hashNext(context.serverHash, context.payload);
  
  // Create the mod action
  const modAction = createModAction(context, afterHash);
  
  // Update page state with new visual state
  updatePageState(context, modAction, afterHash, newVisualState);
  
  // Persist the action
  appendModActionToDisk(context.pageUuid, modAction);
  
  // Handle special actions that affect navigation
  if (actionType === MOD_ACTIONS.NEW_PAGE.TYPE) {
    // Create new page
    const newPageId = generateUuid();
    const initialHash = hashAny([]);
    
    // Insert new page after current page
    const index = context.board.pageOrder.indexOf(context.pageUuid);
    context.board.pageOrder.splice(index + 1, 0, newPageId);
    context.board.pages[newPageId] = { 
      modActions: [], 
      currentHash: initialHash,
      visualState: createEmptyVisualState()
    };
    
    // Update client's page
    context.ws.pageId = newPageId;
    
    // Persist new page and board metadata
    savePageToDisk(newPageId, []);
    saveBoardMetadata();
    
    // Send full page instead of accept message
    sendFullPage(context.ws, context.boardId, newPageId, requestId);
    return;
  }
  
  if (actionType === MOD_ACTIONS.DELETE_PAGE.TYPE) {
    // Only proceed if we have more than one page
    if (context.board.pageOrder.length <= 1) {
      sendDeclineMessage(context, "Cannot delete the only page", requestId);
      return;
    }
    
    // Remove page from order and memory
    const index = context.board.pageOrder.indexOf(context.pageUuid);
    context.board.pageOrder.splice(index, 1);
    delete context.board.pages[context.pageUuid];
    
    // Determine replacement page
    const replacementPageId = context.board.pageOrder[Math.min(index, context.board.pageOrder.length - 1)];
    
    // Update deletion map
    deletionMap[context.pageUuid] = replacementPageId;
    
    // Update client's page
    context.ws.pageId = replacementPageId;
    
    // Mark for deletion and update metadata
    markForDeletion(context.pageUuid, 'page', {
      boardId: context.boardId,
      deletedBy: context.clientId || 'unknown',
      pagePosition: index,
      replacementId: replacementPageId
    });
    
    saveBoardMetadata();
    
    // Send full page instead of accept message
    sendFullPage(context.ws, context.boardId, replacementPageId, requestId);
    return;
  }
  
  // For regular actions, broadcast the accept message
  const acceptMessage = createAcceptMessage(context, afterHash);
  broadcastMessageToBoard(acceptMessage, context.boardId);
  logSentMessage(acceptMessage.type, acceptMessage, requestId);
}

// Process a group of actions
function processGroupAction(context, requestId) {
  if (!context.payload || !context.payload[MOD_ACTIONS.GROUP.ACTIONS] || 
      !Array.isArray(context.payload[MOD_ACTIONS.GROUP.ACTIONS])) {
    sendDeclineMessage(context, "Group action must contain an array of actions", requestId);
    return;
  }
  
  // Get a copy of the initial visual state
  let currentVisualState = [...context.visualState];
  
  // Try applying all actions in the group
  const groupAction = {
    [MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.ACTION_UUID]: context.actionUuid,
    [MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.PAYLOAD]: context.payload
  };
  
  // Use applyModAction from shared.js to process the entire group
  const newVisualState = applyModAction(currentVisualState, groupAction);
  
  // If any action in the group fails, the entire group fails
  if (newVisualState === null) {
    sendDeclineMessage(context, "Failed to apply group action", requestId);
    return;
  }
  
  // Calculate the hash for the whole group
  const afterHash = hashNext(context.serverHash, context.payload);
  
  // Create the mod action for the group
  const modAction = createModAction(context, afterHash);
  
  // Update page state with new visual state
  updatePageState(context, modAction, afterHash, newVisualState);
  
  // Persist the action
  appendModActionToDisk(context.pageUuid, modAction);
  
  // Send a single accept message for the entire group
  const acceptMessage = createAcceptMessage(context, afterHash);
  broadcastMessageToBoard(acceptMessage, context.boardId);
  logSentMessage(acceptMessage.type, acceptMessage, requestId);
}

// Message handlers
const messageHandlers = {};

// Handler for board registration
messageHandlers[MESSAGES.CLIENT_TO_SERVER.REGISTER_BOARD.TYPE] = (ws, data, requestId) => {
  const clientId = data[MESSAGES.CLIENT_TO_SERVER.REGISTER_BOARD.CLIENT_ID];
  let boardId = data[MESSAGES.CLIENT_TO_SERVER.REGISTER_BOARD.BOARD_ID];
  
  // If no board ID provided, generate one
  if (!boardId) {
    boardId = generateUuid();
  }
  
  const board = getOrCreateBoard(boardId);
  ws.boardId = boardId; // Store boardId in WebSocket client
  ws.clientId = clientId; // Store client ID for tracking
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
    pageId = existingPage(data[MESSAGES.CLIENT_TO_SERVER.FULL_PAGE_REQUESTS.PAGE_ID], boardId)
    const index = board.pageOrder.indexOf(pageId);
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

// Handler for modification actions
messageHandlers[MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.TYPE] = (ws, data, requestId) => {
  // Create action context with all necessary data
  const context = createActionContext(ws, data);
  
  // Basic validation (board exists, page loaded)
  if (!validateBasicContext(context, requestId)) {
    return;
  }
  
  // Handle hash mismatch - client is out of sync
  if (context.beforeHash !== context.serverHash) {
    console.log(`[SERVER] Hash mismatch: client ${context.beforeHash}, server ${context.serverHash}`);
    sendFullPage(context.ws, context.boardId, context.pageUuid, requestId);
    return;
  }
  
  // Get action type 
  const actionType = data[MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.PAYLOAD].type;
  
  // Special handling for group actions
  if (actionType === MOD_ACTIONS.GROUP.TYPE) {
    processGroupAction(context, requestId);
  } else {
    // Regular action processing
    processModAction(context, requestId);
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
