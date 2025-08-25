# Whiteboard Rendering Architecture

## Overview

This document outlines the rendering architecture for our collaborative whiteboard application. The approach prioritizes simplicity, performance, and user experience by using a content-addressable caching system combined with a snapshot-based action history.

## Key Design Principles

1. **Action-Based State Management**: Store modification actions rather than full scene state
2. **Two-Tier Caching**: Combine element-level and scene-level caching for optimal performance
3. **Content-Addressable Storage**: Identify and cache elements based on their visual properties
4. **Progressive Enhancement**: Fast path for common operations, graceful handling for complex ones

## Core Components

### 1. Modification Actions

The source of truth for the whiteboard state is the sequence of modification actions, which are ordered by the server:

```javascript
// Examples of modification actions
const modActions = [
  {
    type: 'addStroke',
    id: 'stroke123',
    points: [{x: 10, y: 20, pressure: 0.5}, ...],
    style: {color: '#000000', width: 2, opacity: 1}
  },
  {
    type: 'eraseStrokes',
    strokeIds: ['stroke123', 'stroke456']
  },
  {
    type: 'moveStrokes',
    strokeIds: ['stroke789'],
    transform: {tx: 10, ty: 15, sx: 1, sy: 1, r: 0}
  }
];
```

> **Important**: The server defines a total order implicitly by appending to the log when a mod-proposal is accepted. This order is transmitted to the client in the fullPage message and updated based on accept-messages. No timestamps are needed as the array order itself defines the sequence.

### 2. Render Operations

Derived from modification actions, render operations represent what to display:

```javascript
// Examples of render operations
const renderOps = [
  {
    type: 'renderStroke',
    id: 'stroke789',
    contentHash: 'a1b2c3d4e5f6',
    transform: {tx: 10, ty: 15, sx: 1, sy: 1, r: 0},
    visible: true
  },
  // More render operations...
];
```

### 3. Content-Addressable Cache

A cache mapping content hashes to pre-rendered elements:

```javascript
class ContentCache {
  constructor(maxSize = 3000) {
    this.cache = new Map(); // hash → {texture, lastUsed}
    this.maxSize = maxSize;
  }
  
  getTexture(contentHash) {
    // Return cached texture or create new one
  }
  
  enforceMaxSize() {
    // Evict least recently used items when full
  }
}
```

### 4. Snapshot System

Periodic snapshots of render operations to avoid reprocessing:

```javascript
class SnapshotManager {
  constructor() {
    this.snapshots = []; // [{actionIndex, renderOps}]
  }
  
  takeSnapshot(actionIndex, renderOps) {
    // Store current state for fast access later
  }
  
  findLatestSnapshot(actionIndex) {
    // Find most recent snapshot before given index
  }
}
```

## Implementation in `index.html`

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Collaborative Whiteboard</title>
  <style>
    body, html {
      margin: 0;
      padding: 0;
      overflow: hidden;
      width: 100%;
      height: 100%;
    }
    #canvas-container {
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
    }
    #main-canvas {
      position: absolute;
      top: 0;
      left: 0;
    }
  </style>
