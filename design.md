# Xournal++ Clone for Online Math Collaboration

## Mission Statement

To create a web-based collaborative whiteboard application modeled after Xournal++, designed specifically for mathematics collaboration. Our goal is to provide a real-time, multi-user environment where mathematicians, educators, and students can work together seamlessly, with tools optimized for mathematical notation, diagrams, and explanations.

## Protocol Design

### Overview

The communication protocol between clients and the server uses WebSockets for real-time communication with JSON-formatted messages. The protocol is designed around an action-based model where each modification to the whiteboard is represented as an action that can be applied, undone, or redone.

### Key Protocol Concepts

#### State Management

The protocol uses a hash-based state verification system:
- Each modification action is linked to the state before and after its application
- A hash chain validates the sequence of modifications
- Clients can verify their local state matches the server's authoritative state

#### Message Structure

All messages follow a consistent pattern with:
- A `type` field identifying the message purpose
- A `boardId` to identify which whiteboard is being modified
- For actions, a unique `action-uuid` for tracking and referencing
- For state verification, `before-hash` and `after-hash` values
- Request tracking with optional `requestId` fields

#### Server to Client Messages

Five primary message types:
1. **Full Page**: Complete state of a page including all actions
2. **Accept Message**: Confirmation of a proposed modification
3. **Decline Message**: Rejection of a proposed modification
4. **Replay Message**: Sequence of actions to apply from a specific state
5. **Ping Message**: Regular update of page state for verification

Example of an Accept Message:
```json
{
  "type": "accept-message",
  "boardId": "board-uuid",
  "page-uuid": "page-uuid",
  "action-uuid": "action-uuid",
  "before-hash": "hash-value",
  "after-hash": "hash-value",
  "visual-state": [...],
  "current page-nr in its board": 1,
  "current #pages of the board": 3
}
```

#### Client to Server Messages

Four primary message types:
1. **Register Board**: Connect to a specific whiteboard
2. **Mod-Action Proposals**: Propose a modification to the whiteboard
3. **Replay Requests**: Request missing actions from a specific state
4. **Full Page Requests**: Request complete state of a page

Example of a Mod-Action Proposal:
```json
{
  "type": "mod-action-proposals",
  "boardId": "board-uuid",
  "page-uuid": "page-uuid",
  "action-uuid": "action-uuid",
  "payload": {
    "type": "draw",
    "stroke": {...}
  },
  "before-hash": "hash-value"
}
```

### Action Types

The protocol supports several action types:

1. **Draw**: Add a new stroke to the whiteboard
2. **Erase**: Remove a specific stroke from the whiteboard
3. **New Page**: Create a new page in the whiteboard
4. **Delete Page**: Remove a page from the whiteboard
5. **Undo**: Reverse the effect of a previous action
6. **Redo**: Re-apply a previously undone action
7. **Group**: Execute multiple actions atomically

## Implementation Architecture

### Server-Side Design

#### State Storage

The server maintains a structured representation of all whiteboards:
```
boards: {
  [boardId]: {
    pageOrder: [pageId1, pageId2, ...],
    pages: {
      [pageId]: {
        modActions: [...],
        currentHash: "...",
        visualState: [...]
      }
    }
  }
}
```

#### Message Handler System

A key design decision was to implement a modular message handler system:

```javascript
const messageHandlers = {
  [MESSAGES.CLIENT_TO_SERVER.REGISTER_BOARD.TYPE]: handleBoardRegistration,
  [MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.TYPE]: handleModActionProposal,
  [MESSAGES.CLIENT_TO_SERVER.REPLAY_REQUESTS.TYPE]: handleReplayRequest,
  [MESSAGES.CLIENT_TO_SERVER.FULL_PAGE_REQUESTS.TYPE]: handleFullPageRequest
};

function routeMessage(ws, message) {
  const data = JSON.parse(message);
  const handler = messageHandlers[data.type];
  if (handler) {
    handler(ws, data, requestId);
  } else {
    throw new Error(`Unhandled message type: ${data.type}`);
  }
}
```

This approach provides:
- Clear separation of concerns
- Easy extensibility for new message types
- Consistent error handling pattern
- Better testability of individual handlers

#### Action Strategy Pattern

For handling different action types, the server uses a strategy pattern:

```javascript
const actionStrategies = {
  [MOD_ACTIONS.DRAW.TYPE]: {
    // DRAW has no special validation or state handling
  },
  
  [MOD_ACTIONS.ERASE.TYPE]: {
    validate: (context) => {
      // Check if stroke exists and can be erased
    },
    getDeclineReason: () => "Stroke does not exist or was already erased"
  },
  
  // Other action strategies...
};

function processModAction(actionType, context, requestId) {
  const strategy = actionStrategies[actionType];
  
  // 1. Validate using strategy-specific logic
  if (strategy.validate && !strategy.validate(context)) {
    sendDeclineMessage(context, strategy.getDeclineReason(), requestId);
    return;
  }
  
  // 2. Apply the action using strategy methods or defaults
  // ...
}
```

