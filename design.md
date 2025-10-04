# Kubux Whiteboard Server

## Mission Statement

To create a web-based collaborative whiteboard application designed for mathematics collaboration. Our goal is to provide a real-time, multi-user environment where mathematicians, educators, and students can work together seamlessly, with tools optimized for mathematical notation, diagrams, and explanations.

## Protocol Design

### Overview

The communication protocol between clients and the server uses WebSockets for real-time communication with JSON-formatted messages. The protocol is designed around an action-based model where each modification to the whiteboard is represented as an action that can be applied, undone, or redone.

### Key Protocol Concepts

#### State Management

The protocol uses a hash-based state verification system:
- Each modification action is linked to the state before and after its application
- A hash chain validates the sequence of modifications
- Clients can verify their local state matches the server's authoritative state

The hash verification process works as follows:

1. Client applies an action locally and computes a new hash
2. Client sends the action and previous hash to server
3. Server verifies the previous hash matches its record
4. Server applies the action and computes its own new hash
5. Server sends accept message with both hashes
6. Client verifies the new hash matches the server's hash
7. If verification fails, client requests a replay

#### Message Structure

All messages follow a consistent pattern with:
- A `type` field identifying the message purpose
- A `boardId` to identify which whiteboard is being modified
- For actions, a unique `uuid` for tracking and referencing
- For state verification, `before-hash` and `after-hash` values
- Request tracking with optional `requestId` fields

#### Server to Client Messages

Five primary message types:
1. **Full Page**: Complete state of a page including all actions
2. **Accept**: Confirmation of a proposed modification
3. **Decline**: Rejection of a proposed modification
4. **Replay**: Sequence of actions to apply from a specific state
5. **Ping**: Regular update of page state for verification

Example of an Accept Message:
```json
{
  "type": "accept",
  "uuid": "page-uuid",
  "action-uuid": "action-uuid",
  "before-hash": "hash-before-action",
  "after-hash": "hash-after-action",
  "current page-nr in its board": 1,
  "current #pages of the board": 3
}
```

#### Client to Server Messages

Five primary message types:
1. **Register Board**: Connect to a specific whiteboard
2. **Create Board**: Create a new whiteboard with credentials
3. **Mod-Action Proposals**: Propose a modification to the whiteboard
4. **Replay Requests**: Request missing actions from a specific state
5. **Full Page Requests**: Request complete state of a page

Example of a Mod-Action Proposal:
```json
{
  "type": "mod-action-proposals",
  "passwd": "edit-password",
  "page-uuid": "page-uuid",
  "payload": {
    "type": "draw",
    "uuid": "action-uuid",
    "stroke": {...}
  },
  "before-hash": "hash-before-action"
}
```

### Action Types

The protocol supports several action types:

1. **Draw**: Add a new stroke to the whiteboard
2. **Erase**: Remove a specific stroke from the whiteboard
3. **Group**: Execute multiple actions atomically
4. **Undo**: Reverse the effect of a previous action
5. **Redo**: Re-apply a previously undone action
6. **New Page**: Create a new page in the whiteboard
7. **Delete Page**: Remove a page from the whiteboard

## Implementation Architecture

### Server-Side Design

#### State Storage

The server maintains the following state structures:

- **Boards**: Collection of pages with authentication
  - `passwd`: Password required for editing
  - `pageOrder`: Array of page UUIDs in display order
  
- **Pages**: Individual whiteboard pages
  - `history`: Array of modification actions
  - `present`: Current position in history (for undo/redo)
  - `state`: Current visual state
  - `hashes`: Array of hashes representing the state chain

- **Page Deletion Mapping**: Tracking of deleted pages
  - Maps deleted page UUIDs to replacement page UUIDs
  - Maintains redirect chains for consistent navigation

#### Message Handler System

The server implements a modular message handler system:

