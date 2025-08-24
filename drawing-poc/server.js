const WebSocket = require('ws');
const fs = require('fs');
const http = require('http');
const path = require('path');
const url = require('url');

const { hashAny, hashNext, generateUuid, MESSAGES, MOD_ACTIONS } = require('./shared');

// Server state structures
const boards = {};
const deletionMap = {};
let pingInterval;

function getOrCreateBoard(boardId) {
  if (!boards[boardId]) {
    const initialPageId = generateUuid();
    const initialHash = hashAny([]); // Empty state hash
    boards[boardId] = {
      pageOrder: [initialPageId],
      pages: { [initialPageId]: { modActions: [], currentHash: initialHash } }
    };
    console.log(`[SERVER] Created new board: ${boardId} with initial page: ${initialPageId}`);
  }
  return boards[boardId];
}

const wss = new WebSocket.Server({ port: 3001 });

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
  if (!currentBoard || !currentBoard.pages[finalPageId]) {
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

function routeMessage(ws, message) {
  try {
    const data = JSON.parse(message);
    const requestId = data.requestId || data['action-uuid'] || 'N/A';
    console.log(`[CLIENT > SERVER] Received message of type '${data.type}' with requestId '${requestId}' from client on board '${ws.boardId}':`, data);
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
  const board = boards[data[MESSAGES.CLIENT_TO_SERVER.FULL_PAGE_REQUESTS.BOARD_UUID]];
  if (!board) return;

  let pageId;
  if (data[MESSAGES.CLIENT_TO_SERVER.FULL_PAGE_REQUESTS.PAGE_NUMBER]) {
    pageId = board.pageOrder[data[MESSAGES.CLIENT_TO_SERVER.FULL_PAGE_REQUESTS.PAGE_NUMBER] - 1];
  } else if (data[MESSAGES.CLIENT_TO_SERVER.FULL_PAGE_REQUESTS.PAGE_ID] && data[MESSAGES.CLIENT_TO_SERVER.FULL_PAGE_REQUESTS.DELTA] !== undefined) {
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
    sendFullPage(ws, ws.boardId, pageId, requestId);
  }
};

const modActionHandlers = {};

modActionHandlers[MOD_ACTIONS.DRAW.TYPE] = (ws, data, requestId) => {
  const pageUuid = data[MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.PAGE_UUID];
  const payload = data[MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.PAYLOAD];
  const beforeHash = data[MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.BEFORE_HASH];
  const actionUuid = data[MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.ACTION_UUID];
  const board = boards[ws.boardId];
  
  // Only check if the page exists
  if (!board.pages[pageUuid]) {
    sendFullPage(ws, ws.boardId, pageUuid, requestId);
    return;
  }
  
  const currentPage = board.pages[pageUuid];
  const serverHash = currentPage.currentHash;

  // No hash verification - just accept the stroke
  // Calculate new hash by adding this action to the current state
  const afterHash = hashNext(serverHash, payload);
  
  const modAction = {
    [MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.ACTION_UUID]: actionUuid,
    [MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.PAYLOAD]: payload,
    hashes: {
      [MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.BEFORE_HASH]: serverHash, // Use server's current hash
      [MESSAGES.SERVER_TO_CLIENT.ACCEPT_MESSAGE.AFTER_HASH]: afterHash
    }
  };
  
  currentPage.modActions.push(modAction);
  currentPage.currentHash = afterHash;
  
  const acceptMessage = {
    type: MESSAGES.SERVER_TO_CLIENT.ACCEPT_MESSAGE.TYPE,
    [MESSAGES.SERVER_TO_CLIENT.ACCEPT_MESSAGE.PAGE_UUID]: pageUuid,
    [MESSAGES.SERVER_TO_CLIENT.ACCEPT_MESSAGE.ACTION_UUID]: actionUuid,
    [MESSAGES.SERVER_TO_CLIENT.ACCEPT_MESSAGE.BEFORE_HASH]: serverHash, // Server's hash, not client's
    [MESSAGES.SERVER_TO_CLIENT.ACCEPT_MESSAGE.AFTER_HASH]: afterHash,
    [MESSAGES.SERVER_TO_CLIENT.ACCEPT_MESSAGE.CURRENT_PAGE_NR]: board.pageOrder.indexOf(pageUuid) + 1,
    [MESSAGES.SERVER_TO_CLIENT.ACCEPT_MESSAGE.CURRENT_TOTAL_PAGES]: board.pageOrder.length
  };
  
  broadcastMessageToBoard(acceptMessage, ws.boardId);
  logSentMessage(acceptMessage.type, acceptMessage, requestId);
};

modActionHandlers[MOD_ACTIONS.ERASE.TYPE] = (ws, data, requestId) => {
  const pageUuid = data[MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.PAGE_UUID];
  const payload = data[MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.PAYLOAD];
  const beforeHash = data[MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.BEFORE_HASH];
  const actionUuid = data[MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.ACTION_UUID];
  const board = boards[ws.boardId];
  
  // Check if the page exists
  if (!board.pages[pageUuid]) {
    sendFullPage(ws, ws.boardId, pageUuid, requestId);
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
      [MESSAGES.SERVER_TO_CLIENT.DECLINE_MESSAGE.PAGE_UUID]: pageUuid,
      [MESSAGES.SERVER_TO_CLIENT.DECLINE_MESSAGE.ACTION_UUID]: actionUuid,
    };
    ws.send(JSON.stringify(declineMessage));
    logSentMessage(declineMessage.type, declineMessage, requestId);
    return;
  }
  
  // Remove the stroke
  const newModActions = currentPage.modActions.filter(action => 
    action[MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.ACTION_UUID] !== erasedStrokeActionUuid
  );
  
  // Calculate new hash
  const afterHash = hashNext(serverHash, payload);
  
  currentPage.modActions = newModActions;
  currentPage.currentHash = afterHash;

  const acceptMessage = {
    type: MESSAGES.SERVER_TO_CLIENT.ACCEPT_MESSAGE.TYPE,
    [MESSAGES.SERVER_TO_CLIENT.ACCEPT_MESSAGE.PAGE_UUID]: pageUuid,
    [MESSAGES.SERVER_TO_CLIENT.ACCEPT_MESSAGE.ACTION_UUID]: actionUuid,
    [MESSAGES.SERVER_TO_CLIENT.ACCEPT_MESSAGE.BEFORE_HASH]: serverHash, // Server's hash, not client's
    [MESSAGES.SERVER_TO_CLIENT.ACCEPT_MESSAGE.AFTER_HASH]: afterHash,
    [MESSAGES.SERVER_TO_CLIENT.ACCEPT_MESSAGE.CURRENT_PAGE_NR]: board.pageOrder.indexOf(pageUuid) + 1,
    [MESSAGES.SERVER_TO_CLIENT.ACCEPT_MESSAGE.CURRENT_TOTAL_PAGES]: board.pageOrder.length
  };
  broadcastMessageToBoard(acceptMessage, ws.boardId);
  logSentMessage(acceptMessage.type, acceptMessage, requestId);
};

modActionHandlers[MOD_ACTIONS.NEW_PAGE.TYPE] = (ws, data, requestId) => {
  const pageUuid = data[MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.PAGE_UUID];
  const actionUuid = data[MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.ACTION_UUID];
  const board = boards[ws.boardId];
  const newPageId = generateUuid();
  const initialHash = hashAny([]);
  
  const index = board.pageOrder.indexOf(pageUuid);
  board.pageOrder.splice(index + 1, 0, newPageId);
  board.pages[newPageId] = { 
    modActions: [], 
    currentHash: initialHash 
  };
  
  ws.pageId = newPageId;
  sendFullPage(ws, ws.boardId, newPageId, requestId);
};

modActionHandlers[MOD_ACTIONS.DELETE_PAGE.TYPE] = (ws, data, requestId) => {
  const pageUuid = data[MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.PAGE_UUID];
  const actionUuid = data[MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.ACTION_UUID];
  const board = boards[ws.boardId];
  
  if (board.pageOrder.length <= 1) {
    const declineMessage = {
      type: MESSAGES.SERVER_TO_CLIENT.DECLINE_MESSAGE.TYPE,
      [MESSAGES.SERVER_TO_CLIENT.DECLINE_MESSAGE.PAGE_UUID]: pageUuid,
      [MESSAGES.SERVER_TO_CLIENT.DECLINE_MESSAGE.ACTION_UUID]: actionUuid
    };
    ws.send(JSON.stringify(declineMessage));
    logSentMessage(declineMessage.type, declineMessage, requestId);
    return;
  }
  
  const index = board.pageOrder.indexOf(pageUuid);
  const replacementPageId = board.pageOrder[Math.min(index, board.pageOrder.length - 2)];
  
  deletionMap[pageUuid] = replacementPageId;
  board.pageOrder.splice(index, 1);
  delete board.pages[pageUuid];
  
  ws.pageId = replacementPageId;
  sendFullPage(ws, ws.boardId, replacementPageId, requestId);
};

messageHandlers[MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.TYPE] = (ws, data, requestId) => {
  const handler = modActionHandlers[data[MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.PAYLOAD].type];
  if (handler) {
    handler(ws, data, requestId);
  }
};

messageHandlers[MESSAGES.CLIENT_TO_SERVER.REPLAY_REQUESTS.TYPE] = (ws, data, requestId) => {
  const pageUuid = data[MESSAGES.CLIENT_TO_SERVER.REPLAY_REQUESTS.PAGE_UUID];
  const beforeHash = data[MESSAGES.CLIENT_TO_SERVER.REPLAY_REQUESTS.BEFORE_HASH];
  const board = boards[ws.boardId];
  const page = board.pages[pageUuid];
  
  if (!page) {
    sendFullPage(ws, ws.boardId, ws.pageId, requestId);
    return;
  }
  
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

wss.on('connection', (ws, req) => {
  const parsedUrl = url.parse(req.url, true);
  const boardId = parsedUrl.pathname.slice(1) || '1';
  
  const board = getOrCreateBoard(boardId);
  ws.boardId = boardId;
  ws.pageId = board.pageOrder[0];

  console.log(`[SERVER] Client connected to board: ${ws.boardId}`);
  sendFullPage(ws, ws.boardId, ws.pageId, 'initial-connection');
  
  if (!pingInterval) {
    pingInterval = setInterval(() => {
        sendPing();
    }, 5000);
  }

  ws.on('message', message => routeMessage(ws, message));
  
  ws.on('close', () => {
    console.log(`[SERVER] Client disconnected from board: ${ws.boardId}`);
  });
});
