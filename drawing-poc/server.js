const WebSocket = require('ws');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const url = require('url');

const boards = {};

// We use the HTTP server to serve the single-page application
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

const wss = new WebSocket.Server({ server: httpServer });

console.log('WebSocket server is running on port 3001');

httpServer.listen(8080, () => {
  console.log('HTTP server is running on port 8080');
});

// Utility function to get a board by its unique URL hash
function getBoardByHash(hash) {
  for (const boardId in boards) {
    if (boards[boardId].creatorUrl === hash) {
      return { board: boards[boardId], role: 'creator' };
    }
    if (boards[boardId].spectatorUrl === hash) {
      return { board: boards[boardId], role: 'spectator' };
    }
  }
  return null;
}

// Handler for creating a new board
function createBoard(req, res) {
  const boardId = uuidv4();
  const creatorUrl = uuidv4();
  const spectatorUrl = uuidv4();

  boards[boardId] = {
    creatorUrl,
    spectatorUrl,
    pageState: { '1': [] },
    pageOrder: ['1']
  };

  const creatorLink = `http://gauss:8080/${creatorUrl}`;
  const spectatorLink = `http://gauss:8080/${spectatorUrl}`;

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    creatorLink,
    spectatorLink
  }));
}

// Broadcasts a message to clients on a specific page
function broadcastState(pageId, board) {
  const message = JSON.stringify({
    type: 'stateUpdate',
    page: pageId,
    state: board.pageState[pageId]
  });
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN && client.pageId === pageId && client.boardId === board.id) {
      client.send(message);
    }
  });
}

function sendFullState(ws, board, pageId) {
  const message = JSON.stringify({
    type: 'fullState',
    page: pageId,
    state: board.pageState[pageId],
    pageOrder: board.pageOrder
  });
  ws.send(message);
}

// Listen for HTTP requests to create a new board
httpServer.on('request', (req, res) => {
  if (req.url === '/create-board' && req.method === 'POST') {
    createBoard(req, res);
  } else {
    // Fallback to serving the HTML file for all other requests
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
  }
});

wss.on('connection', (ws, req) => {
  const parsedUrl = url.parse(req.url, true);
  const pathParts = parsedUrl.pathname.split('/').filter(p => p);
  const hash = pathParts[0];

  const boardData = getBoardByHash(hash);

  if (!boardData) {
    console.error('Invalid board URL, closing connection.');
    ws.close();
    return;
  }

  const { board, role } = boardData;
  ws.boardId = Object.keys(boards).find(id => boards[id] === board);
  ws.role = role;
  ws.pageId = board.pageOrder[0];

  console.log(`Client connected to board ${ws.boardId} with role: ${ws.role}`);

  // Send the initial state and role to the client
  ws.send(JSON.stringify({ type: 'initialRole', role: ws.role }));
  sendFullState(ws, board, ws.pageId);

  ws.on('message', message => {
    try {
      const data = JSON.parse(message);
      const currentBoard = boards[ws.boardId];
      if (!currentBoard) return;

      if (ws.role === 'spectator' && (data.type === 'draw' || data.type === 'erase')) {
        console.log('Spectator attempted to draw/erase, request denied.');
        return;
      }

      if (data.type === 'changePage') {
        const newPage = data.page;
        if (currentBoard.pageState[newPage]) {
          ws.pageId = newPage;
          sendFullState(ws, currentBoard, newPage);
        }
      } else if (data.type === 'draw') {
        const stroke = {
          id: uuidv4(),
          points: data.points,
          timestamp: Date.now()
        };
        currentBoard.pageState[ws.pageId].push(stroke);
        const message = JSON.stringify({ type: 'newStroke', page: ws.pageId, stroke: stroke });
        wss.clients.forEach(client => {
          if (client.readyState === WebSocket.OPEN && client.pageId === ws.pageId && client.boardId === ws.boardId) {
            client.send(message);
          }
        });
      } else if (data.type === 'erase') {
        currentBoard.pageState[ws.pageId] = currentBoard.pageState[ws.pageId].filter(stroke => stroke.id !== data.strokeId);
        broadcastState(ws.pageId, currentBoard);
      } else if (data.type === 'deletePage') {
        if (currentBoard.pageOrder.length > 1) {
          const index = currentBoard.pageOrder.indexOf(ws.pageId);
          currentBoard.pageOrder.splice(index, 1);
          delete currentBoard.pageState[ws.pageId];
          const newPageId = currentBoard.pageOrder[Math.min(index, currentBoard.pageOrder.length - 1)];
          ws.pageId = newPageId;
          sendFullState(ws, currentBoard, newPageId);
          broadcastState(newPageId, currentBoard);
        } else {
          currentBoard.pageState[ws.pageId] = [];
          sendFullState(ws, currentBoard, ws.pageId);
          broadcastState(ws.pageId, currentBoard);
        }
      } else if (data.type === 'insertPage') {
        const newPageId = uuidv4();
        const index = currentBoard.pageOrder.indexOf(ws.pageId);
        currentBoard.pageOrder.splice(index + 1, 0, newPageId);
        currentBoard.pageState[newPageId] = [];
        ws.pageId = newPageId;
        sendFullState(ws, currentBoard, newPageId);
        broadcastState(newPageId, currentBoard);
      } else if (data.type === 'nextPage') {
        const index = currentBoard.pageOrder.indexOf(ws.pageId);
        if (index < currentBoard.pageOrder.length - 1) {
          ws.pageId = currentBoard.pageOrder[index + 1];
          sendFullState(ws, currentBoard, ws.pageId);
        }
      } else if (data.type === 'prevPage') {
        const index = currentBoard.pageOrder.indexOf(ws.pageId);
        if (index > 0) {
          ws.pageId = currentBoard.pageOrder[index - 1];
          sendFullState(ws, currentBoard, ws.pageId);
        }
      }
    } catch (e) {
      console.error('Invalid message received:', message, e);
    }
  });

  ws.on('close', () => {
    console.log('Client disconnected');
  });
});