</head>
<body>
  <div id="canvas-container">
    <canvas id="main-canvas"></canvas>
  </div>

  <script>
    // =============================
    // Core Rendering Engine
    // =============================
    
    class WhiteboardRenderer {
      constructor() {
        // Set up canvas
        this.canvas = document.getElementById('main-canvas');
        this.ctx = this.canvas.getContext('2d');
        this.resizeCanvas();
        
        // Content cache
        this.contentCache = new ContentCache(3000);
        
        // Snapshot system
        this.snapshotManager = new SnapshotManager();
        
        // Action history (ordered by server)
        this.modActions = [];
        this.currentActionIndex = -1;
        
        // View state
        this.viewTransform = {
          scale: 1,
          translateX: 0,
          translateY: 0
        };
        
        // Bind methods
        this.handleResize = this.handleResize.bind(this);
        
        // Event listeners
        window.addEventListener('resize', this.handleResize);
        
        // Initial render
        this.render();
      }
      
      // Apply device pixel ratio for sharp rendering
      resizeCanvas() {
        const container = document.getElementById('canvas-container');
        const dpr = window.devicePixelRatio || 1;
        
        this.canvas.width = container.clientWidth * dpr;
        this.canvas.height = container.clientHeight * dpr;
        this.canvas.style.width = `${container.clientWidth}px`;
        this.canvas.style.height = `${container.clientHeight}px`;
        
        this.ctx.scale(dpr, dpr);
      }
      
      handleResize() {
        this.resizeCanvas();
        this.render();
      }
      
      // Handle new action accepted by server
      applyServerAction(action) {
        // Add to the end of the ordered action list
        this.modActions.push(action);
        this.currentActionIndex = this.modActions.length - 1;
        
        // Take snapshot periodically
        if (this.currentActionIndex % 50 === 0 || this.isHugeAction(action)) {
          this.takeSnapshot();
        }
        
        // Render the current state
        this.render();
      }
      
      // Set full action list from server
      setFullActionList(actions) {
        this.modActions = [...actions];
        this.currentActionIndex = this.modActions.length - 1;
        
        // Clear previous snapshots as they're no longer valid
        this.snapshotManager.clear();
        
        // Create initial snapshot
        this.takeSnapshot();
        
        // Render the current state
        this.render();
      }
      
      // Determine if an action affects many elements
      isHugeAction(action) {
        return ['eraseStrokes', 'moveStrokes', 'clearPage'].includes(action.type);
      }
      
      // Take a snapshot of current render ops
      takeSnapshot() {
        const renderOps = this.buildRenderOps();
        this.snapshotManager.takeSnapshot(this.currentActionIndex, renderOps);
      }
      
      // Build render operations from mod actions
      buildRenderOps() {
        // Find the most recent snapshot to start from
        const latestSnapshot = this.snapshotManager.findLatestSnapshot(this.currentActionIndex);
        
        let startIndex = 0;
        let renderOps = [];
        
        if (latestSnapshot) {
          startIndex = latestSnapshot.actionIndex + 1;
          renderOps = [...latestSnapshot.renderOps];
        }
        
        // Process all actions since the snapshot
        for (let i = startIndex; i <= this.currentActionIndex; i++) {
          const action = this.modActions[i];
          
          switch (action.type) {
            case 'addStroke':
              renderOps.push({
                type: 'renderStroke',
                id: action.id,
                contentHash: this.generateContentHash(action),
                transform: {tx: 0, ty: 0, sx: 1, sy: 1, r: 0},
                visible: true
              });
              break;
              
            case 'eraseStrokes':
              // Mark erased strokes as invisible
              for (const renderOp of renderOps) {
                if (action.strokeIds.includes(renderOp.id)) {
                  renderOp.visible = false;
                }
              }
              break;
              
            case 'moveStrokes':
              // Update transforms of affected strokes
              for (const renderOp of renderOps) {
                if (action.strokeIds.includes(renderOp.id)) {
                  renderOp.transform = this.combineTransforms(renderOp.transform, action.transform);
                  // Content hash includes the transform
                  renderOp.contentHash = this.generateContentHash({
                    ...this.getOriginalAction(renderOp.id),
                    transform: renderOp.transform
                  });
                }
              }
              break;
              
            // Handle other action types...
          }
        }
        
        return renderOps;
      }
      
      // Find the original action that created an element
      getOriginalAction(id) {
        return this.modActions.find(action => 
          action.type === 'addStroke' && action.id === id
        );
      }
      
      // Generate a content hash for caching
      generateContentHash(action) {
        // For production, use a proper hash function like SHA-256
        // Here we use JSON stringify + simple hash for illustration
        const contentString = JSON.stringify({
          points: action.points,
          style: action.style,
          transform: action.transform || {tx: 0, ty: 0, sx: 1, sy: 1, r: 0}
        });
        
        return this.simpleHash(contentString);
      }
      
      simpleHash(str) {
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
          const char = str.charCodeAt(i);
          hash = ((hash << 5) - hash) + char;
          hash = hash & hash; // Convert to 32bit integer
        }
        return hash.toString(16); // Convert to hex string
      }
      
      // Combine two transforms
      combineTransforms(t1, t2) {
        // Simple combination for illustration
        // In production, use proper matrix multiplication
        return {
          tx: t1.tx + t2.tx,
          ty: t1.ty + t2.ty,
          sx: t1.sx * t2.sx,
          sy: t1.sy * t2.sy,
          r: t1.r + t2.r
        };
      }
      
      // Main render method
      render() {
        // Clear canvas
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        
        // Apply view transform
        this.ctx.save();
        this.ctx.scale(this.viewTransform.scale, this.viewTransform.scale);
        this.ctx.translate(this.viewTransform.translateX, this.viewTransform.translateY);
        
        // Get current render operations
        const renderOps = this.buildRenderOps();
        
        // Render each visible operation
        for (const op of renderOps) {
          if (!op.visible) continue;
          
          // Get cached texture or render new one
          const textureInfo = this.contentCache.getTexture(op.contentHash, () => {
            // Render function to create texture if not in cache
            return this.renderElementToTexture(op);
          });
          
          // Draw the element
          this.ctx.save();
          this.applyTransform(op.transform);
          this.ctx.drawImage(
            textureInfo.canvas,
            textureInfo.x,
            textureInfo.y
          );
          this.ctx.restore();
        }
        
        this.ctx.restore();
      }
      
      // Apply a transform to the context
      applyTransform(transform) {
        this.ctx.translate(transform.tx, transform.ty);
        this.ctx.rotate(transform.r);
        this.ctx.scale(transform.sx, transform.sy);
      }
      
      // Render an element to an offscreen canvas for caching
      renderElementToTexture(renderOp) {
        const action = this.getOriginalAction(renderOp.id);
        if (!action) return null;
        
        // Create bounds
        const bounds = this.calculateBounds(action.points);
        const padding = 10; // For antialiasing and stroke width
        
        // Create offscreen canvas
        const canvas = document.createElement('canvas');
        canvas.width = bounds.width + padding * 2;
        canvas.height = bounds.height + padding * 2;
        
        const ctx = canvas.getContext('2d');
        
        // Translate to account for bounds and padding
        ctx.translate(-bounds.minX + padding, -bounds.minY + padding);
        
        // Render the stroke
        ctx.beginPath();
        ctx.strokeStyle = action.style.color;
        ctx.lineWidth = action.style.width;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.globalAlpha = action.style.opacity || 1;
        
        ctx.moveTo(action.points[0].x, action.points[0].y);
        for (let i = 1; i < action.points.length; i++) {
          ctx.lineTo(action.points[i].x, action.points[i].y);
        }
        
        ctx.stroke();
        
        return {
          canvas,
          x: bounds.minX - padding,
          y: bounds.minY - padding,
          width: canvas.width,
          height: canvas.height
        };
      }
      
      // Calculate bounds of a stroke
      calculateBounds(points) {
        let minX = Infinity, minY = Infinity;
        let maxX = -Infinity, maxY = -Infinity;
        
        for (const point of points) {
          minX = Math.min(minX, point.x);
          minY = Math.min(minY, point.y);
          maxX = Math.max(maxX, point.x);
          maxY = Math.max(maxY, point.y);
        }
        
        return {
          minX, minY, maxX, maxY,
          width: maxX - minX,
          height: maxY - minY
        };
      }
      
      // Set the view transform (pan & zoom)
      setViewTransform(scale, translateX, translateY) {
        this.viewTransform = { scale, translateX, translateY };
        this.render();
      }
    }
    
    // =============================
    // Content Cache Implementation
    // =============================
    
    class ContentCache {
      constructor(maxSize = 3000) {
        this.cache = new Map();
        this.usageQueue = [];
        this.maxSize = maxSize;
      }
      
      // Get a texture from cache or create if not exists
      getTexture(contentHash, renderFunc) {
        // Update usage (move to end of queue)
        this.updateUsage(contentHash);
        
        // Check if we have a cached texture
        if (this.cache.has(contentHash)) {
          return this.cache.get(contentHash);
        }
        
        // Not in cache, render the element
        const textureInfo = renderFunc();
        
        // Add to cache
        this.cache.set(contentHash, textureInfo);
        
        // Enforce cache size limit
        this.enforceMaxSize();
        
        return textureInfo;
      }
      
      // Update the LRU tracking
      updateUsage(contentHash) {
        // Remove from current position if it exists
        const index = this.usageQueue.indexOf(contentHash);
        if (index >= 0) {
          this.usageQueue.splice(index, 1);
        }
        
        // Add to end (most recently used)
        this.usageQueue.push(contentHash);
      }
      
      // Enforce maximum cache size
      enforceMaxSize() {
        while (this.cache.size > this.maxSize) {
          // Get least recently used hash
          const oldestHash = this.usageQueue.shift();
          
          // Remove from cache
          this.cache.delete(oldestHash);
        }
      }
      
      // Clear the entire cache
      clear() {
        this.cache.clear();
        this.usageQueue = [];
      }
    }
    
    // =============================
    // Snapshot Manager Implementation
    // =============================
    
    class SnapshotManager {
      constructor(maxSnapshots = 20) {
        this.snapshots = [];
        this.maxSnapshots = maxSnapshots;
      }
      
      takeSnapshot(actionIndex, renderOps) {
        // Create a deep copy of render ops
        const renderOpsCopy = JSON.parse(JSON.stringify(renderOps));
        
        this.snapshots.push({
          actionIndex,
          renderOps: renderOpsCopy
        });
        
        // Enforce max snapshots
        this.pruneSnapshots();
      }
      
      findLatestSnapshot(actionIndex) {
        // Find most recent snapshot before or at the action index
        for (let i = this.snapshots.length - 1; i >= 0; i--) {
          if (this.snapshots[i].actionIndex <= actionIndex) {
            return this.snapshots[i];
          }
        }
        return null;
      }
      
      pruneSnapshots() {
        if (this.snapshots.length <= this.maxSnapshots) return;
        
        // Strategy: Keep first, last, and evenly distributed snapshots
        const toKeep = new Set();
        
        // Always keep first and last snapshots
        toKeep.add(0);
        toKeep.add(this.snapshots.length - 1);
        
        // Distribute remaining slots evenly
        const remainingSlots = this.maxSnapshots - 2;
        const step = (this.snapshots.length - 2) / (remainingSlots + 1);
        
        for (let i = 1; i <= remainingSlots; i++) {
          toKeep.add(Math.floor(i * step));
        }
        
        // Filter to keep only selected snapshots
        this.snapshots = this.snapshots.filter((_, index) => toKeep.has(index));
      }
      
      clear() {
        this.snapshots = [];
      }
    }
    
    // =============================
    // Initialize the Application
    // =============================
    
    document.addEventListener('DOMContentLoaded', () => {
      // Create the renderer
      const renderer = new WhiteboardRenderer();
      
      // Example of handling server messages
      function handleServerMessage(message) {
        switch (message.type) {
          case 'fullPage':
            // Set the entire action list from server
            renderer.setFullActionList(message.actions);
            break;
            
          case 'acceptAction':
            // Add a single new action
            renderer.applyServerAction(message.action);
            break;
        }
      }
      
      // Connect to WebSocket (example)
      // const socket = new WebSocket('wss://your-server.com/whiteboard');
      // socket.onmessage = (event) => {
      //   const message = JSON.parse(event.data);
      //   handleServerMessage(message);
      // };
      
      // For testing - simulate some actions
      const testActions = [
        {
          type: 'addStroke',
          id: 'stroke1',
          points: [
            {x: 100, y: 100}, {x: 200, y: 150}, {x: 300, y: 100}
          ],
          style: {
            color: '#000000',
            width: 3,
            opacity: 1
          }
        },
        {
          type: 'addStroke',
          id: 'stroke2',
          points: [
            {x: 150, y: 200}, {x: 250, y: 250}, {x: 350, y: 200}
          ],
          style: {
            color: '#FF0000',
            width: 5,
            opacity: 0.8
          }
        }
      ];
      
      // Simulate receiving full page
      handleServerMessage({
        type: 'fullPage',
        actions: testActions
      });
      
      // Simulate adding new action after 2 seconds
      setTimeout(() => {
        handleServerMessage({
          type: 'acceptAction',
          action: {
            type: 'addStroke',
            id: 'stroke3',
            points: [
              {x: 200, y: 300}, {x: 300, y: 350}, {x: 400, y: 300}
            ],
            style: {
              color: '#0000FF',
              width: 4,
              opacity: 0.9
            }
          }
        });
      }, 2000);
    });
  </script>