```javascript
const messageHandlers = {
  [MESSAGES.CLIENT_TO_SERVER.REGISTER_BOARD.TYPE]: handleBoardRegistration,
  [MESSAGES.CLIENT_TO_SERVER.CREATE_BOARD.TYPE]: handleBoardCreation,
  [MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.TYPE]: handleModActionProposal,
  [MESSAGES.CLIENT_TO_SERVER.REPLAY_REQUESTS.TYPE]: handleReplayRequest,
  [MESSAGES.CLIENT_TO_SERVER.FULL_PAGE_REQUESTS.TYPE]: handleFullPageRequest
};

function routeMessage(ws, message) {
  const data = deserialize(message);
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

#### Visual State Management

The server maintains visual state using Set and Map data structures:

```javascript
function createEmptyVisualState() {
  return {
    element: new Map(), // map uuid -> drawable
    visible: new Set()  // set of visible uuids
  };
}
```

Actions are applied to this state through specific handler functions:

```javascript
function commitEdit(visualState, action) {
  const type = action.type;
  const uuid = action.uuid;
  switch (type) {
    case MOD_ACTIONS.DRAW.TYPE:
      return commitDraw(visualState, action[MOD_ACTIONS.DRAW.STROKE], uuid);
    case MOD_ACTIONS.ERASE.TYPE:
      return commitErase(visualState, action[MOD_ACTIONS.ERASE.TARGET_ACTION], uuid);
    case MOD_ACTIONS.GROUP.TYPE:
      return commitGroup(visualState, action[MOD_ACTIONS.GROUP.ACTIONS], uuid);
  }
}
```

This approach enables:
- Efficient state tracking
- Support for complex operations
- Clean undo/redo functionality
- Proper state validation

### Client-Side Implementation

#### State Management

The client maintains three key state components:

1. **History**: Array of all actions that have been applied
2. **Present**: Current position in history (for undo/redo)
3. **Visual State**: Current rendered state (optimized for drawing)

The client implements optimistic updates:
- Apply actions locally before server confirmation
- Track pending actions with local UUIDs
- Update when server confirms or rejects

#### Two-Canvas Rendering System

The client uses a two-canvas approach for efficient rendering:

1. **Background Canvas**: Static content (confirmed actions)
   - Rendered once and cached
   - Only updated when new actions are confirmed
   - Improves performance for large documents

2. **Foreground Canvas**: Dynamic content
   - Current stroke being drawn
   - Selection highlights and handles
   - Temporary visual elements

This approach significantly improves performance by minimizing full redraws.

#### Page Caching

The client implements sophisticated page caching using IndexedDB:

1. **Cache Storage**: Pages are stored in IndexedDB with metadata
2. **Cache Validation**: Cached pages are validated against server hashes
3. **LRU Eviction**: Least Recently Used pages are evicted when cache grows
4. **Incremental Updates**: Pages are updated with diffs when possible

This approach reduces bandwidth usage and improves responsiveness.

#### Layer System

The whiteboard supports a multi-layer drawing system:

1. **Layer Selection**: Users can select which layer to draw on
2. **Layer Visibility**: Layers can be shown/hidden independently
3. **Layer Organization**: Elements can be moved between layers
4. **Rendering Order**: Layers are rendered in a consistent order

The layer system enables better organization of content and separation of concerns.

### Advanced Features

#### Selection and Clipboard

The client implements comprehensive selection and clipboard operations:

1. **Selection Tools**: Rectangle, lasso, and stroke-based selection
2. **Clipboard Operations**: Cut, copy, and paste
3. **Transformation**: Move, rotate, and scale selections
4. **Layer Management**: Move selections between layers

#### PDF Export

The whiteboard supports vector-based PDF export:

1. **Single Page Export**: Export current page as PDF
2. **Multi-Page Export**: Export entire board as multi-page PDF
3. **Vector Rendering**: Preserves quality at any zoom level
4. **FlateDecode Compression**: Efficient file sizes

The PDF export feature is implemented using a custom PDF generation system that translates canvas drawing commands to PDF operators.

### Error Handling Philosophy

The implementation adopts a "fail fast, fail hard" approach:

```javascript
// Assert-based validation
function commitEdit(visualState, action) {
  // ...
  assert(action.type === MOD_ACTIONS.DRAW.TYPE || 
         action.type === MOD_ACTIONS.ERASE.TYPE || 
         action.type === MOD_ACTIONS.GROUP.TYPE);
  // ...
}

