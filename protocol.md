# Xournal++ Clone Protocol Documentation

## Overview

This document defines the communication protocol between clients and the server for the Xournal++ Clone collaborative whiteboard application. The protocol uses WebSockets for real-time communication and JSON for message formatting.

## Version History

- v1.0: Initial protocol definition
- v2.0: Updated to include boardId in message payloads rather than URL path
- v2.1: Added undo/redo functionality
- v3.0: Added group actions for atomic operations

## Server State

The server maintains the following state structures:

### Boards
- `board`: Collection of pages
  - `pageOrder`: Array of page UUIDs in display order
  - `pages`: Map of page UUID to page data

### Pages
- `page`: Single whiteboard page
  - `modActions`: Sequence of modification actions
  - `currentHash`: Current hash of the page state

### Mod Actions
- `modAction`: Single modification to a page
  - `actionUuid`: Unique identifier for the action
  - `payload`: Action data (stroke data, erase reference, etc.)
  - `hashes`: 
    - `beforeHash`: Hash of the page state before this action
    - `afterHash`: Hash of the page state after this action

### Page Deletion Mapping
- `deletionMap`: Maps deleted page UUIDs to their replacement page UUIDs
  - If page A is deleted, there's always a replacement page A'
  - The map tracks A → A' → A'' → ... 
  - Used when a client references a deleted page

### Client Tracking
- `clients`: Maps client IDs to WebSocket instances
- Each WebSocket connection maintains:
  - `boardId`: Current board the client is viewing
  - `pageId`: Current page the client is viewing
  - `clientId`: Unique identifier for the client (optional)

## Client State

The client maintains:

- `boardId`: Identifier of the current board (persists across sessions)
- `currentPageUuid`: UUID of the current page being viewed
- `verifiedHash`: Hash of the most recent verified page state
  - "Verified" means the client has a history of mod-actions for this hash
  - And has seen it as a result hash in a server message
- `verifiedModActions`: Sequence of mod-actions verified by the server
- `optimisticUpdates`: Locally applied actions not yet confirmed by the server
  - Visual representation shows both verified and optimistic actions
  - Verified state is used as the starting point for replay updates
- `pageNr`: Current page position in the board
- `totalPages`: Total number of pages in the board

## Protocol Messages

### Connection Establishment

1. Client establishes WebSocket connection to `/ws` (without boardId in path)
2. Client sends a registration message to identify the board

```json
{
  "type": "register-board",
  "boardId": "017fead5-a5b2-4cd8-b6db-72845434226a",
  "clientId": "unique-client-id",
  "requestId": "request-uuid"
}
```

3. Server responds with registration acknowledgment

```json
{
  "type": "board-registered",
  "boardId": "017fead5-a5b2-4cd8-b6db-72845434226a",
  "initialPageId": "57b4a5c9-2af2-478e-b71e-a0ba74786aa0",
  "totalPages": 3,
  "requestId": "request-uuid"
}
```

4. Server follows up with a `fullPage` message for the initial page

### Server to Client Messages

All server-to-client messages now include `boardId` in their payload.

#### Full Page Message
```json
{
  "type": "fullPage",
  "boardId": "board-uuid",
  "page": "page-uuid",
  "state": [array-of-mod-actions],
  "hash": "hash-of-page-state",
  "pageNr": 1,
  "totalPages": 3
}
```

#### Replay Message
```json
{
  "type": "replay-message",
  "boardId": "board-uuid",
  "page-uuid": "page-uuid",
  "before-hash": "hash-value",
  "after-hash": "hash-value",
  "sequence": [array-of-mod-actions],
  "current page-nr in its board": 1,
  "current #pages of the board": 3
}
```

#### Accept Message
```json
{
  "type": "accept-message",
  "boardId": "board-uuid",
  "page-uuid": "page-uuid",
  "action-uuid": "action-uuid",
  "before-hash": "hash-value",
  "after-hash": "hash-value",
  "current page-nr in its board": 1,
  "current #pages of the board": 3
}
```

#### Decline Message
```json
{
  "type": "decline-message",
  "boardId": "board-uuid",
  "page-uuid": "page-uuid",
  "action-uuid": "action-uuid",
  "reason": "optional reason for decline"
}
```

