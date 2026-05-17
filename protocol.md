# Kubux Whiteboard Protocol

## Overview

This document describes the WebSocket-based communication protocol used by the Kubux Whiteboard Server. The protocol enables real-time collaborative drawing with support for multiple pages, undo/redo, and state synchronization.

## Message Format

All messages are JSON-encoded with a `type` field identifying the message type. Messages use a `requestId` field for correlating requests and responses.

### Serialization

Messages support complex data types (Map, Set, BigInt) through a custom serialization layer in `shared.js`.

## Client → Server Messages

### `register-board`

Register a client with a board.

```json
{
  "type": "register-board",
  "board": "<board-uuid>",
  "client-id": "<client-uuid>",
  "requestId": "<request-uuid>"
}
```

**Response:** `board-registered`

---

### `register-page`

Register a client with a specific page on a board.

```json
{
  "type": "register-page",
  "board": "<board-uuid>",
  "page": "<page-uuid>",
  "delta": <integer>,
  "client-id": "<client-uuid>",
  "requestId": "<request-uuid>"
}
```

The `delta` parameter specifies page navigation offset (e.g., +1 for next page, -1 for previous page). The server resolves the target page relative to the current page.

**Response:** `page-registered`

---

### `page-info-request`

Request metadata about a page (snapshots for hash-chain verification).

```json
{
  "type": "page-info-request",
  "board": "<board-uuid>",
  "page": "<page-uuid>",
  "delta": <integer>,
  "register": <boolean>,
  "requestId": "<request-uuid>"
}
```