Benefits of this approach:
- Encapsulation of action-specific logic
- Consistent handling flow across all action types
- Easy addition of new action types
- Clear validation and error reporting

#### Action-State Transform Model

A significant design decision was to implement an action-state transform model:

1. **Actions**: The server stores the sequence of modifications (modActions)
2. **Visual State**: The server compiles and maintains the resulting visual state
3. **Hash Chain**: Each action links to the before and after state hashes

```javascript
function compileVisualState(modActions) {
  // Initialize empty visual state
  const visualState = [];
  
  // Process each action to build up the visual state
  for (const action of modActions) {
    const payload = action[MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.PAYLOAD];
    
    switch (payload.type) {
      case MOD_ACTIONS.DRAW.TYPE:
        // Add the stroke to visual state
        visualState.push({
          type: "stroke",
          stroke: payload.stroke,
          actionUuid: actionUuid
        });
        break;
      
      case MOD_ACTIONS.ERASE.TYPE:
        // Mark the stroke as erased
        const strokeIndex = visualState.findIndex(item => 
          item.actionUuid === payload[MOD_ACTIONS.ERASE.ACTION_UUID]
        );
        if (strokeIndex !== -1) {
          visualState[strokeIndex].erased = true;
        }
        break;
      
      // Handle other action types...
    }
  }
  
  return visualState;
}
```

Benefits of this approach:
- Efficient state synchronization (send visual state instead of recomputing)
- Faster client rendering (direct use of visual state)
- Simplified erase operations (no need to filter through all actions)
- Better handling of complex operations like undo/redo

### Client-Side Implementation

#### State Management

The client maintains:
- Verified server state (modActions and hash)
- Optimistic local updates
- Current visual state (combined verified + optimistic)

```javascript
// When sending a stroke to the server
function sendStroke(stroke) {
  const actionUuid = shared.generateUuid();
  
  // Create optimistic update for local rendering
  const newVisualStateItem = {
    type: "stroke",
    stroke: stroke,
    actionUuid: actionUuid,
    erased: false,
    undone: false
  };
  
  // Update local visual state optimistically
  currentVisualState = [...currentVisualState, newVisualStateItem];
  
  // Send to server and track optimistic update
  optimisticUpdates.push({
    actionUuid: actionUuid,
    payload: { type: "draw", stroke: stroke },
    visualStateUpdate: currentVisualState
  });
  
  // Send actual message to server
  sendMessage({
    type: "mod-action-proposals",
    // ...other fields
  });
  
  // Redraw immediately with optimistic update
  redrawCanvas();
}
```

#### Rendering System

The client rendering system directly uses the visual state:

```javascript
function redrawCanvas() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  
  // Get combined visual state (verified + optimistic)
  let renderState = currentVisualState;
  
  // If there are optimistic updates with visual state updates, use the latest
  if (optimisticUpdates.length > 0) {
    const lastOptimisticWithVisualState = optimisticUpdates
      .slice()
      .reverse()
      .find(update => update.visualStateUpdate);
    
    if (lastOptimisticWithVisualState) {
      renderState = lastOptimisticWithVisualState.visualStateUpdate;
    }
  }
  
  // Draw all visible strokes from the visual state
  for (const item of renderState) {
    if (item.type === "stroke" && !item.erased && !item.undone) {
      drawStroke(item.stroke);
    }
  }
  
  // Also draw current stroke if in the middle of drawing
  if (isDrawing && currentPath.length >= 2) {
    drawStroke(currentStyle, currentPath);
  }
}
```

#### Undo/Redo Implementation

The client tracks actions performed by the current user:

```javascript
// Handle undo action
function handleUndo() {
  if (myActions.length === 0) return;
  
  // Get most recent action by this client
  const actionToUndo = myActions[myActions.length - 1];
  
  // Create undo action payload
  const undoAction = {
    type: shared.MOD_ACTIONS.UNDO.TYPE,
    [shared.MOD_ACTIONS.UNDO.TARGET_ACTION_UUID]: actionToUndo,
    [shared.MOD_ACTIONS.UNDO.CLIENT_ID]: clientId
  };
  
  // Send to server
  sendUndoRedoAction(undoAction);
}

// When server accepts the undo
function handleAcceptMessage(data) {
  // ...
  
  // Update undo/redo tracking
  const payload = acceptedAction[shared.MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.PAYLOAD];
  
  if (payload.type === shared.MOD_ACTIONS.UNDO.TYPE) {
    const targetActionUuid = payload[shared.MOD_ACTIONS.UNDO.TARGET_ACTION_UUID];
    
    // Remove target action from myActions
    const index = myActions.indexOf(targetActionUuid);
    if (index !== -1) {
      myActions.splice(index, 1);
    }
    
    // Store mapping for redo
    undoneActions.set(targetActionUuid, acceptedActionUuid);
    
    // Add this undo action to myActions (for potential undo of undo)
    myActions.push(acceptedActionUuid);
  }
  
  // Similar logic for redo...
}
```

### Error Handling Philosophy

A critical design decision was to adopt a "fail fast, fail hard" approach instead of defensive programming:

```javascript
// Before (defensive programming)
function validateBasicContext(context, requestId) {
  if (!context.board) {
    console.error(`[SERVER] Board not found: ${context.boardId}`);
    return false;
  }
  
  if (!ensurePageLoaded(context.boardId, context.pageUuid)) {
    console.error(`[SERVER] Failed to load page: ${context.pageUuid}`);
    sendFullPage(context.ws, context.boardId, context.pageUuid, requestId);
    return false;
  }
  
  // ...more checks
  return true;
}

// After (fail fast approach)
function validateBasicContext(context, requestId) {
  if (!boards[context.boardId]) {
    throw new Error(`Board not found: ${context.boardId}`);
  }
  
  ensurePageLoaded(context.boardId, context.pageUuid);
  
  // Update context with references
  context.board = boards[context.boardId];
  context.currentPage = context.board.pages[context.pageUuid];
  context.serverHash = context.currentPage.currentHash;
  context.visualState = context.currentPage.visualState;
  
  return true;
}
```

Benefits of this approach:
- Makes bugs immediately visible
- Provides clear error messages at the source of the problem
- Prevents propagation of invalid state
- Makes debugging more straightforward

## Advanced Rendering Architecture

### Two-Tier Caching System

The proposed rendering system uses a content-addressable cache combined with snapshots:

1. **Element-Level Caching**: Individual strokes are rendered to offscreen canvases and cached by content hash
2. **Snapshot System**: The sequence of render operations is periodically snapshotted for quick rebuilding

```javascript
class ContentCache {
  constructor(maxSize = 3000) {
    this.cache = new Map(); // hash → {texture, lastUsed}
    this.usageQueue = [];
    this.maxSize = maxSize;
  }
  
  getTexture(contentHash, renderFunc) {
    // Return cached texture or create new one using renderFunc
    // Update LRU tracking
  }
  
  // ...other methods
}

class SnapshotManager {
  constructor(maxSnapshots = 20) {
    this.snapshots = [];
    this.maxSnapshots = maxSnapshots;
  }
  
  takeSnapshot(actionIndex, renderOps) {
    // Store current state for fast access later
  }
  
  findLatestSnapshot(actionIndex) {
    // Find most recent snapshot before given index
  }
  
  // ...other methods
}
```

### Render Operation Pipeline

The rendering system transforms modification actions into render operations:

```javascript
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
        
      // Handle other action types...
    }
  }
  
  return renderOps;
}
```

### Performance Optimizations

Several optimizations are implemented for better performance:

1. **Viewport Culling**: Only render elements visible in the current viewport
2. **Texture Recycling**: Reuse canvas objects to reduce garbage collection
3. **Device Pixel Ratio Handling**: Adjust for high-DPI displays
4. **Batch Rendering**: Group similar operations for fewer context switches

## Roadmap

### Short-term Goals

1. **Core Functionality Enhancements**
   - Text tool implementation with LaTeX support
   - Basic shape tools (rectangles, circles, lines)
   - Selection and transformation tools
   - Layer support for organizing content

2. **UI/UX Improvements**
   - Customizable toolbar layout
   - Dark mode support
   - Keyboard shortcuts for common operations
   - Touch and pen input optimizations

3. **Collaboration Features**
   - User presence indicators
   - Cursor tracking for other users
   - Simple chat or annotation system
   - Permissions system (view/edit/admin)

### Medium-term Goals

1. **Advanced Math Tools**
   - Equation editor with LaTeX integration
   - Graph and function plotting
   - Geometric construction tools
   - Mathematical symbol palette

2. **Document Management**
   - Multi-page navigation improvements
   - Document templates for common use cases
   - Page thumbnails and organization tools
   - Document metadata and organization

3. **Import/Export Capabilities**
   - PDF import/export
   - Image insertion and manipulation
   - SVG export for vector graphics
   - Integration with common LMS platforms

### Long-term Vision

1. **Advanced Rendering**
   - WebGL-based rendering for performance
   - Custom rendering engine optimized for math notation
   - Multi-worker architecture for large documents
   - Progressive loading for very large whiteboards

2. **AI-Assisted Features**
   - Handwriting recognition for math notation
   - Diagram recognition and beautification
   - Automatic layout suggestions
   - Context-aware tool suggestions

3. **Integration Ecosystem**
   - API for third-party extensions
   - Integration with popular math tools (Desmos, GeoGebra)
   - Plugins for specialized domains (physics, chemistry)
   - Offline support with synchronization

## Conclusion

The Xournal++ Clone project combines modern web technologies with collaborative editing principles to create a powerful platform for mathematical collaboration. By implementing an action-state transform model with content-addressable caching and a well-designed protocol, the system provides a robust foundation for future development.

Key strengths of the current implementation:
- Clear separation of concerns through modular architecture
- Efficient state synchronization through visual state compilation
- Robust error handling through fail-fast principles
- Optimized rendering through multi-tier caching

As we move forward, the focus will be on expanding the mathematical toolset while maintaining performance and usability, making this platform an essential tool for online mathematics education and collaboration.
