const WebSocket = require('ws');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const url = require('url');

// Global store for all pages across all boards.
// Keys are page UUIDs, values are arrays of strokes.
const pages = {};

// Global store for each board's unique state (e.g., page order).
// Keys are board IDs (e.g., '1', '2', '3'), values are board objects.
const boards = {};

// Helper to get or create a board
function getOrCreateBoard(boardId) {
  if (!boards[boardId]) {
    const initialPageId = uuidv4();
    boards[boardId] = {
      pageOrder: [initialPageId]
    };
    pages[initialPageId] = [];
    console.log(`Created new board: ${boardId} with initial page: ${initialPageId}`);
  }
  return boards[boardId];
}

const wss = new WebSocket.Server({ port: 3001 });

// Serve the HTML file and handle board URLs
const httpServer = http.createServer((req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const boardId = parsedUrl.pathname.slice(1);

  // Serve the HTML file for the main page and board pages
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
  console.log('HTTP server is running on port 8080');
});

function broadcastState(boardId) {
  const currentBoard = boards[boardId];
  if (!currentBoard) return;

  const message = JSON.stringify({
    type: 'stateUpdate',
    pageOrder: currentBoard.pageOrder
  });

  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN && client.boardId === boardId) {
      client.send(message);
    }
  });
}

function sendFullPageState(ws, boardId, pageId) {
  const message = JSON.stringify({
    type: 'fullState',
    page: pageId,
    state: pages[pageId] || [],
    pageOrder: boards[boardId].pageOrder
  });
  ws.send(message);
}

wss.on('connection', (ws, req) => {
  const parsedUrl = url.parse(req.url, true);
  const boardId = parsedUrl.pathname.slice(1) || '1'; // Default to board '1' if no path provided

  // Get or create the board based on the URL
  const board = getOrCreateBoard(boardId);
  ws.boardId = boardId;
  ws.pageId = board.pageOrder[0];

  console.log(`Client connected to board: ${ws.boardId}`);
  sendFullPageState(ws, ws.boardId, ws.pageId);

  ws.on('message', message => {
    try {
      const data = JSON.parse(message);
      const currentBoard = boards[ws.boardId];
      if (!currentBoard) {
        console.error('Board not found for this connection.');
        return;
      }
      
      const currentPageId = ws.pageId;

      if (data.type === 'draw') {
        const stroke = {
          id: uuidv4(),
          points: data.points,
          timestamp: Date.now()
        };
        // Ensure the page exists before adding the stroke
        if (!pages[currentPageId]) {
          pages[currentPageId] = [];
        }
        pages[currentPageId].push(stroke);
        const message = JSON.stringify({ type: 'newStroke', page: currentPageId, stroke: stroke });

        wss.clients.forEach(client => {
          if (client.readyState === WebSocket.OPEN && client.boardId === ws.boardId) {
            client.send(message);
          }
        });
      } else if (data.type === 'erase') {
        if (pages[currentPageId]) {
          pages[currentPageId] = pages[currentPageId].filter(stroke => stroke.id !== data.strokeId);
        }
        sendFullPageState(ws, ws.boardId, currentPageId);
        broadcastState(ws.boardId);
      } else if (data.type === 'deletePage') {
        if (currentBoard.pageOrder.length > 1) {
          const index = currentBoard.pageOrder.indexOf(currentPageId);
          currentBoard.pageOrder.splice(index, 1);
          delete pages[currentPageId];
          const newPageId = currentBoard.pageOrder[Math.min(index, currentBoard.pageOrder.length - 1)];
          ws.pageId = newPageId;
          sendFullPageState(ws, ws.boardId, newPageId);
          broadcastState(ws.boardId);
        } else {
          // If only one page, clear it instead of deleting it
          pages[currentPageId] = [];
          sendFullPageState(ws, ws.boardId, currentPageId);
          broadcastState(ws.boardId);
        }
      } else if (data.type === 'insertPage') {
        const newPageId = uuidv4();
        const index = currentBoard.pageOrder.indexOf(currentPageId);
        currentBoard.pageOrder.splice(index + 1, 0, newPageId);
        pages[newPageId] = [];
        ws.pageId = newPageId;
        sendFullPageState(ws, ws.boardId, newPageId);
        broadcastState(ws.boardId);
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
      console.error('Invalid message received:', message, e);
    }
  });

  ws.on('close', () => {
    console.log(`Client disconnected from board: ${ws.boardId}`);
    // NOTE: For now, we do not delete boards on client disconnect.
    // This is a topic for a future refactoring step.
  });
});
