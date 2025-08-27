const WebSocket = require('ws');
const fs = require('fs');
const http = require('http');
const path = require('path');
const url = require('url');

const { hashAny, hashNext, generateUuid, 
        createEmptyVisualState, applyModAction, applyActionSequence, compileVisualState , 
        MESSAGES, MOD_ACTIONS, STROKE, POINT } = require('./shared');

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
      throw new Error(`Circular reference detected in deletion map for page ${pageId}`);
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
}

// Save board metadata to disk
function saveBoardMetadata() {
  const boardsData = {};
  
  Object.keys(boards).forEach(boardId => {
    boardsData[boardId] = {
      pageOrder: boards[boardId].pageOrder
      // Add any other board metadata here
    };
  });
  
  fs.writeFileSync(getBoardsFilePath(), JSON.stringify(boardsData, null, 2), 'utf8');
}

// Mark an entity for deletion
function markForDeletion(uuid, type = 'page', metadata = {}) {
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
}

// Load a page from disk
function loadPageFromDisk(pageId) {
  const pageFilePath = getPageFilePath(pageId);
  
  if (!fs.existsSync(pageFilePath)) {
    return { 
      modActions: [], 
      currentHash: hashAny([]),
      visualState: createEmptyVisualState()
    };
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
  
  // Compile visual state from mod actions
  const visualState = compileVisualState(modActions)
  if (!visualState) {
    console.log(`[SERVER] cannot compile mod actions.`);
    process.exit(1);
  }
  
  return { modActions, currentHash, visualState };
}

// Save a page to disk
function savePageToDisk(pageId, modActions) {
  const pageFilePath = getPageFilePath(pageId);
  fs.writeFileSync(pageFilePath, JSON.stringify(modActions, null, 2), 'utf8');
}

// Append a modification action to a page file
function appendModActionToDisk(pageId, modAction) {
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
}

function getOrCreateBoard(boardId) {
  if (!boards[boardId]) {
    const initialPageId = generateUuid();
    const initialModActions = [];
    const initialHash = hashAny(intialModActions);
    cosnt initialVisualState = createEmptyVisualState();

    boards[boardId] = {
      pageOrder: [initialPageId],
      pages: { 
        [initialPageId]: { 
          modActions: initialModActions, 
          currentHash: initialHash,
          visualState: initialVisualState
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
  if (!board) {
    throw new Error(`Board not found: ${boardId}`);
  }
  
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
  const finalPageId = existingPage(pageId, boardId);
  const currentBoard = boards[boardId];
  
  if (!currentBoard) {
    throw new Error(`Board not found: ${boardId}`);
  }
  
  // Ensure the page is loaded in memory
  ensurePageLoaded(boardId, finalPageId);
  
  ws.boardId = boardId;
  ws.pageId = finalPageId;
  
  const page = currentBoard.pages[finalPageId];
  const pageState = page.modActions;
  const pageHash = page.currentHash;
  // const visualState = page.visualState;
  const visualState = compileVisualState(pageState);
  const pageNr = currentBoard.pageOrder.indexOf(finalPageId) + 1;
  const totalPages = currentBoard.pageOrder.length;
  
  const message = {
    type: MESSAGES.SERVER_TO_CLIENT.FULL_PAGE.TYPE,
    [MESSAGES.SERVER_TO_CLIENT.FULL_PAGE.PAGE]: finalPageId,
    [MESSAGES.SERVER_TO_CLIENT.FULL_PAGE.STATE]: pageState,
    [MESSAGES.SERVER_TO_CLIENT.FULL_PAGE.HASH]: pageHash,
    [MESSAGES.SERVER_TO_CLIENT.FULL_PAGE.VISUAL_STATE]: visualState,
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
        throw new Error(`Page not found: ${pageId} on board ${client.boardId}`);
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

// ======= ACTION HANDLING WITH VISUAL STATE =======

// Create an action context with all necessary information
function createActionContext(ws, data) {
  const boardId = data.boardId || ws.boardId;
  const pageUuid = data[MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.PAGE_UUID];
  const payload = data[MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.PAYLOAD];
  const beforeHash = data[MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.BEFORE_HASH];
  const actionUuid = data[MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.ACTION_UUID];
  const clientId = ws.clientId;
  
  // No initial board/page access here - will be loaded during validation
  
  return {
    boardId,
    pageUuid,
    payload,
    beforeHash,
    actionUuid,
    clientId,
    ws
  };
}

// Basic validation shared by all action handlers
function validateBasicContext(context, requestId) {
  // Check if board exists
  if (!boards[context.boardId]) {
    throw new Error(`Board not found: ${context.boardId}`);
  }
  
  // Ensure page is loaded and set it in the context
  ensurePageLoaded(context.boardId, context.pageUuid);
  
  // Update context with board and page references
  context.board = boards[context.boardId];
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
function updatePageState(context, modAction, afterHash) {
  // Add the new action
  context.currentPage.modActions.push(modAction);
  context.currentPage.currentHash = afterHash;
  
  // Update visual state by compiling it from scratch
  // This ensures any complex interactions between actions are handled correctly
  // TODO: this should just apply one action.
  context.currentPage.visualState = compileVisualState(context.currentPage.modActions);
  if (!context.currentPage.visualState) {
    console.error('[SERVER] Failed to compile visual state, creating empty state');
    context.currentPage.visualState = createEmptyVisualState();
  }
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
    [MESSAGES.SERVER_TO_CLIENT.ACCEPT_MESSAGE.VISUAL_STATE]: context.currentPage.visualState,
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

// Process a mod action using action-specific strategies
function processModAction(actionType, context, requestId) {
  const strategy = actionStrategies[actionType];
  
  if (!strategy) {
    throw new Error(`Unknown action type: ${actionType}`);
  }
  
  // 1. Validate action-specific constraints
  if (strategy.validate && !strategy.validate(context)) {
    const reason = strategy.getDeclineReason ? strategy.getDeclineReason(context) : "Validation failed";
    sendDeclineMessage(context, reason, requestId);
    return;
  }
  
  // 2. Calculate new state and hash
  const afterHash = strategy.computeHash ? 
    strategy.computeHash(context) : 
    hashNext(context.serverHash, context.payload);
  
  // 3. Create mod action
  const modAction = createModAction(context, afterHash);
  
  // 4. Update state based on strategy
  if (strategy.updateState) {
    strategy.updateState(context, modAction, afterHash);
  } else {
    // Default state update
    updatePageState(context, modAction, afterHash);
  }
  
  // 5. Persist changes
  if (strategy.persistChanges) {
    strategy.persistChanges(context, modAction);
  } else {
    // Default persistence
    appendModActionToDisk(context.pageUuid, modAction);
  }
  
  // 6. Send response
  if (strategy.sendResponse) {
    strategy.sendResponse(context, modAction, afterHash, requestId);
  } else {
    // Default response: broadcast accept message
    const acceptMessage = createAcceptMessage(context, afterHash);
    broadcastMessageToBoard(acceptMessage, context.boardId);
    logSentMessage(acceptMessage.type, acceptMessage, requestId);
  }
}

// Process a single action for group processing
function processActionInternally(actionType, context, actionContext) {
  const strategy = actionStrategies[actionType];
  
  if (!strategy) {
    throw new Error(`Unknown action type in group: ${actionType}`);
  }
  
  // Calculate hash for this action
  const afterHash = strategy.computeHash ? 
    strategy.computeHash(actionContext) : 
    hashNext(actionContext.serverHash, actionContext.payload);
  
  // Create mod action
  const modAction = createModAction(actionContext, afterHash);
  
  // Update state based on strategy
  if (strategy.updateState) {
    strategy.updateState(actionContext, modAction, afterHash);
  } else {
    // Default state update
    updatePageState(actionContext, modAction, afterHash);
  }
  
  // Persist the individual action
  if (strategy.persistChanges) {
    strategy.persistChanges(actionContext, modAction);
  } else {
    // Default persistence
    appendModActionToDisk(actionContext.pageUuid, modAction);
  }
  
  return { success: true, afterHash, modAction };
}

// Process a group of actions
function processGroupAction(context, requestId) {
  if (!context.payload || !context.payload[MOD_ACTIONS.GROUP.ACTIONS] || 
      !Array.isArray(context.payload[MOD_ACTIONS.GROUP.ACTIONS])) {
    sendDeclineMessage(context, "Group action must contain an array of actions", requestId);
    return;
  }
  
  const actions = context.payload[MOD_ACTIONS.GROUP.ACTIONS];
  
  // Start with the current state
  let currentHash = context.serverHash;
  let success = true;
  let failureReason = "";
  
  // Process each action in the group
  for (let i = 0; i < actions.length; i++) {
    const action = actions[i];
    
    // Ensure each action has an actionUuid
    if (!action.actionUuid) {
      throw new Error(`Action at index ${i} missing actionUuid`);
    }
    
    // Create a context for this individual action
    const actionContext = {
      ...context,
      payload: action.payload,
      actionUuid: action.actionUuid, // Use client-provided UUID
      serverHash: currentHash
    };
    
    // Check if we can process this action type
    const actionType = action.payload.type;
    if (!actionStrategies[actionType]) {
      throw new Error(`Unknown action type in group: ${actionType}`);
    }
    
    // Validate this action
    const strategy = actionStrategies[actionType];
    if (strategy.validate && !strategy.validate(actionContext)) {
      success = false;
      failureReason = strategy.getDeclineReason ? 
        strategy.getDeclineReason(actionContext) : 
        `Action at index ${i} failed validation`;
      break;
    }
    
    // Process this action
    const result = processActionInternally(actionType, context, actionContext);
    currentHash = result.afterHash;
  }
  
  // If any action failed, decline the whole group
  if (!success) {
    sendDeclineMessage(context, failureReason, requestId);
    return;
  }
  
  // Send a single accept message for the entire group
  const acceptMessage = createAcceptMessage(context, currentHash);
  broadcastMessageToBoard(acceptMessage, context.boardId);
  logSentMessage(acceptMessage.type, acceptMessage, requestId);
}

// Action-specific strategies
const actionStrategies = {
  [MOD_ACTIONS.DRAW.TYPE]: {
    // DRAW has no special validation or state handling
  },
  
  [MOD_ACTIONS.ERASE.TYPE]: {
    validate: (context) => {
      const erasedStrokeActionUuid = context.payload[MOD_ACTIONS.ERASE.ACTION_UUID];
      // Check if the stroke exists in the visual state
      return context.visualState.some(item => 
        item.type === "stroke" && 
        item.actionUuid === erasedStrokeActionUuid &&
        !item.erased &&
        !item.undone
      );
    },
    
    getDeclineReason: () => "Stroke does not exist or was already erased"
  },
  
  [MOD_ACTIONS.NEW_PAGE.TYPE]: {
    updateState: (context, modAction, afterHash) => {
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
      
      // Standard state update for current page
      updatePageState(context, modAction, afterHash);
      
      // Update client's page
      context.ws.pageId = newPageId;
    },
    
    persistChanges: (context, modAction) => {
      // Persist the action
      appendModActionToDisk(context.pageUuid, modAction);
      
      // Persist new page and board metadata
      const newPageId = context.ws.pageId; // Set in updateState
      savePageToDisk(newPageId, []);
      saveBoardMetadata();
    },
    
    sendResponse: (context, modAction, afterHash, requestId) => {
      // Send full page instead of accept message
      sendFullPage(context.ws, context.boardId, context.ws.pageId, requestId);
    }
  },
  
  [MOD_ACTIONS.DELETE_PAGE.TYPE]: {
    validate: (context) => {
      // Cannot delete the last page
      return context.board.pageOrder.length > 1;
    },
    
    getDeclineReason: () => "Cannot delete the only page",
    
    updateState: (context, modAction, afterHash) => {
      // Add the action to current page
      updatePageState(context, modAction, afterHash);
      
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
    },
    
    persistChanges: (context, modAction) => {
      // Persist the action
      appendModActionToDisk(context.pageUuid, modAction);
      
      // Mark for deletion and update metadata
      markForDeletion(context.pageUuid, 'page', {
        boardId: context.boardId,
        deletedBy: context.clientId || 'unknown',
        pagePosition: context.board.pageOrder.indexOf(context.pageUuid),
        replacementId: context.ws.pageId
      });
      
      saveBoardMetadata();
    },
    
    sendResponse: (context, modAction, afterHash, requestId) => {
      // Send full page instead of accept message
      sendFullPage(context.ws, context.boardId, context.ws.pageId, requestId);
    }
  },
  
  [MOD_ACTIONS.UNDO.TYPE]: {
    validate: (context) => {
      const targetActionUuid = context.payload[MOD_ACTIONS.UNDO.TARGET_ACTION_UUID];
      const clientId = context.payload[MOD_ACTIONS.UNDO.CLIENT_ID];
      
      // Check if target action exists in visual state (meaning it's not already undone)
      const targetElement = context.visualState.find(item => 
        item.actionUuid === targetActionUuid && !item.undone
      );
      
      if (!targetElement) {
        return false;
      }
      
      // Get the original action to check client permissions
      const targetAction = context.currentPage.modActions.find(action => 
        action[MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.ACTION_UUID] === targetActionUuid
      );
      
      // Check client permissions (optional)
      if (targetAction && targetAction.clientId && clientId && targetAction.clientId !== clientId) {
        return false;
      }
      
      return true;
    },
    
    getDeclineReason: (context) => {
      const targetActionUuid = context.payload[MOD_ACTIONS.UNDO.TARGET_ACTION_UUID];
      const clientId = context.payload[MOD_ACTIONS.UNDO.CLIENT_ID];
      
      // Determine specific reason
      const targetElement = context.visualState.find(item => 
        item.actionUuid === targetActionUuid
      );
      
      if (!targetElement) {
        return "Target action not found";
      }
      
      if (targetElement.undone) {
        return "Action already undone";
      }
      
      const targetAction = context.currentPage.modActions.find(action => 
        action[MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.ACTION_UUID] === targetActionUuid
      );
      
      if (targetAction && targetAction.clientId && clientId && targetAction.clientId !== clientId) {
        return "Not allowed to undo another client's action";
      }
      
      return "Validation failed";
    }
  },
  
  [MOD_ACTIONS.REDO.TYPE]: {
    validate: (context) => {
      const targetUndoActionUuid = context.payload[MOD_ACTIONS.REDO.TARGET_UNDO_ACTION_UUID];
      const clientId = context.payload[MOD_ACTIONS.REDO.CLIENT_ID];
      
      // Find the undo action
      const undoAction = context.currentPage.modActions.find(action => 
        action[MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.ACTION_UUID] === targetUndoActionUuid &&
        action[MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.PAYLOAD]?.type === MOD_ACTIONS.UNDO.TYPE
      );
      
      if (!undoAction) {
        return false;
      }
      
      // Check if already redone (there's a REDO action targeting this UNDO)
      const alreadyRedone = context.currentPage.modActions.some(action => {
        const actionPayload = action[MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.PAYLOAD];
        return actionPayload && 
               actionPayload.type === MOD_ACTIONS.REDO.TYPE && 
               actionPayload[MOD_ACTIONS.REDO.TARGET_UNDO_ACTION_UUID] === targetUndoActionUuid;
      });
      
      if (alreadyRedone) {
        return false;
      }
      
      // Check client permissions
      if (undoAction.clientId && clientId && undoAction.clientId !== clientId) {
        return false;
      }
      
      return true;
    },
    
    getDeclineReason: (context) => {
      const targetUndoActionUuid = context.payload[MOD_ACTIONS.REDO.TARGET_UNDO_ACTION_UUID];
      const clientId = context.payload[MOD_ACTIONS.REDO.CLIENT_ID];
      
      // Determine specific reason
      const undoAction = context.currentPage.modActions.find(action => 
        action[MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.ACTION_UUID] === targetUndoActionUuid &&
        action[MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.PAYLOAD]?.type === MOD_ACTIONS.UNDO.TYPE
      );
      
      if (!undoAction) {
        return "Target undo action not found";
      }
      
      const alreadyRedone = context.currentPage.modActions.some(action => {
        const actionPayload = action[MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.PAYLOAD];
        return actionPayload && 
               actionPayload.type === MOD_ACTIONS.REDO.TYPE && 
               actionPayload[MOD_ACTIONS.REDO.TARGET_UNDO_ACTION_UUID] === targetUndoActionUuid;
      });
      
      if (alreadyRedone) {
        return "Action already redone";
      }
      
      if (undoAction.clientId && clientId && undoAction.clientId !== clientId) {
        return "Not allowed to redo another client's undo";
      }
      
      return "Validation failed";
    }
  },
  
  // Group action strategy
  [MOD_ACTIONS.GROUP.TYPE]: {
    validate: (context) => {
      // Check that we have an array of actions
      if (!context.payload || 
          !context.payload[MOD_ACTIONS.GROUP.ACTIONS] || 
          !Array.isArray(context.payload[MOD_ACTIONS.GROUP.ACTIONS]) ||
          context.payload[MOD_ACTIONS.GROUP.ACTIONS].length === 0) {
        return false;
      }
      
      return true;
    },
    
    getDeclineReason: (context) => {
      if (!context.payload || !context.payload[MOD_ACTIONS.GROUP.ACTIONS]) {
        return "Group action must contain actions array";
      }
      
      if (!Array.isArray(context.payload[MOD_ACTIONS.GROUP.ACTIONS])) {
        return "Group actions must be an array";
      }
      
      if (context.payload[MOD_ACTIONS.GROUP.ACTIONS].length === 0) {
        return "Group action cannot be empty";
      }
      
      return "Invalid group action";
    },
    
    // Special handling for groups - defer to the group processor
    updateState: (context, modAction, afterHash) => {
      // The actual state update is handled by processGroupAction
      // which processes each action in the group individually
    },
    
    persistChanges: (context, modAction) => {
      // Individual actions are persisted by processGroupAction
    },
    
    sendResponse: (context, modAction, afterHash, requestId) => {
      // Response is sent by processGroupAction
    }
  }
};

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
  if (!board) {
    throw new Error(`Board not found for full page request: ${boardId}`);
  }

  let pageId;
  if (data[MESSAGES.CLIENT_TO_SERVER.FULL_PAGE_REQUESTS.PAGE_NUMBER]) {
    const pageNumber = data[MESSAGES.CLIENT_TO_SERVER.FULL_PAGE_REQUESTS.PAGE_NUMBER];
    if (pageNumber < 1 || pageNumber > board.pageOrder.length) {
      throw new Error(`Invalid page number: ${pageNumber}`);
    }
    pageId = board.pageOrder[pageNumber - 1];
  } else if (data[MESSAGES.CLIENT_TO_SERVER.FULL_PAGE_REQUESTS.PAGE_ID] && 
             data[MESSAGES.CLIENT_TO_SERVER.FULL_PAGE_REQUESTS.DELTA] !== undefined) {
    pageId = existingPage(data[MESSAGES.CLIENT_TO_SERVER.FULL_PAGE_REQUESTS.PAGE_ID], boardId);
    const index = board.pageOrder.indexOf(pageId);
    if (index === -1) {
      throw new Error(`Page not found in board: ${pageId}`);
    }
    
    const delta = data[MESSAGES.CLIENT_TO_SERVER.FULL_PAGE_REQUESTS.DELTA];
    const newIndex = index + delta;
    if (newIndex < 0 || newIndex >= board.pageOrder.length) {
      throw new Error(`Invalid page navigation delta: ${delta}, current index: ${index}`);
    }
    
    pageId = board.pageOrder[newIndex];
  }
  
  if (!pageId) {
    throw new Error('No valid page ID could be determined from request');
  }
  
  ws.pageId = pageId;
  sendFullPage(ws, boardId, pageId, requestId);
};

// Handler for modification actions
messageHandlers[MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.TYPE] = (ws, data, requestId) => {
  try {
    // Create action context with all necessary data
    const context = createActionContext(ws, data);
    
    // Basic validation (board exists, page loaded)
    validateBasicContext(context, requestId);
    
    // Check hash match
    if (context.beforeHash !== context.serverHash) {
      sendDeclineMessage(
        context, 
        `Hash mismatch: client ${context.beforeHash}, server ${context.serverHash}`, 
        requestId
      );
      return;
    }
    
    // Get action type 
    const actionType = data[MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.PAYLOAD].type;
    
    // Special handling for group actions
    if (actionType === MOD_ACTIONS.GROUP.TYPE) {
      processGroupAction(context, requestId);
    } else {
      // Regular action processing
      processModAction(actionType, context, requestId);
    }
  } catch (error) {
    console.error(`[SERVER] Error processing mod action: ${error.message}`, error);
    // Send a decline message with the error
    if (ws && data) {
      const errorContext = {
        boardId: data.boardId || ws.boardId,
        pageUuid: data[MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.PAGE_UUID],
        actionUuid: data[MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.ACTION_UUID],
        ws
      };
      sendDeclineMessage(errorContext, `Server error: ${error.message}`, requestId);
    }
  }
};

messageHandlers[MESSAGES.CLIENT_TO_SERVER.REPLAY_REQUESTS.TYPE] = (ws, data, requestId) => {
  const boardId = data.boardId || ws.boardId;
  const pageUuid = data[MESSAGES.CLIENT_TO_SERVER.REPLAY_REQUESTS.PAGE_UUID];
  const beforeHash = data[MESSAGES.CLIENT_TO_SERVER.REPLAY_REQUESTS.BEFORE_HASH];
  
  if (!boards[boardId]) {
    throw new Error(`Board not found for replay request: ${boardId}`);
  }
  
  // Ensure the page is loaded
  ensurePageLoaded(boardId, pageUuid);
  
  const board = boards[boardId];
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
  
  // If we didn't find the hash, send the full page instead
  if (!found && replayActions.length === 0) {
    console.log(`[SERVER] Hash ${beforeHash} not found in replay request, sending full page`);
    sendFullPage(ws, boardId, pageUuid, requestId);
    return;
  }
  
  // Calculate the visual state at this point
  const replayVisualState = compileVisualState([...page.modActions].slice(0, page.modActions.length - replayActions.length + 1));
  
  const replayMessage = {
    type: MESSAGES.SERVER_TO_CLIENT.REPLAY_MESSAGE.TYPE,
    boardId: boardId,
    [MESSAGES.SERVER_TO_CLIENT.REPLAY_MESSAGE.PAGE_UUID]: pageUuid,
    [MESSAGES.SERVER_TO_CLIENT.REPLAY_MESSAGE.BEFORE_HASH]: beforeHash,
    [MESSAGES.SERVER_TO_CLIENT.REPLAY_MESSAGE.AFTER_HASH]: finalHash,
    [MESSAGES.SERVER_TO_CLIENT.REPLAY_MESSAGE.SEQUENCE]: replayActions,
    [MESSAGES.SERVER_TO_CLIENT.REPLAY_MESSAGE.VISUAL_STATE]: page.visualState,
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
      throw new Error(`Unhandled message type: ${data.type}`);
    }
  } catch (e) {
    console.error('[SERVER] Error processing message:', e);
    // Send an error message to the client if possible
    if (ws && ws.readyState === WebSocket.OPEN) {
      const errorMessage = {
        type: "error",
        message: e.message,
        stack: e.stack
      };
      ws.send(JSON.stringify(errorMessage));
    }
  }
}

wss.on('connection', (ws, req) => {
  console.log(`[SERVER] New WebSocket connection established`);
  
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
