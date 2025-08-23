const WebSocket = require('ws');
const fs = require('fs');
const http = require('http');
const path = require('path');

// Port 3001 to avoid conflict with Open WebUI
const wss = new WebSocket.Server({ port: 3001 });

// The shared state of the pages. Each key is a page ID.
let pageState = {
  'page1': {
    box1: 'blue',
    box2: 'red'
  },
  'page2': {
    box1: 'green',
    box2: 'yellow'
  }
};

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

// Broadcast a message to clients on a specific page
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

wss.on('connection', ws => {
  console.log('Client connected');
  // Set the initial page for the client
  ws.pageId = 'page1';
  // Send the initial state of the first page to the new client
  ws.send(JSON.stringify({
    type: 'initialState',
    page: 'page1',
    state: pageState['page1']
  }));

  ws.on('message', message => {
    try {
      const data = JSON.parse(message);
      if (data.type === 'changePage') {
        // Change the client's page and send the new state
        ws.pageId = data.page;
        ws.send(JSON.stringify({
          type: 'initialState',
          page: data.page,
          state: pageState[data.page]
        }));
      } else if (data.type === 'updateBox' && data.page === ws.pageId) {
        // Update the state for the current page
        pageState[data.page][data.boxId] = data.color;
        // Broadcast the new state to clients on this page
        broadcastState(data.page);
      }
    } catch (e) {
      console.error('Invalid message received:', message);
    }
  });

  ws.on('close', () => {
    console.log('Client disconnected');
  });
});