- `register`: If true, the client will be registered to the resolved page (switches the client's active page).
- `delta`: Page navigation offset (0 for current page).

**Response:** `page-info`

---

### `full-page-request`

Request the complete state of a page (history + present position).

```json
{
  "type": "full-page-request",
  "board": "<board-uuid>",
  "page": "<page-uuid>",
  "delta": <integer>,
  "register": <boolean>,
  "requestId": "<request-uuid>"
}
```

**Response:** `full-page`

---

### `replay-request`

Request replay of actions from a known hash position.

```json
{
  "type": "replay-request",
  "board": "<board-uuid>",
  "page": "<page-uuid>",
  "present": <integer>,
  "present-hash": "<hash-string>",
  "register": <boolean>,
  "requestId": "<request-uuid>"
}
```

The client provides its current position and hash. The server responds with all actions from that point forward, allowing the client to catch up.

**Response:** `replay`

---

### `mod-action-proposals`

Propose a modification action (draw, erase, group, undo, redo, new-page, delete-page).

```json
{
  "type": "mod-action-proposals",
  "password": "<board-password>",
  "board": "<board-uuid>",
  "page": "<page-uuid>",
  "payload": { <action-object> },
  "before-hash": "<hash-string>",
  "requestId": "<request-uuid>"
}
```

The `before-hash` field contains the hash of the state *before* applying the action, enabling the server to verify the client's state is current.

**Response:** `accept` or `decline`

---

### `board-info-request`

Request the current page order of a board.

```json
{
  "type": "board-info-request",
  "board": "<board-uuid>",
  "register": <boolean>,
  "requestId": "<request-uuid>"
}
```

- `register`: If true, the client will be registered to the first page of the board.

**Response:** `board-info`

---

### `shuffle-proposal`

Propose a reordering of pages on a board.

```json
{
  "type": "shuffle-proposal",
  "board": "<board-uuid>",
  "password": "<board-password>",
  "before": ["<page-uuid>", ...],
  "after": ["<page-uuid>", ...],
  "requestId": "<request-uuid>"
}
```

The server validates:
1. Password matches the board password
2. `before` matches the current server-side page order (sync check)
3. `after` is a valid permutation of the same UUIDs

**Response:** `board-info` (broadcast to all subscribers on the board)

---

### `create-board`

Create a new board (requires server-level credential).

```json
{
  "type": "create-board",
  "password": "<credential>",
  "client-id": "<client-uuid>",
  "requestId": "<request-uuid>"
}
```

**Response:** `board-created`

---

## Server → Client Messages

### `board-created`

Sent in response to a successful board creation.

```json
{
  "type": "board-created",
  "board": "<new-board-uuid>",
  "password": "<new-board-password>",
  "requestId": "<request-uuid>"
}
```

---

### `board-registered`

Sent in response to a successful board registration.

```json
{
  "type": "board-registered",
  "board": "<board-uuid>",
  "first-page": "<page-uuid>",
  "last-page": "<page-uuid>",
  "total-pages": <integer>,
  "requestId": "<request-uuid>"
}
```

---

### `page-registered`

Sent in response to a successful page registration.

```json
{
  "type": "page-registered",
  "page": "<page-uuid>",
  "page-nr": <integer>,
  "total-pages": <integer>,
  "requestId": "<request-uuid>"
}
```

---

### `full-page`

Contains the complete state of a page.

```json
{
  "type": "full-page",
  "page": "<page-uuid>",
  "history": [<action>, ...],
  "present": <integer>,
  "page-nr": <integer>,
  "total-pages": <integer>,
  "switch": <boolean>,
  "requestId": "<request-uuid>"
}
```

- `switch`: If true, the client should switch to this page.
- `history`: Array of all actions in the timeline.
- `present`: Current position in the timeline (for undo/redo).

---

### `page-info`

Contains metadata about a page (snapshots for hash-chain verification).

```json
{
  "type": "page-info",
  "page": "<page-uuid>",
  "hash": "<hash-string>",
  "snapshots": ["<hash-string>", ...],
  "page-nr": <integer>,
  "total-pages": <integer>,
  "switch": <boolean>,
  "requestId": "<request-uuid>"
}
```

The `snapshots` array contains spaced hashes from the page's hash chain, enabling the client to find a matching hash without needing the full history.

---

### `page-lost`

Sent when a page has been deleted and the client needs to be redirected.

```json
{
  "type": "page-lost",
  "page": "<replacement-page-uuid>",
  "lost": "<deleted-page-uuid>",
  "page-nr": <integer>,
  "total-pages": <integer>,
  "requestId": "<request-uuid>"
}
```

---

### `replay`

Contains actions from a specific point in the hash chain forward.

```json
{
  "type": "replay",
  "page": "<page-uuid>",
  "before-hash": "<hash-string>",
  "after-hash": "<hash-string>",
  "sequence": [<action>, ...],
  "present": <integer>,
  "current-hash": "<hash-string>",
  "page-nr": <integer>,
  "total-pages": <integer>,
  "requestId": "<request-uuid>",
  "switch": <boolean>
}
```

---

### `accept`

Sent when a modification action is accepted by the server.

```json
{
  "type": "accept",
  "page": "<page-uuid>",
  "action-index": <integer>,
  "action-uuid": "<action-uuid>",
  "before-hash": "<hash-string>",
  "after-hash": "<hash-string>",
  "page-nr": <integer>,
  "total-pages": <integer>,
  "requestId": "<request-uuid>"
}
```

---

### `decline`

Sent when a modification action is declined by the server.

```json
{
  "type": "decline",
  "page": "<page-uuid>",
  "action-uuid": "<action-uuid>",
  "reason": "<string>",
  "requestId": "<request-uuid>"
}
```

---

### `ping`

Periodic state verification message sent by the server.

```json
{
  "type": "ping",
  "page": "<page-uuid>",
  "hash": "<hash-string>",
  "page-nr": <integer>,
  "total-pages": <integer>,
  "snapshots": ["<hash-string>", ...],
  "requestId": "<request-uuid>"
}
```

The `snapshots` array contains spaced hashes from the page's hash chain, enabling the client to find a matching hash for efficient reconciliation without requesting a full page.

---

### `board-info`

Contains the current page order of a board. Sent in response to `board-info-request` or broadcast after a successful `shuffle-proposal`.

```json
{
  "type": "board-info",
  "board": "<board-uuid>",
  "pages": ["<page-uuid>", ...],
  "requestId": "<request-uuid>"
}
```

---

## Action Types

Actions are the fundamental units of modification. Each action has a `type` and a `uuid`.

### `draw`

Add a new stroke to the page.

```json
{
  "type": "draw",
  "uuid": "<action-uuid>",
  "stroke": { <stroke-object> }
}
```

### `erase`

Remove a stroke from the page.

```json
{
  "type": "erase",
  "uuid": "<action-uuid>",
  "target-action": "<element-uuid>"
}
```

The `target-action` field references the UUID of the element to erase (not the action that created it, but the element's UUID).

### `group`

Group multiple actions into a single atomic operation.

```json
{
  "type": "group",
  "uuid": "<action-uuid>",
  "actions": [<action>, ...]
}
```

Used for operations like cut, move, layer change, and batch erase.

### `undo`

Undo the most recent action.

```json
{
  "type": "undo",
  "uuid": "<action-uuid>",
  "target-action": "<action-uuid>"
}
```

The `target-action` references the UUID of the action to undo. The server verifies this is the immediate past action.

### `redo`

Redo the most recently undone action.

```json
{
  "type": "redo",
  "uuid": "<action-uuid>",
  "target-action": "<action-uuid>"
}
```

The `target-action` references the UUID of the action to redo. The server verifies this is the immediate future action.

### `new-page`

Insert a new page after the current page.

```json
{
  "type": "new-page",
  "uuid": "<action-uuid>"
}
```

The server creates a new empty page and inserts it into the board's page order after the page specified in the enclosing `mod-action-proposals` message. The new page UUID is generated server-side. The response includes a `full-page` for the new page and a `board-info` broadcast to all subscribers.

### `delete-page`

Delete the current page.

```json
{
  "type": "delete-page",
  "uuid": "<action-uuid>"
}
```

The server removes the page from the board's page order. If it was the last page, a replacement empty page is created. A deletion map entry is created to redirect future requests for the deleted UUID. The response includes a `page-info` or `full-page` for the replacement page and a `board-info` broadcast.

---

## Stroke Object Structure

A stroke represents a drawn element on the canvas:

```json
{
  "type": <0|1>,           // 0 = STROKE, 1 = FILL
  "path": <0|1>,           // 0 = OPEN, 1 = CLOSED
  "points": [[x, y, pressure], ...],
  "color": "<css-color>",
  "width": <number>,
  "opacity": <number>,
  "cap-style": <0|1|2>,    // 0 = ROUND, 1 = BUTT, 2 = SQUARE
  "join-style": <0|1|2>,   // 0 = ROUND, 1 = BEVEL, 2 = MITER
  "sensitivity": <number>,
  "dash-pattern": [<number>, ...],
  "layer": <0-7>,
  "transform": [a, b, c, d, e, f]
}
```

---

## Hash Chain

The protocol uses a hash chain to ensure state consistency between clients and server:

1. **Initial hash**: `hashAny(pageUuid)` — a hash derived from the page UUID
2. **Subsequent hashes**: `hashNext(previousHash, action)` — combines the previous hash with the new action
3. **Verification**: Clients and server independently compute hashes. Mismatches trigger replay requests.

### Snapshots

The server maintains spaced snapshots of the hash chain (every few actions). These are sent in `page-info` and `ping` messages, allowing clients to find a matching hash point without needing the full history.

---

## Board States

### Page Order

Each board maintains an ordered list of page UUIDs (`pageOrder`). This order determines:
- Page numbering (1-based)
- Navigation order (next/prev)
- Overview mode display order

### Shuffle Protocol

Page reordering follows a proposal-acceptance protocol:

1. **Client** sends `shuffle-proposal` with `before` (current order) and `after` (desired order)
2. **Server** validates:
   - Password matches board password
   - `before` matches current server state (sync check)
   - `after` is a valid permutation of the same UUIDs
3. **Server** applies the new order and broadcasts `board-info` to all subscribers

### Board Info

The `board-info` message is used to synchronize page order across all clients. It is sent:
- In response to `board-info-request`
- After a successful `shuffle-proposal`
- Periodically as part of the board info broadcast

---

## Page Management Protocol

### Adding a Page

1. Client sends `mod-action-proposals` with a `new-page` action
2. Server creates a new page with a server-generated UUID
3. Server inserts the new page into `board.pageOrder` after the specified page
4. Server sends `full-page` to the requesting client (with `switch: true`)
5. Server broadcasts `board-info` to all subscribers
6. Server sends a `ping` to trigger state verification

### Deleting a Page

1. Client sends `mod-action-proposals` with a `delete-page` action
2. Server removes the page from `board.pageOrder`
3. If it was the last page, a replacement empty page is created
4. A deletion map entry maps the deleted UUID to the replacement UUID
5. Server sends `page-info` or `full-page` to the requesting client
6. Server broadcasts `board-info` to all subscribers
7. Server sends a `ping` to trigger state verification

### Deletion Map

When a page is deleted, the server maintains a mapping from the deleted UUID to its replacement. This ensures that clients requesting the deleted page (e.g., from cache) are redirected to the correct replacement page. The mapping is persisted to `data/to_be_removed.json`.

---

## Overview Mode

Overview mode is a client-side feature that displays all pages as thumbnails in a grid. It interacts with the protocol as follows:

1. **Entering overview**: The client commits the current page to cache and requests `board-info` to get the current page order
2. **Rendering thumbnails**: The client renders each page from its local cache. Pages not in cache are requested via `full-page-request`
3. **Reordering**: The client performs drag-and-drop locally. On confirm, it sends a `shuffle-proposal` with the new order
4. **Deleting**: The client sends `mod-action-proposals` with `delete-page` actions for each selected page
5. **Adding**: The client sends `mod-action-proposals` with a `new-page` action
6. **Exporting**: The client requests `page-info` and `replay` for each page, then renders them as PDF pages
7. **Real-time updates**: While in overview mode, the client processes `board-info` and `ping` messages to keep the grid up to date. New pages are inserted into the grid, deleted pages are removed.

---

## Error Handling

### Message Validation

All incoming messages are validated against their expected schema. Invalid messages are silently dropped.

### State Inconsistency

When a hash mismatch is detected (via `ping` or `accept`/`decline`), the client:
1. Attempts to find a matching hash in its chain using the server's snapshots
2. If found, requests a `replay` from that point
3. If not found, requests a `full-page` refresh

### Reconnection

Clients use exponential backoff for reconnection:
- Initial delay: 1 second
- Maximum delay: 30 seconds
- On successful connection, the client re-registers with the board

---

## Appendix A: Message Type Constants

```javascript
// Client → Server
MESSAGES.CLIENT_TO_SERVER = {
  REGISTER_BOARD:        { TYPE: "register-board" },
  REGISTER_PAGE:         { TYPE: "register-page" },
  PAGE_INFO_REQUEST:     { TYPE: "page-info-request" },
  FULL_PAGE_REQUEST:     { TYPE: "full-page-request" },
  REPLAY_REQUEST:        { TYPE: "replay-request" },
  MOD_ACTION_PROPOSALS:  { TYPE: "mod-action-proposals" },
  BOARD_INFO_REQUEST:    { TYPE: "board-info-request" },
  SHUFFLE_PROPOSAL:      { TYPE: "shuffle-proposal" },
  CREATE_BOARD:          { TYPE: "create-board" }
};

// Server → Client
MESSAGES.SERVER_TO_CLIENT = {
  BOARD_CREATED:    { TYPE: "board-created" },
  BOARD_REGISTERED: { TYPE: "board-registered" },
  PAGE_REGISTERED:  { TYPE: "page-registered" },
  FULL_PAGE:        { TYPE: "full-page" },
  PAGE_INFO:        { TYPE: "page-info" },
  PAGE_LOST:        { TYPE: "page-lost" },
  REPLAY:           { TYPE: "replay" },
  ACCEPT:           { TYPE: "accept" },
  DECLINE:          { TYPE: "decline" },
  PING:             { TYPE: "ping" },
  BOARD_INFO:       { TYPE: "board-info" }
};
```

## Appendix B: Validation

All message types have corresponding validation functions in `shared.js`:

```javascript
is_invalid_REGISTER_BOARD_message(data)
is_invalid_REGISTER_PAGE_message(data)
is_invalid_PAGE_INFO_REQUEST_message(data)
is_invalid_CREATE_BOARD_message(data)
is_invalid_FULL_PAGE_REQUEST_message(data)
is_invalid_REPLAY_REQUEST_message(data)
is_invalid_MOD_ACTION_PROPOSALS_message(data)
is_invalid_BOARD_INFO_REQUEST_message(data)
is_invalid_SHUFFLE_PROPOSAL_message(data)
```

Each validation function checks:
- Data is a non-null object
- UUID fields are valid UUIDs
- Numeric fields are finite numbers
- Required fields are present

Invalid messages are silently dropped.

---

## Appendix C: Error Codes

Server may return DECLINE with reasons:

- `"unauthorized"` - Invalid or missing board password
- `"cannot apply action to current visual state"` - Element already hidden/shown
- `"can only undo the immediate past"` - Undo target mismatch
- `"can only redo the immediate future"` - Redo target mismatch
- `"unknown action type"` - Invalid action.type
- `"Server error: ..."` - Internal server error

---

## Changelog

### Version 3.0 (May 2026)
- Added `board-info-request` / `board-info` messages for page order synchronization
- Added `shuffle-proposal` message for collaborative page reordering
- Added `new-page` and `delete-page` action types for page management
- Added `snapshots` field to `ping` message for efficient hash-chain verification
- Added overview mode protocol description
- Added board states and page management protocol sections
- Added deletion map documentation

### Version 2.0 (April 2026)
- Added comprehensive validation layer
- Introduced `SWITCH`/`do-move` flag for client state management
- Fixed boardId validation consistency
- Removed stack traces from error responses
- Added spaced snapshot system for efficient replay

### Version 1.0 (Initial)
- Basic drawing protocol
- Timeline-based state management with undo/redo
- Hash chain integrity verification

---

**Document End**

For questions or contributions, please refer to the project repository.