# Kubux Whiteboard Server Protocol Documentation

## Overview

This document defines the communication protocol between clients and the server for the Kubux Whiteboard collaborative drawing application. The protocol uses WebSockets for real-time communication and JSON for message formatting.

## Protocol Version

- Current Version: 3.0

## Core Architecture

The protocol follows a client-server architecture with these key characteristics:

1. **WebSocket-Based Communication**: All communication between clients and server occurs over a WebSocket connection
2. **JSON Message Format**: All messages are serialized as JSON with support for complex data types (Map, Set, BigInt)
3. **Optimistic Updates**: Clients apply modifications locally before server confirmation
4. **Hash Chain Verification**: Every state transition is validated using a hash chain
5. **Multi-Page Boards**: A board contains multiple pages that can be navigated
6. **Layer Support**: Each page supports multiple drawing layers

## Server State

The server maintains the following state structures:

### Boards
- `board`: Collection of pages
  - `passwd`: Password required for editing operations
  - `pageOrder`: Array of page UUIDs in display order

### Pages
- `page`: Single whiteboard page
  - `history`: Array of modification actions
  - `present`: Current position in history (for undo/redo)
  - `state`: Current visual state
  - `hashes`: Array of hashes representing the state chain

### Page Deletion Mapping
- `deletionMap`: Maps deleted page UUIDs to their replacement page UUIDs
  - When a page is deleted, there's always a replacement page
  - Maintains a chain of redirects: A → A' → A'' → ...

### Client Tracking
- `clients`: Maps client IDs to WebSocket instances
- Each WebSocket connection maintains:
  - `boardId`: Current board the client is viewing
  - `pageId`: Current page the client is viewing
  - `clientId`: Unique identifier for the client

## Client State

The client maintains:

- `boardId`: Identifier of the current board
- `passwd`: Password for edit operations (if authorized)
- `currentPageUuid`: UUID of the current page being viewed
- `history`: Array of modification actions for the current page
- `present`: Current position in the history
- `hashes`: Array of hashes representing the state chain
- `verifiedIndex`: Index of the last action verified by the server
- `visualState`: Current visual state of the page
  - `element`: Map of UUIDs to drawing elements
  - `visible`: Set of visible element UUIDs
- `pageNr`: Current page position in the board
- `totalPages`: Total number of pages in the board
- `activeLayer`: Currently active layer for drawing
- `visibleLayers`: Set of currently visible layers

## Data Structures

### Drawing Elements
Drawing elements are arrays with the following indices:

```
ELEMENT = {
  TYPE: 0,         // DRAWABLE.TYPE
  PATH: 1,         // DRAWABLE.PATH
  POINTS: 2,       // Array of points
  COLOR: 3,        // Color string
  WIDTH: 4,        // Stroke width
  TRANSFORM: 5,    // Affine transformation
  OPACITY: 6,      // Opacity (0-1)
  CAP_STYLE: 7,    // Cap style constant
  JOIN_STYLE: 8,   // Join style constant
  DASH_PATTERN: 9, // Dash pattern array
  SENSITIVITY: 10, // Pressure sensitivity
  LAYER: 11,       // Layer number
  PEN_TYPE: 12     // Pen type
}
```

### Points
Points are arrays with the following indices:

```
POINT = {
  X: 0,
  Y: 1,
  PRESSURE: 2,
  TIMESTAMP: 3
}
```

### Transforms
Transforms are arrays representing affine transformations:

```
TRANSFORM = {
  A: 0, // scale x
  B: 1, // skew y
  C: 2, // skew x
  D: 3, // scale y
  E: 4, // translate x
  F: 5  // translate y
}
```

## Connection Flow

1. Client establishes WebSocket connection to `/ws`
2. Client either:
   a. Registers with an existing board
   b. Creates a new board with provided credentials
3. Server responds with board information
4. Server follows up with a full page message for the initial page

## Protocol Messages

All messages use specific type identifiers and structured payloads.

### Client to Server Messages