#### Ping Message
```json
{
  "type": "ping",
  "boardId": "board-uuid",
  "page-uuid": "page-uuid",
  "hash": "hash-of-page-state",
  "current page-nr in its board": 1,
  "current #pages of the board": 3
}
```

### Client to Server Messages

All client-to-server messages must include `boardId` in their payload.

#### Mod-Action Proposals
```json
{
  "type": "mod-action-proposals",
  "boardId": "board-uuid",
  "page-uuid": "page-uuid",
  "action-uuid": "action-uuid",
  "payload": {
    "type": "draw|erase|new page|delete page|undo|redo|group",
    ...action-specific-fields
  },
  "before-hash": "hash-value"
}
```

##### Draw Stroke Payload
```json
{
  "type": "draw",
  "stroke": {
    "points": [
      { "x": 100, "y": 200, "pressure": 0.5, "timestamp": 1624287487000 },
      ...more-points
    ],
    "style": {
      "penType": "marker|pencil|highlighter|brush",
      "color": "#000000",
      "opacity": 1.0,
      "width": 2.0,
      ...more-style-properties
    }
  }
}
```

##### Erase Stroke Payload
```json
{
  "type": "erase",
  "actionUuid": "uuid-of-stroke-to-erase"
}
```

##### New Page Payload
```json
{
  "type": "new page"
}
```

##### Delete Page Payload
```json
{
  "type": "delete page"
}
```

##### Undo Action Payload
```json
{
  "type": "undo",
  "targetActionUuid": "uuid-of-action-to-undo",
  "clientId": "client-id-that-performed-original-action"
}
```

##### Redo Action Payload
```json
{
  "type": "redo",
  "targetUndoActionUuid": "uuid-of-undo-action-to-undo",
  "clientId": "client-id-that-performed-original-undo"
}
```

##### Group Action Payload
```json
{
  "type": "group",
  "actions": [
    {
      "actionUuid": "client-generated-uuid-1", 
      "payload": {
        "type": "draw",
        "stroke": {...}
      }
    },
    {
      "actionUuid": "client-generated-uuid-2",
      "payload": {
        "type": "erase",
        "actionUuid": "uuid-of-stroke-to-erase"
      }
    },
    // More actions...
  ]
}
```

#### Replay Requests
```json
{
  "type": "replay-requests",
  "boardId": "board-uuid",
  "page-uuid": "page-uuid",
  "before-hash": "hash-value",
  "requestId": "request-uuid"
}
```

#### Full Page Requests
```json
{
  "type": "fullPage-requests",
  "boardId": "board-uuid",
  "pageNumber": 2,
  "requestId": "request-uuid"
}
```

Alternative format:
```json
{
  "type": "fullPage-requests",
  "boardId": "board-uuid",
  "pageId": "page-uuid",
  "delta": 1,
  "requestId": "request-uuid"
}
```

## Implementation Notes

### Message Handling Strategy

The server implements a modular, router-based approach to message handling:

1. **Message Router**: A central function (`routeMessage`) that receives all incoming messages
2. **Handler Map**: Maps message types to their handler functions
3. **Dedicated Handler Functions**: Each message type has its own handler with specific logic
4. **Routing Process**: The router extracts the message type, looks up the appropriate handler, and executes it

Example handler map:
```javascript
const messageHandlers = {
  'register-board': handleBoardRegistration,
  'mod-action-proposals': handleModActionProposal,
  'replay-requests': handleReplayRequest,
  'fullPage-requests': handleFullPageRequest
};
```

### Mod-Action Handler Strategy

The server uses a strategy pattern for handling different action types:

```javascript
const actionStrategies = {
  'draw': { validate: validateDrawAction, ... },
  'erase': { validate: validateEraseAction, ... },
  'new page': { validate: validateNewPageAction, ... },
  'delete page': { validate: validateDeletePageAction, ... },
  'undo': { validate: validateUndoAction, ... },
  'redo': { validate: validateRedoAction, ... },
  'group': { validate: validateGroupAction, ... }
};
```

### Undo/Redo Implementation

The undo/redo functionality is implemented as regular mod-actions with special properties:

1. **Undo as a Mod-Action**: An undo is implemented as a special modification that references a previous action
2. **Redo as an Undo of an Undo**: A redo is implemented as an undo of a previous undo action
3. **Server Authority**: The server decides if an undo/redo is valid based on the current page state
4. **Action Tracking**: Clients track their own actions to populate the undo/redo UI

#### Undo/Redo Workflow

1. Client identifies an action to undo (typically the most recent action performed by that client)
2. Client sends an undo mod-action proposal referencing the target action
3. Server validates if the undo is possible in the current collaborative state
4. If valid, server applies the undo as a new mod-action and broadcasts to all clients
5. If invalid, server declines the undo with a reason
6. Clients update their UI based on the server's response

### Group Actions Implementation

Group actions allow multiple operations to be bundled and executed atomically:

1. **Atomic Processing**: All actions in the group succeed or fail together
2. **Client-Generated Action UUIDs**: The client creates unique IDs for each action in the group
3. **Single Accept Message**: Server sends one accept message for the whole group
4. **Consistent History**: Each action is individually recorded in the modification history
5. **Optimistic Updates**: Client can track and apply optimistic updates without requesting a replay

#### Group Action Workflow

1. Client bundles multiple actions into a group, each with its own client-generated UUID
2. Client sends a single mod-action proposal with the group
3. Server processes each action in sequence, maintaining the hash chain
4. If all actions succeed, server sends a single accept message for the group
5. If any action fails, server sends a decline message for the entire group
6. Client can reconcile its optimistic updates using the original action UUIDs

### Shared Code Implementation

A `shared.js` file is used by both client and server to ensure consistency in:

1. **Hash Computation**: Consistent algorithm for calculating page state hashes
2. **UUID Generation**: Standard function for creating unique identifiers
3. **Message Schemas**: Common structure definitions for all protocol messages
4. **Stroke Styles**: Standard definitions for pen types, cap styles, etc.

### Client-Side Implementation Guidelines

1. **No Server Strategy Assumptions**: The client should not make assumptions about server implementation details. For example, when receiving an accept-message, the client should not assume the before-hash matches what was sent in the proposal.

2. **Optimistic Updates**: The client should apply modifications locally before server confirmation but be prepared to reconcile differences if the server disagrees.

3. **Hash Reconciliation**: The client should maintain a clear distinction between verified state (confirmed by server) and optimistic updates.

4. **Undo/Redo UI**: The client should only show undo/redo options for actions performed by the current client.

5. **Group Actions**: For operations that should be atomic, the client should use group actions rather than individual sequential actions.

### Logging

For debugging purposes, the server performs comprehensive logging:

1. **Incoming Messages**: Log all received messages with their type and relevant payload
2. **Outgoing Messages**: Log all sent messages with a reference to the message they're responding to
3. **State Changes**: Log significant state changes such as page creation/deletion
4. **Errors**: Log all errors with context about what caused them

### Error Handling

1. **Invalid Messages**: When receiving malformed messages, the server responds with an error but maintains the connection
2. **Lost Connections**: Both client and server should handle reconnection gracefully
3. **State Synchronization**: When in doubt about state consistency, the client should request a full page or replay

## Protocol Advantages

1. **Decoupled WebSocket Connection**: The WebSocket URL is simplified with no implicit relationship between URL and boardId
2. **Explicit Board Identification**: Every message includes the boardId, making the protocol self-contained
3. **Better Connection Management**: Clients can switch between boards or reconnect to specific boards more easily
4. **Enhanced Error Handling**: More robust error messages for connection and registration issues
5. **Request Tracking**: Includes tracking of pending requests for better debugging and response matching
6. **Collaborative Undo/Redo**: Supports undo/redo functionality in a collaborative context
7. **Atomic Operations**: Group actions enable multiple operations to be processed atomically
8. **Efficient Communication**: Single accept message for groups reduces network traffic
9. **Consistent History**: Individual actions within groups are recorded for proper history tracking

## References

For implementation examples and best practices in collaborative editing:

- [The Hard Problem of Collaborative Undo-Redo](https://dev.to/isaachagoel/the-hard-problem-of-collaborative-undo-redo-482k) - Insights on undo/redo challenges in collaborative environments
- [Synchronized immutable state with time travel](https://dev.to/oleg008/synchronized-immutable-state-with-time-travel-2c6o) - Approaches to time travel and error handling in collaborative systems
