const WebSocket = require('ws');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const url = require('url');

const pages = {};
const boards = {};

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
    pages[initialPageId] = [];
    boards[boardId] = {
      pageOrder: [initialPageId],
      pageHashes: { [initialPageId]: calculateHash( pages[initialPageId] = [] ) }
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

function broadcastMessageToBoard(message, boardId) {
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN && client.boardId === boardId) {
      console.log(`[SERVER > CLIENT] Broadcasting message of type '${message.type}' to board '${boardId}'`);
      client.send(JSON.stringify(message));
    }
  });
}

function sendFullPageState(ws, boardId, pageId) {
  const currentBoard = boards[boardId];
  if (!currentBoard) return;
  const message = {
    type: 'fullState',
    page: pageId,
    state: pages[pageId] || [],
    pageOrder: currentBoard.pageOrder,
    hash: currentBoard.pageHashes[pageId]
  };
  console.log(`[SERVER > CLIENT] Sending full state for page '${pageId}' on board '${boardId}' to single client`);
  ws.send(JSON.stringify(message));
}

wss.on('connection', (ws, req) => {
  const parsedUrl = url.parse(req.url, true);
  const boardId = parsedUrl.pathname.slice(1) || '1';
  
  const board = getOrCreateBoard(boardId);
  ws.boardId = boardId;
  ws.pageId = board.pageOrder[0];

  console.log(`[SERVER] Client connected to board: ${ws.boardId}`);
  sendFullPageState(ws, ws.boardId, ws.pageId);

  ws.on('message', message => {
    try {
      const data = JSON.parse(message);
      console.log(`[CLIENT > SERVER] Received message of type '${data.type}' from client on board '${ws.boardId}'`);
      
      const currentBoard = boards[ws.boardId];
      if (!currentBoard) {
        console.error('[SERVER] Board not found for this connection.');
        return;
      }
      
      const currentPageId = data.page;

      if (data.type === 'draw') {
        const stroke = {
          id: uuidv4(),
          points: data.points,
          timestamp: Date.now()
        };
        if (data.hash !== currentBoard.pageHashes[currentPageId]) {
          console.log('[SERVER] Hash mismatch on draw, sending full state to client.');
          sendFullPageState(ws, ws.boardId, currentPageId);
          return;
        }
        if (!pages[currentPageId]) {
          pages[currentPageId] = [];
        }
        pages[currentPageId].push(stroke);
        currentBoard.pageHashes[currentPageId] = calculateHash(pages[currentPageId]);
        const modMessage = {
          type: 'newStroke',
          page: currentPageId,
          stroke: stroke,
          hash: currentBoard.pageHashes[currentPageId]
        };
        broadcastMessageToBoard(modMessage, ws.boardId);
      } else if (data.type === 'erase') {
        if (data.hash !== currentBoard.pageHashes[currentPageId]) {
          console.log('[SERVER] Hash mismatch on erase, sending full state to client.');
          sendFullPageState(ws, ws.boardId, currentPageId);
          return;
        }
        if (pages[currentPageId]) {
          pages[currentPageId] = pages[currentPageId].filter(stroke => stroke.id !== data.strokeId);
        }
        currentBoard.pageHashes[currentPageId] = calculateHash(pages[currentPageId]);
        broadcastMessageToBoard({
          type: 'fullState',
          page: currentPageId,
          state: pages[currentPageId],
          pageOrder: currentBoard.pageOrder,
          hash: currentBoard.pageHashes[currentPageId]
        }, ws.boardId);
      } else if (data.type === 'deletePage') {
        if (currentBoard.pageOrder.length > 1) {
          const index = currentBoard.pageOrder.indexOf(currentPageId);
          currentBoard.pageOrder.splice(index, 1);
          delete pages[currentPageId];
          delete currentBoard.pageHashes[currentPageId];
          const newPageId = currentBoard.pageOrder[Math.min(index, currentBoard.pageOrder.length - 1)];
          ws.pageId = newPageId;
          broadcastMessageToBoard({ type: 'pageOrderUpdate', pageOrder: currentBoard.pageOrder }, ws.boardId);
          sendFullPageState(ws, ws.boardId, newPageId);
        } else {
          pages[currentPageId] = [];
          currentBoard.pageHashes[currentPageId] = calculateHash(pages[currentPageId]);
          broadcastMessageToBoard({
            type: 'fullState',
            page: currentPageId,
            state: pages[currentPageId],
            pageOrder: currentBoard.pageOrder,
            hash: currentBoard.pageHashes[currentPageId]
          }, ws.boardId);
        }
      } else if (data.type === 'insertPage') {
        const newPageId = uuidv4();
        const index = currentBoard.pageOrder.indexOf(currentPageId);
        currentBoard.pageOrder.splice(index + 1, 0, newPageId);
        pages[newPageId] = [];
        currentBoard.pageHashes[newPageId] = calculateHash([]);
        ws.pageId = newPageId;
        broadcastMessageToBoard({ type: 'pageOrderUpdate', pageOrder: currentBoard.pageOrder }, ws.boardId);
        sendFullPageState(ws, ws.boardId, newPageId);
      } else if (data.type === 'nextPage') {
        const index = currentBoard.pageOrder.indexOf(currentPageId);
        if (index < currentBoard.pageOrder.length - 1) {
          const newPageId = currentBoard.pageOrder[index + 1];
          ws.pageId = newPageId;
          sendFullPageState(ws, ws.boardId, newPageId);
        }
      } else if (data.type === 'prevPage') {
        const index = currentBoard.pageOrder.indexOf(currentPageId);
        if (index > 0) {
          const newPageId = currentBoard.pageOrder[index - 1];
          ws.pageId = newPageId;
          sendFullPageState(ws, ws.boardId, newPageId);
        }
      }
    } catch (e) {
      console.error('[SERVER] Invalid message received:', message, e);
    }
  });

  ws.on('close', () => {
    console.log(`[SERVER] Client disconnected from board: ${ws.boardId}`);
  });
});