#### Board Registration
```json
{
  "type": "register-board",
  "boardId": "017fead5-a5b2-4cd8-b6db-72845434226a",
  "clientId": "unique-client-id",
  "requestId": "request-uuid"
}
```

#### Board Creation
```json
{
  "type": "create-board",
  "passwd": "password-credential",
  "clientId": "unique-client-id",
  "requestId": "request-uuid"
}
```

#### Full Page Request
```json
{
  "type": "fullPage-requests",
  "boardId": "board-uuid",
  "pageId": "page-uuid",
  "delta": 0,
  "requestId": "request-uuid"
}
```

#### Replay Request
```json
{
  "type": "replay-requests",
  "page-uuid": "page-uuid",
  "present": 10,
  "present-hash": "hash-at-position-10",
  "requestId": "request-uuid"
}
```

#### Modification Action Proposal
```json
{
  "type": "mod-action-proposals",
  "passwd": "edit-password",
  "page-uuid": "page-uuid",
  "payload": {
    "type": "draw|erase|group|undo|redo|new page|delete page",
    "uuid": "action-uuid",
    ...action-specific-fields
  },
  "before-hash": "hash-before-action"
}
```

### Server to Client Messages

#### Board Created
```json
{
  "type": "board-created",
  "boardId": "board-uuid",
  "passwd": "edit-password",
  "firstPageId": "page-uuid",
  "requestId": "request-uuid"
}
```

#### Board Registered
```json
{
  "type": "board-registered",
  "boardId": "board-uuid",
  "firstPageId": "page-uuid",
  "totalPages": 3,
  "requestId": "request-uuid"
}
```

#### Full Page
```json
{
  "type": "fullPage",
  "uuid": "page-uuid",
  "history": [array-of-actions],
  "present": 10,
  "hash": "current-hash",
  "pageNr": 1,
  "totalPages": 3
}
```

#### Accept Message
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

#### Decline Message
```json
{
  "type": "decline",
  "uuid": "page-uuid",
  "action-uuid": "action-uuid",
  "reason": "reason for decline"
}
```

#### Replay Message
```json
{
  "type": "replay",
  "uuid": "page-uuid",
  "beforeHash": "hash-before-replay",
  "afterHash": "hash-after-replay",
  "edits": [array-of-actions],
  "present": 10,
  "currentHash": "current-hash",
  "pageNr": 1,
  "totalPages": 3
}
```

#### Ping Message
```json
{
  "type": "ping",
  "uuid": "page-uuid",
  "hash": "current-hash",
  "pageNr": 1,
  "totalPages": 3,
  "snapshots": [array-of-snapshot-hashes]
}
```

## Modification Actions

### Draw Action
```json
{
  "type": "draw",
  "uuid": "action-uuid",
  "stroke": {
    "0": "stroke", // type
    "1": "opl",    // path type
    "2": [...],    // array of points
    "3": "#000000", // color
    "4": 2.0,      // width
    "5": [1,0,0,1,0,0], // transform
    "6": 1.0,      // opacity
    "7": 0,        // cap style
    "8": 0,        // join style
    "9": [0],      // dash pattern
    "10": 0,       // pressure sensitivity
    "11": 0,       // layer
    "12": 0        // pen type
  }
}
```

### Erase Action
```json
{
  "type": "erase",
  "uuid": "action-uuid",
  "targetActionUuid": "uuid-of-stroke-to-erase"
}
```

### Group Action
```json
{
  "type": "group",
  "uuid": "group-uuid",
  "actions": [
    {
      "type": "draw",
      "uuid": "action-uuid-1",
      "stroke": {...}
    },
    {
      "type": "erase",
      "uuid": "action-uuid-2",
      "targetActionUuid": "target-uuid"
    },
    // more actions...
  ]
}
```

### Undo Action
```json
{
  "type": "undo",
  "uuid": "action-uuid",
  "targetActionUuid": "uuid-of-action-to-undo"
}
```

