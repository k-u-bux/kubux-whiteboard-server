const WebSocket = require('ws');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const url = require('url');

// Server state structures
const boards = {};
const deletionMap = {}; // Tracks page deletions and their replacements

function calculateHash(state) {
  const data = JSON.stringify(state);
  let hash = 0;
  for (let i = 0; i < data.length; i++) {
    const char = data.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0;
  }
  return hash.toString();
}

function getOrCreateBoard(boardId) {
  if (!boards[boardId]) {
    const initialPageId = uuidv4();
    boards[boardId] = {
      pageOrder: [initialPageId],
      pages: { [initialPageId]: { modActions: [], hashes: {} } }
    };
    console.log(`[SERVER] Created new board: ${boardId} with initial page: ${initialPageId}`);
  }
  return boards[boardId];
}

const wss = new WebSocket.Server({ port: 3001 });

const httpServer = http.createServer((req, res) => {
  const filePath = path.join(__dirname, 'index.html');
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('File not found!');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
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
  
  const pageState = currentBoard.pages[finalPageId].modActions.map(action => action.payload);
  const pageHash = calculateHash(pageState);
  const pageNr = currentBoard.pageOrder.indexOf(finalPageId) + 1;
  const totalPages = currentBoard.pageOrder.length;
  
  const message = {
    type: 'fullPage',
    page: finalPageId,
    state: pageState,
    hash: pageHash,
    pageNr: pageNr,
    totalPages: totalPages
  };
  ws.send(JSON.stringify(message));
  logSentMessage(message.type, message, requestId);
}

const messageHandlers = {};

// Message router
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

// Full page requests
messageHandlers['fullPage-requests'] = (ws, data, requestId) => {
  const board = boards[data.boardId];
  if (!board) return;

  let pageId;
  if (data.pageNumber) {
    pageId = board.pageOrder[data.pageNumber - 1];
  } else if (data.pageId && data.delta !== undefined) {
    const index = board.pageOrder.indexOf(data.pageId);
    if (index !== -1) {
      const newIndex = index + data.delta;
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

// Mod-action proposals
const modActionHandlers = {};

modActionHandlers['draw'] = (ws, data, requestId) => {
  const { pageUuid, payload, 'before-hash': beforeHash, 'action-uuid': actionUuid } = data;
  const board = boards[ws.boardId];
  const currentPage = board.pages[pageUuid];
  const pageState = currentPage.modActions.map(action => action.payload);
  const serverHash = calculateHash(pageState);

  if (beforeHash !== serverHash) {
    const declineMessage = {
      type: 'decline-message',
      'page-uuid': pageUuid,
      'action-uuid': actionUuid,
    };
    ws.send(JSON.stringify(declineMessage));
    logSentMessage(declineMessage.type, declineMessage, requestId);
    return;
  }

  const newPageState = [...pageState, payload];
  const afterHash = calculateHash(newPageState);

  const modAction = {
    'action-uuid': actionUuid,
    payload: { type: 'draw', ...payload },
    hashes: {
      'before': beforeHash,
      'after': afterHash
    }
  };
  currentPage.modActions.push(modAction);
  
  const acceptMessage = {
    type: 'accept-message',
    'page-uuid': pageUuid,
    'action-uuid': actionUuid,
    'before-hash': beforeHash,
    'after-hash': afterHash,
    'current page-nr in its board': board.pageOrder.indexOf(pageUuid) + 1,
    'current #pages of the board': board.pageOrder.length
  };
  broadcastMessageToBoard(acceptMessage, ws.boardId);
  logSentMessage(acceptMessage.type, acceptMessage, requestId);
};

modActionHandlers['erase'] = (ws, data, requestId) => {
  const { pageUuid, payload, 'before-hash': beforeHash, 'action-uuid': actionUuid } = data;
  const board = boards[ws.boardId];
  const currentPage = board.pages[pageUuid];
  const pageState = currentPage.modActions.map(action => action.payload);
  const serverHash = calculateHash(pageState);

  if (beforeHash !== serverHash) {
    const declineMessage = {
      type: 'decline-message',
      'page-uuid': pageUuid,
      'action-uuid': actionUuid,
    };
    ws.send(JSON.stringify(declineMessage));
    logSentMessage(declineMessage.type, declineMessage, requestId);
    return;
  }
  
  const erasedStrokeActionUuid = payload.actionUuid;
  const newModActions = currentPage.modActions.filter(action => action['action-uuid'] !== erasedStrokeActionUuid);
  
  currentPage.modActions = newModActions;

  const afterHash = calculateHash(newModActions.map(action => action.payload));

  const acceptMessage = {
    type: 'accept-message',
    'page-uuid': pageUuid,
    'action-uuid': actionUuid,
    'before-hash': beforeHash,
    'after-hash': afterHash,
    'current page-nr in its board': board.pageOrder.indexOf(pageUuid) + 1,
    'current #pages of the board': board.pageOrder.length
  };
  broadcastMessageToBoard(acceptMessage, ws.boardId);
  logSentMessage(acceptMessage.type, acceptMessage, requestId);
};

modActionHandlers['new page'] = (ws, data, requestId) => {
  const { pageUuid, 'action-uuid': actionUuid } = data;
  const board = boards[ws.boardId];
  const newPageId = uuidv4();
  const index = board.pageOrder.indexOf(pageUuid);
  board.pageOrder.splice(index + 1, 0, newPageId);
  board.pages[newPageId] = { modActions: [], hashes: {} };
  ws.pageId = newPageId;
  sendFullPage(ws, ws.boardId, newPageId, requestId);
};

modActionHandlers['delete page'] = (ws, data, requestId) => {
  const { pageUuid, 'action-uuid': actionUuid } = data;
  const board = boards[ws.boardId];
  if (board.pageOrder.length <= 1) {
    const declineMessage = { type: 'decline-message', 'page-uuid': pageUuid, 'action-uuid': actionUuid };
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

messageHandlers['mod-action-proposals'] = (ws, data, requestId) => {
  const handler = modActionHandlers[data.payload.type];
  if (handler) {
    handler(ws, data, requestId);
  }
};

messageHandlers['replay-requests'] = (ws, data, requestId) => {
  const { pageUuid, 'before-hash': beforeHash } = data;
  const board = boards[ws.boardId];
  const page = board.pages[pageUuid];
  if (!page) return;
  
  const replayActions = [];
  let found = false;
  for (const action of page.modActions) {
    if (action.hashes.before === beforeHash) {
      found = true;
    }
    if (found) {
      replayActions.push(action);
    }
  }
  
  const replayMessage = {
    type: 'replay-message',
    'page-uuid': pageUuid,
    'sequence of mod-actions': replayActions,
    'current page-nr in its board': board.pageOrder.indexOf(pageUuid) + 1,
    'current #pages of the board': board.pageOrder.length
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

  ws.on('message', message => routeMessage(ws, message));
  
  ws.on('close', () => {
    console.log(`[SERVER] Client disconnected from board: ${ws.boardId}`);
  });
});
