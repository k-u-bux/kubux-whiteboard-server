const WebSocket = require('ws');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const wss = new WebSocket.Server({ port: 3001 });

// The shared state of the pages. Each page has an array of strokes.
let pageState = {
  '1': []
};
let pageOrder = [ '1' ];

console.log('WebSocket server is running on port 3001');

// Serve the HTML file
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

httpServer.listen(8080, () => {
  console.log('HTTP server is running on port 8080');
});

function broadcastState(pageId) {
  const message = JSON.stringify({
    type: 'stateUpdate',
    page: pageId,
    state: pageState[pageId]
  });
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN && client.pageId === pageId) {
      client.send(message);
    }
  });
}

function sendFullState(ws, pageId) {
  const message = JSON.stringify({
    type: 'fullState',
    page: pageId,
    state: pageState[pageId],
    pageOrder: pageOrder
  });
  ws.send(message);
}

wss.on('connection', ws => {
  console.log('Client connected');
  ws.pageId = '1';
  sendFullState(ws, '1');

  ws.on('message', message => {
    try {
      const data = JSON.parse(message);
      if (data.type === 'changePage') {
        const newPage = data.page;
        if (pageState[newPage]) {
          ws.pageId = newPage;
          sendFullState(ws, newPage);
        }
      } else if (data.type === 'draw') {
        const stroke = {
          id: uuidv4(),
          points: data.points,
          timestamp: Date.now()
        };
        pageState[ws.pageId].push(stroke);
        const message = JSON.stringify({ type: 'newStroke', page: ws.pageId, stroke: stroke });
        wss.clients.forEach(client => {
          if (client.readyState === WebSocket.OPEN && client.pageId === ws.pageId) {
            client.send(message);
          }
        });
      } else if (data.type === 'erase') {
        pageState[ws.pageId] = pageState[ws.pageId].filter(stroke => stroke.id !== data.strokeId);
        broadcastState(ws.pageId);
      } else if (data.type === 'deletePage') {
        if (pageOrder.length > 1) {
          const index = pageOrder.indexOf(ws.pageId);
          pageOrder.splice(index, 1);
          delete pageState[ws.pageId];
          const newPageId = pageOrder[Math.min(index, pageOrder.length - 1)];
          ws.pageId = newPageId;
          sendFullState(ws, newPageId);
          broadcastState(newPageId);
        } else {
          pageState[ws.pageId] = [];
          sendFullState(ws, ws.pageId);
          broadcastState(ws.pageId);
        }
      } else if (data.type === 'insertPage') {
        const newPageId = uuidv4();
        const index = pageOrder.indexOf(ws.pageId);
        pageOrder.splice(index + 1, 0, newPageId);
        pageState[newPageId] = [];
        ws.pageId = newPageId;
        sendFullState(ws, newPageId);
        broadcastState(newPageId);
      } else if (data.type === 'nextPage') {
        const index = pageOrder.indexOf(ws.pageId);
        if (index < pageOrder.length - 1) {
          ws.pageId = pageOrder[index + 1];
          sendFullState(ws, ws.pageId);
        }
      } else if (data.type === 'prevPage') {
        const index = pageOrder.indexOf(ws.pageId);
        if (index > 0) {
          ws.pageId = pageOrder[index - 1];
          sendFullState(ws, ws.pageId);
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