### Redo Action
```json
{
  "type": "redo",
  "uuid": "action-uuid",
  "targetActionUuid": "uuid-of-action-to-redo"
}
```

### New Page Action
```json
{
  "type": "new page",
  "uuid": "action-uuid"
}
```

### Delete Page Action
```json
{
  "type": "delete page",
  "uuid": "action-uuid"
}
```

## Client Implementation Features

### Page Caching
The client implements page caching to optimize performance:

1. **IndexedDB Storage**: Pages are cached using IndexedDB for persistence
2. **Background Optimization**: Two-canvas approach for performance:
   - Background canvas: Static, committed content
   - Foreground canvas: Interactive elements (current stroke, selection, etc.)
3. **Incremental Updates**: Only re-render changed elements when possible
4. **Cache Validation**: Cached pages are validated against server hashes

### Selection and Clipboard Operations
The protocol supports complex selection and clipboard operations:

1. **Selection**: Rectangle, lasso, and stroke selection tools
2. **Copy/Cut/Paste**: Copy, cut, and paste operations with transformations
3. **Move**: Moving elements within or between layers
4. **Affine Transformations**: Scale, rotate, and translate selections

### Layer Management
The protocol supports multi-layer drawing:

1. **Active Layer**: Each stroke is assigned to the active layer
2. **Layer Visibility**: Layers can be shown or hidden
3. **Layer Movement**: Elements can be moved between layers

### Export Capabilities
The client supports PDF export:

1. **Single Page Export**: Export current page as PDF
2. **Multi-Page Export**: Export entire board as multi-page PDF
3. **Vector Rendering**: PDF export uses vector rendering for high quality
4. **Compression**: PDF content is compressed using FlateDecode

## Synchronization Strategy

1. **Optimistic Updates**: Clients apply changes immediately, then send to server
2. **Hash Chain Verification**: Each state transition is validated with a hash chain
3. **Periodic Pings**: Server sends ping messages to verify client state
4. **Replay Mechanism**: When inconsistencies are detected, server sends replay updates
5. **Fallback to Full Page**: If replay fails, client requests full page data

### Hash Verification Process

1. Client applies an action locally and computes a new hash
2. Client sends the action and previous hash to server
3. Server verifies the previous hash matches its record
4. Server applies the action and computes its own new hash
5. Server sends accept message with both hashes
6. Client verifies the new hash matches the server's hash
7. If verification fails, client requests a replay

## Error Handling

1. **Decline Messages**: Server sends decline messages for invalid actions
2. **Error Messages**: Server sends error messages for system errors
3. **Reconnection**: Client handles WebSocket disconnection and reconnection
4. **Hash Mismatch**: Protocol recovers from hash mismatches with replays
5. **Page Deletion**: Server maintains a deletion map to handle deleted pages

## Security Considerations

1. **Edit Authentication**: Editing requires a password
2. **Creation Authentication**: Board creation requires valid credentials
3. **No-Auth Viewing**: Viewing is possible without authentication
4. **Client-Side Storage**: Passwords are stored in URL parameters, not localStorage

## Performance Optimizations

1. **Message Compression**: WebSocket compression for efficient communication
2. **Background Rendering**: Two-canvas approach for efficient rendering
3. **Page Caching**: IndexedDB caching for frequently accessed pages
4. **Hash Snapshots**: Server sends sparse snapshots for efficient verification
5. **Incremental Rendering**: Only render changed portions when possible

## Best Practices for Client Implementation

1. **Handle Disconnections**: Gracefully handle connection drops
2. **Verify Hashes**: Always verify state hashes match the server
3. **Use Group Actions**: Group related modifications into a single transaction
4. **Cache Wisely**: Cache pages but verify before use
5. **Implement Fallbacks**: Always have fallback strategies when optimizations fail

## References

1. **WebSocket Protocol**: [RFC 6455](https://tools.ietf.org/html/rfc6455)
2. **JSON Format**: [RFC 8259](https://tools.ietf.org/html/rfc8259)
3. **IndexedDB API**: [MDN IndexedDB](https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API)