// Exception-based error reporting
function ensurePageLoaded(pageId) {
  if (!pages.has(pageId)) {
    throw new Error(`Page ${pageId} not found`);
  }
}
```

Benefits of this approach:
- Makes bugs immediately visible
- Provides clear error messages at the source of the problem
- Prevents propagation of invalid state
- Makes debugging more straightforward

## Current Features

The Kubux Whiteboard currently supports:

### Drawing Tools
- Pen tool with pressure sensitivity
- Chalk tool with consistent stroke width
- Highlighter tool with transparency
- Eraser with path-based selection

### Shape Tools
- Circle drawing with 72-point approximation
- Rectangle drawing
- Horizontal and vertical lines
- Diagonal lines

### Collaboration Features
- Real-time multi-user editing
- Hash-based state synchronization
- Optimistic updates for responsive UI
- Client-side conflict resolution

### Document Management
- Multi-page boards
- Navigation between pages
- Page creation and deletion
- Board sharing via URL

### User Interface
- Tool selection sidebar
- Color picker with custom colors
- Width and opacity controls
- Layer management system
- Selection tools with transformation

### Export Capabilities
- Vector PDF export
- Single page or whole-board export
- FlateDecode compression

## Roadmap

### Short-term Goals

1. **Text and Math Support**
   - Text tool with basic formatting
   - LaTeX equation rendering
   - Text selection and editing
   - Math symbol palette

2. **UI/UX Improvements**
   - Customizable toolbar layout
   - Dark mode support
   - Better mobile/tablet support
   - Improved touch and pen input

3. **Advanced Selection Tools**
   - More precise selection options
   - Group/ungroup functionality
   - Alignment and distribution tools
   - Object properties panel

### Medium-term Goals

1. **Import Capabilities**
   - PDF import and annotation
   - Image insertion and manipulation
   - SVG import
   - Document templates

2. **Advanced Collaboration**
   - User presence indicators
   - Cursor tracking for other users
   - Simple chat or annotation system
   - Permissions system (view/edit/admin)

3. **Performance Optimizations**
   - WebGL-based rendering for large documents
   - Worker-based processing for complex operations
   - More efficient state synchronization
   - Progressive loading for large documents

### Long-term Vision

1. **Advanced Math Tools**
   - Equation editor with LaTeX integration
   - Graph and function plotting
   - Geometric construction tools
   - Mathematical symbol recognition

2. **AI-Assisted Features**
   - Handwriting recognition
   - Diagram recognition and beautification
   - Automatic layout suggestions
   - Content organization assistance

3. **Integration Ecosystem**
   - API for third-party extensions
   - Integration with popular math tools
   - LMS platform integrations
   - Offline support with synchronization

## Conclusion

The Kubux Whiteboard Server combines modern web technologies with collaborative editing principles to create a powerful platform for real-time collaboration. By implementing an action-based state model with hash chain verification and efficient rendering techniques, the system provides a robust foundation for both current features and future enhancements.

Key strengths of the current implementation:
- Clean separation of concerns through modular architecture
- Efficient state synchronization through hash-based verification
- Optimized rendering through the two-canvas approach
- Comprehensive selection and transformation tools
- Vector-based PDF export

Moving forward, the focus will be on enhancing mathematical capabilities, improving collaboration features, and expanding integration options, making this platform an essential tool for online collaboration in educational and professional contexts.
