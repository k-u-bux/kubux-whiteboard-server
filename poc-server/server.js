const WebSocket = require('ws');
const fs = require('fs');
const http = require('http');
const path = require('path');

const wss = new WebSocket.Server({ port: 3001 });

// The shared state of the boxes
let boxState = {
  box1: 'blue',
  box2: 'red'
};

function broadcastState() {
  const message = JSON.stringify(boxState);
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
}

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

wss.on('connection', ws => {
  console.log('Client connected');
  // Send the initial state to the new client
  ws.send(JSON.stringify(boxState));

  ws.on('message', message => {
    try {
      const data = JSON.parse(message);
      if (data.boxId) {
        // Change the color
        boxState[data.boxId] = data.color;
        // Broadcast the new state to all clients
        broadcastState();
      }
    } catch (e) {
      console.error('Invalid message received:', message);
    }
  });

  ws.on('close', () => {
    console.log('Client disconnected');
  });
});