</body>
</html>
```

## Interaction with Server's Total Order

The server maintains a total order of actions by:

1. **Accepting proposals**: When a client proposes a modification, the server either accepts or rejects it
2. **Appending to log**: Accepted actions are appended to the server's action log in a strict sequence
3. **Broadcasting**: The server broadcasts accepted actions to all clients in the same order

The client handles this ordered sequence by:

1. **Initializing with full state**: On connection, receiving the complete ordered action list
2. **Incrementally updating**: As new actions are accepted, appending them to the local action list
3. **Rendering based on order**: Processing actions in the exact order defined by the server

This approach ensures that all clients converge to the same visual state regardless of network latency or connection status.

## Performance Considerations

### Element Rendering

- Each stroke is rendered to its own canvas based on its bounding box
- The content hash includes all visual properties (points, style, transform)
- Reuse is maximized by identifying identical elements via their content hash

### Viewport Culling

For better performance with large documents, implement viewport culling:

```javascript
// In the render method
render() {
  // Get visible bounds in world space
  const visibleBounds = this.getVisibleBounds();
  
  // Filter render ops to only those in view
  const visibleOps = renderOps.filter(op => 
    this.isInView(op, visibleBounds)
  );
  
  // Render only visible elements
  // ...
}
```

### Network Considerations

- The client can render a proposed action immediately (optimistic UI)
- If the server rejects it, the client rolls back to the confirmed state
- When reconnecting, the client syncs its action list with the server's authoritative version

## Memory Management

To prevent memory leaks and ensure consistent performance:

1. **Cache Size Monitoring**: Adjust the content cache size based on available memory
2. **Texture Recycling**: Reuse canvas objects when possible rather than creating new ones
3. **Garbage Collection Hints**: Explicitly null references to large objects when no longer needed
4. **Snapshot Pruning**: Implement intelligent snapshot selection to balance memory and performance

## Future Optimizations

1. **WebGL Rendering**: For larger documents, migrate to WebGL for hardware-accelerated rendering
2. **Web Workers**: Move action processing and element rendering to background threads
3. **Spatial Indexing**: Implement quadtree or R-tree for efficient spatial queries
4. **Progressive Loading**: For large documents, only load/render content near the viewport

## Conclusion

This rendering architecture combines simplicity with high performance by focusing on:

1. A clean, action-based data model respecting the server's total order
2. Content-addressable caching to minimize redundant work
3. Snapshot-based optimization for efficient state rebuilding
4. Viewport-based optimizations for handling large documents

The design is well-suited for collaborative whiteboard applications, providing responsive performance while maintaining a straightforward implementation approach.
