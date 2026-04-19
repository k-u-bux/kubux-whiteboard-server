# Kubux Whiteboard Protocol Documentation (v2)

**Version:** 2.0  
**Last Updated:** April 19, 2026  
**Status:** Production

---

## Table of Contents

1. [Overview](#overview)
2. [System Architecture](#system-architecture)
3. [Data Model](#data-model)
4. [Protocol Messages](#protocol-messages)
5. [Edit Operations](#edit-operations)
6. [Timeline Management](#timeline-management)
7. [Synchronization Model](#synchronization-model)
8. [Collaboration & Conflict Resolution](#collaboration--conflict-resolution)
9. [Page Management](#page-management)
10. [Security Model](#security-model)
11. [Implementation Guide](#implementation-guide)
12. [Use Cases](#use-cases)

---

## Overview

The Kubux Whiteboard Protocol is a **real-time collaborative drawing system** built on principles of **server-authoritative state management** and **content-addressable storage**. It enables multiple users to simultaneously draw, edit, and navigate shared whiteboard spaces with strong consistency guarantees.

### Key Design Principles

- **Server Authority**: Server is the single source of truth for all history
- **Linear History**: Actions form a timeline with a movable present pointer; new actions after undo create a branch (discarding future)
- **Content Addressing**: Hash chains ensure history integrity
- **Optimistic Concurrency**: Clients predict, server confirms
- **Graceful Degradation**: Automatic recovery from conflicts and failures
- **Privacy by Design**: UUID-based addressing prevents enumeration attacks

### Core Features

- ✏️ **Collaborative Drawing** with pressure-sensitive input
- 🔄 **Undo/Redo** with timeline branching (new actions after undo discard redo future)
- 📄 **Multi-Page Boards** like presentation slides
- 🔄 **Real-Time Sync** via WebSocket with incremental updates
- 🔐 **Two-Tier Authentication** (master + per-board passwords)
- 📊 **Event Replay** from any point in current timeline
- ✅ **Conflict Detection** via cryptographic hashing

---

## System Architecture

### Hierarchical Structure

```
Master Server
  └─ Board (UUID + Password)
      ├─ Page 1 (UUID)
      │   ├─ History: [action₀, action₁, ..., actionₙ]
      │   ├─ Present: n (timeline pointer)
      │   ├─ Hashes: [h₀, h₁, ..., hₙ]
      │   └─ Visual State: {visible elements}
      ├─ Page 2 (UUID)
      └─ Page 3 (UUID)
```

### Components

#### **Board**
- Unique identifier (UUID v4, cryptographically random)
- Board-specific password for edit access
- Ordered list of page UUIDs
- Independent workspace for collaboration

#### **Page**
- Unique identifier (UUID v4)
- **history**: Array of edit operations (mutable - can be truncated on branch)
- **present**: Integer pointer into history (for undo/redo)
- **hashes**: Array of content hashes (integrity verification; truncated with history)
- **state**: Current visual state (computed from history[0:present])

#### **Visual State**
```javascript
{
  element: Map<UUID, Element>,  // All drawn elements
  visible: Set<UUID>             // Currently visible element UUIDs
}
```

### State Management Model

Pages do not store "current state" directly. Instead:

1. **Edit Actions** are appended to history (or history truncated if branching)
2. **Present** pointer moves forward (new action) or backward (undo)
3. **Visual State** is computed on demand: `compileVisualState(history[0:present])`
4. **Hashes** form a chain: `hash[n] = hashNext(hash[n-1], action[n-1])`

**History Behavior**:
- **Undo/Redo**: Moves `present` pointer without modifying history
- **New action after undo**: Truncates history at `present`, then appends new action (redo future is lost)
- Server is authoritative - clients must sync to server's history

This enables:
- Linear timeline with branching on new actions after undo
- Replay from any point in current timeline
- Undo by pointer movement (non-destructive until branch)
- Cryptographic verification via hash chains

---

## Data Model

### Element Structure

Elements are stored as compact arrays for efficiency:

```javascript
[
  type,          // 0: "stroke" or "fill"
  path,          // 1: "opl" (open), "cpl" (closed), "obz", "cbz"
  points,        // 2: [[x,y,pressure,timestamp], ...]
  color,         // 3: "#RRGGBB" or CSS color
  width,         // 4: Stroke width in pixels
  transform,     // 5: [a,b,c,d,e,f] affine matrix
  opacity,       // 6: 0.0 to 1.0
  capStyle,      // 7: 0=round, 1=butt, 2=square
  joinStyle,     // 8: 0=round, 1=bevel, 2=miter
  dashPattern,   // 9: [0] for solid, [5,3] for dashed
  sensitivity,   // 10: Pressure sensitivity (0-1)
  layer,         // 11: Z-order layer number
  penType        // 12: 0=marker, 1=pencil, 2=brush
]
```

### Point Format

```javascript
[x, y, pressure, timestamp]
```

- **x, y**: Coordinates in canvas space
- **pressure**: 0.0 to 1.0 (stylus pressure)
- **timestamp**: Milliseconds since epoch

### Affine Transform

```javascript
[a, b, c, d, e, f]  // Represents matrix:
                     // [a c e]
                     // [b d f]
                     // [0 0 1]
```

Applies: `x' = ax + cy + e`, `y' = bx + dy + f`

---

## Protocol Messages

### Connection Flow

```
Client                          Server
  |                               |
  |--- WebSocket Connection ----->|
  |<----- Connection Accept ------|
  |                               |
  |--- CREATE_BOARD or ---------->|
  |    REGISTER_BOARD             |
  |<----- BOARD_CREATED or -------|
  |       BOARD_REGISTERED        |
  |                               |
  |--- REGISTER_PAGE ------------->|
  |<----- PAGE_REGISTERED --------|
  |                               |
  |<===== PING (periodic) ========|
  |                               |
  |--- MOD_ACTION_PROPOSALS ------>|
  |<----- ACCEPT or DECLINE ------|
  |<=== ACCEPT (broadcast) =======|
```

### CLIENT_TO_SERVER Messages

#### 1. CREATE_BOARD

Creates a new board (requires master password).

```javascript
{
  type: "create-board",
  clientId: "client-uuid",
  passwd: "master-password",
  requestId: "request-uuid"
}
```

**Response**: `BOARD_CREATED`

#### 2. REGISTER_BOARD

Join an existing board.

```javascript
{
  type: "register-board",
  "board-uuid": "board-uuid",
  clientId: "client-uuid",
  requestId: "request-uuid"
}
```

**Response**: `BOARD_REGISTERED`

#### 3. REGISTER_PAGE

Subscribe to a specific page.

```javascript
{
  type: "register-page",
  "board-uuid": "board-uuid",
  "page-uuid": "page-uuid",
  delta: 0,  // Offset: 0=current, +1=next, -1=prev
  clientId: "client-uuid",
  requestId: "request-uuid"
}
```

**Response**: `PAGE_REGISTERED`

#### 4. PAGE_INFO_REQUEST

Request page metadata without full history.

```javascript
{
  type: "page-info-request",
  "board-uuid": "board-uuid",
  "page-uuid": "page-uuid",
  delta: 0,
  register: false,  // Update client's page subscription?
  requestId: "request-uuid"
}
```

**Response**: `PAGE_INFO`

#### 5. FULL_PAGE_REQUESTS

Request complete page history.

```javascript
{
  type: "fullPage-requests",
  "board-uuid": "board-uuid",
  "page-uuid": "page-uuid",
  delta: 0,
  register: true,
  requestId: "request-uuid"
}
```

**Response**: `FULL_PAGE` or `PAGE_LOST`

#### 6. MOD_ACTION_PROPOSALS

Submit an edit action (requires board password).

```javascript
{
  type: "mod-action-proposals",
  passwd: "board-password",
  "page-uuid": "page-uuid",
  payload: {
    uuid: "action-uuid",
    type: "draw" | "erase" | "group" | "undo" | "redo" | "new page" | "delete page",
    // ... action-specific fields
  },
  "before-hash": "expected-hash-before-action"
}
```

**Response**: `ACCEPT` or `DECLINE`

#### 7. REPLAY_REQUESTS

Request actions since a specific point.

```javascript
{
  type: "replay-requests",
  "board-uuid": "board-uuid",
  "page-uuid": "page-uuid",
  present: 42,  // Client's current position
  "present-hash": "hash-at-42",
  register: false,
  requestId: "request-uuid"
}
```

**Response**: `REPLAY` or `PAGE_INFO` (if hash mismatch)

---

### SERVER_TO_CLIENT Messages

#### 1. BOARD_CREATED

Confirmation of new board creation.

```javascript
{
  type: "board-created",
  "board-uuid": "new-board-uuid",
  passwd: "generated-board-password",
  "first-page-uuid": "page-uuid",
  requestId: "request-uuid"
}
```

#### 2. BOARD_REGISTERED

Confirmation of board subscription.

```javascript
{
  type: "board-registered",
  "board-uuid": "board-uuid",
  "first-page-uuid": "page-uuid",
  "last-page-uuid": "page-uuid",
  totalPages: 5,
  requestId: "request-uuid"
}
```

#### 3. PAGE_REGISTERED

Confirmation of page subscription.

```javascript
{
  type: "page-registered",
  "page-uuid": "page-uuid",
  hash: "current-hash",
  snapshots: ["hash-at-1", "hash-at-2", "hash-at-4", ...],
  pageNr: 2,
  totalPages: 5,
  requestId: "request-uuid"
}
```

#### 4. PAGE_INFO

Page metadata without full history.

```javascript
{
  type: "page-info",
  "page-uuid": "page-uuid",
  hash: "current-hash",
  snapshots: ["hash-1", "hash-2", ...],
  pageNr: 2,
  totalPages: 5,
  "do-move": false,
  requestId: "request-uuid"
}
```

#### 5. PAGE_LOST

Requested page was deleted.

```javascript
{
  type: "page-lost",
  "lost-uuid": "deleted-page-uuid",
  "page-uuid": "replacement-page-uuid",
  pageNr: 1,
  totalPages: 4,
  "do-move": true,
  requestId: "request-uuid"
}
```

#### 6. FULL_PAGE

Complete page history.

```javascript
{
  type: "fullPage",
  "page-uuid": "page-uuid",
  history: [action0, action1, ..., actionN],
  present: 42,
  hash: "hash-at-present",
  pageNr: 2,
  totalPages: 5,
  "do-move": true
}
```

#### 7. ACCEPT

Action accepted and applied.

```javascript
{
  type: "accept",
  "page-uuid": "page-uuid",
  "action-index": 42,
  "action-uuid": "action-uuid",
  "before-hash": "hash-before",
  "after-hash": "hash-after",
  pageNr: 2,
  totalPages: 5
}
```

**Note**: Broadcast to all clients on the board.

#### 8. DECLINE

Action rejected.

```javascript
{
  type: "decline",
  "page-uuid": "page-uuid",
  "action-uuid": "action-uuid",
  reason: "unauthorized" | "cannot apply action to current visual state" | ...
}
```

#### 9. REPLAY

Action sequence from requested point.

```javascript
{
  type: "replay",
  "page-uuid": "page-uuid",
  beforeHash: "hash-at-start",
  afterHash: "hash-at-end",
  edits: [action42, action43, ...],
  present: 50,
  currentHash: "latest-hash",
  pageNr: 2,
  totalPages: 5,
  "do-move": false
}
```

#### 10. PING

Periodic heartbeat (every 5 seconds).

```javascript
{
  type: "ping",
  "page-uuid": "current-page-uuid",
  hash: "current-hash",
  pageNr: 2,
  totalPages: 5,
  snapshots: ["hash-1", "hash-2", ...]
}
```

---

## Edit Operations

### Action Types

All actions have:
- `uuid`: Unique identifier (UUID v4)
- `type`: Action type string

### DRAW

Add a new stroke to the page.

```javascript
{
  uuid: "action-uuid",
  type: "draw",
  stroke: [
    "stroke",                    // type
    "opl",                       // path (open piecewise linear)
    [[x1,y1,p1,t1], [x2,y2,p2,t2], ...],  // points
    "#000000",                   // color
    2.0,                         // width
    [1,0,0,1,0,0],              // transform (identity)
    1.0,                         // opacity
    0,                           // capStyle (round)
    0,                           // joinStyle (round)
    [0],                         // dashPattern (solid)
    1.0,                         // sensitivity
    1,                           // layer
    0                            // penType (marker)
  ]
}
```

**Semantics**:
1. **Truncate future**: Remove `history[present:]` and `hashes[present+1:]` (if any redo future exists)
2. Add element to visual state with key = `action.uuid`
3. Make element visible
4. Append action to history
5. Compute and append new hash: `hashNext(hashes[present], action)`
6. Advance `present` pointer to `history.length`

### ERASE

Hide an existing element (non-destructive).

```javascript
{
  uuid: "erase-action-uuid",
  type: "erase",
  targetActionUuid: "uuid-of-element-to-erase"
}
```

**Semantics**:
1. **Truncate future**: Remove `history[present:]` and `hashes[present+1:]` (if any redo future exists)
2. Remove `targetActionUuid` from visible set
3. Element remains in visual state (can be re-shown by undo)
4. Append action to history
5. Compute and append new hash
6. Advance `present` pointer

### GROUP

Batch multiple edit operations atomically.

```javascript
{
  uuid: "group-action-uuid",
  type: "group",
  actions: [
    { uuid: "...", type: "draw", ... },
    { uuid: "...", type: "erase", ... },
    ...
  ]
}
```

**Semantics**:
1. All sub-actions applied in sequence
2. If any sub-action fails, entire group reverted
3. Atomic: either all succeed or all fail

### UNDO

Revert the most recent action.

```javascript
{
  uuid: "undo-action-uuid",
  type: "undo",
  targetActionUuid: "uuid-of-action-to-undo"
}
```

**Semantics**:
1. Check: `history[present-1].uuid === targetActionUuid`
2. Revert the action at `history[present-1]`
3. Decrement `present` pointer
4. Hash remains unchanged (pointer moved, not data)

**Important**: Undo does NOT modify history. It only moves the pointer.

### REDO

Re-apply a previously undone action.

```javascript
{
  uuid: "redo-action-uuid",
  type: "redo",
  targetActionUuid: "uuid-of-action-to-redo"
}
```

**Semantics**:
1. Check: `history[present].uuid === targetActionUuid`
2. Re-apply the action at `history[present]`
3. Increment `present` pointer
4. Hash remains unchanged

### NEW_PAGE

Insert a new page after the current one.

```javascript
{
  uuid: "new-page-action-uuid",
  type: "new page"
}
```

**Semantics**:
1. Generate new page UUID
2. Create empty page
3. Insert into board's page order after current page
4. Broadcast to all clients
5. Send FULL_PAGE to requesting client

### DELETE_PAGE

Remove the current page.

```javascript
{
  uuid: "delete-page-action-uuid",
  type: "delete page"
}
```

**Semantics**:
1. Remove page from board's page order
2. Record deletion in `deletionMap: {deleted-uuid → replacement-uuid}`
3. Redirect clients to replacement page (next page, or new empty page)
4. Broadcast to all clients

---

## Timeline Management

### History Timeline

The server maintains a linear timeline of actions with a movable "present" pointer:

```
history: [a₀, a₁, a₂, a₃, a₄, a₅]
hashes:  [h₀, h₁, h₂, h₃, h₄, h₅]
                      ↑
                   present = 3

Visual State = compile(history[0:3])
             = apply(a₀, apply(a₁, apply(a₂, emptyState)))
```

### Undo Operation (Non-Destructive)

Undo moves the `present` pointer backward without modifying history:

```
Before:  history: [a₀, a₁, a₂, a₃, a₄]
         hashes:  [h₀, h₁, h₂, h₃, h₄]
                               ↑ present=3

After:   history: [a₀, a₁, a₂, a₃, a₄]  (unchanged)
         hashes:  [h₀, h₁, h₂, h₃, h₄]  (unchanged)
                            ↑ present=2
```

Visual state recomputed from `history[0:2]`. Actions `a₃, a₄` remain in history and can be redone.

### Redo Operation (Non-Destructive)

Redo moves the `present` pointer forward without modifying history:

```
Before:  history: [a₀, a₁, a₂, a₃, a₄]
         hashes:  [h₀, h₁, h₂, h₃, h₄]
                            ↑ present=2

After:   history: [a₀, a₁, a₂, a₃, a₄]  (unchanged)
         hashes:  [h₀, h₁, h₂, h₃, h₄]  (unchanged)
                               ↑ present=3
```

Visual state includes actions through `a₃`.

### New Action After Undo (Destructive - Creates Branch)

When a new edit action is submitted after undo, **the server truncates history**:

```
Before:  history: [a₀, a₁, a₂, a₃, a₄]
         hashes:  [h₀, h₁, h₂, h₃, h₄]
                            ↑ present=2

Server receives new DRAW action a₅:

After:   history: [a₀, a₁, a₂, a₅]  (a₃, a₄ discarded)
         hashes:  [h₀, h₁, h₂, h₅]  (h₃, h₄ discarded)
                               ↑ present=3
```

**Critical**: Actions `a₃, a₄` are permanently lost. The "redo future" is destroyed when branching occurs. This is **server-authoritative** - clients cannot preserve their own redo branches.

### Hash Chain Verification

```
hashes[0] = hashAny(pageId)
hashes[1] = hashNext(hashes[0], history[0])
hashes[2] = hashNext(hashes[1], history[1])
hashes[3] = hashNext(hashes[2], history[2])
...
```

Clients can verify integrity:
1. Receive `history[0:N]` and `hashes[N]`
2. Compute `expected = hashNext(hashNext(...hashNext(hash[0], h[0]), h[1])..., h[N-1])`
3. Assert `expected === hashes[N]`

---

## Synchronization Model

### Initial Sync

```sequence
Client                          Server
  |--- REGISTER_BOARD ---------->|
  |<----- BOARD_REGISTERED ------|
  |                               |
  |--- FULL_PAGE_REQUESTS ------->|
  |<----- FULL_PAGE --------------|
  |                               |
  | Download complete history    |
  | Verify hash chain            |
  | Compile visual state         |
  | Ready to draw                |
```

### Incremental Sync (Replay)

Client knows: `present=42, hash[42]="abc..."`

```sequence
Client                          Server
  |--- REPLAY_REQUESTS --------->|
  |    present=42                |
  |    hash="abc..."             |
  |                               |
  |<----- REPLAY -----------------|
  |    edits=[a₄₂, a₄₃, ..., a₅₀]|
  |    present=50                |
  |    hash="xyz..."             |
  |                               |
  | Apply edits[42:50]           |
  | Verify hash=xyz              |
```

If hash mismatch: Server sends `PAGE_INFO`, client re-syncs.

### Spaced Snapshots

To enable efficient catch-up, server provides snapshots at:

```
Indices: 1, 2, 4, 8, 16, 32, 64, 128, ...
```

(Powers of 2 below current present)

Client can:
1. Binary search for closest snapshot
2. Request `REPLAY` from that point
3. Reduce bandwidth vs. full history download

---

## Collaboration & Conflict Resolution

### Optimistic Concurrency

1. Client applies action locally (optimistic)
2. Client sends `MOD_ACTION_PROPOSALS` with `before-hash`
3. Server checks: `page.hashes[present] === before-hash`
   - **Match**: Accept, broadcast to others
   - **Mismatch**: Decline (concurrent edit conflict)
4. On DECLINE, client requests `REPLAY` to re-sync

### Conflict Example

```
Initial:  Both clients at present=10, hash="abc"

Client A:                       Client B:
  Draw action a₁₁                 Draw action b₁₁
  (locally present=11)            (locally present=11)
  
  Send PROPOSE(a₁₁, "abc") -----→ Server
                                  Accept a₁₁
                                  present=11, hash="def"
                                  Broadcast ACCEPT
                          ←------ ACCEPT(a₁₁)
  
                                  Send PROPOSE(b₁₁, "abc")
                          ←------ DECLINE (hash mismatch)
  Request REPLAY(10, "abc")
                          ←------ REPLAY([a₁₁])
  Apply a₁₁, recompute
  Now at present=11, hash="def"
  
  Re-send PROPOSE(b₁₁, "def") --→ Server
                                  Accept b₁₁
                          ←------ ACCEPT(b₁₁)
```

### Eventual Consistency

- All clients eventually see same history in same order
- Hash chain guarantees integrity
- Last-write-wins semantics (first to reach server wins)

---

## Page Management

### Navigation

```javascript
// Next page
REGISTER_PAGE { pageId: currentPageId, delta: +1 }

// Previous page
REGISTER_PAGE { pageId: currentPageId, delta: -1 }

// Specific page
REGISTER_PAGE { pageId: targetPageId, delta: 0 }
```

### Page Deletion

When page P is deleted:

1. Server removes P from board's page order
2. Server creates `deletionMap[P] = R` (R = replacement)
3. Future requests for P redirected to R
4. All clients receive `PAGE_LOST` message

### Deletion Chain Following

```
Client requests page A (deleted)
  → deletionMap[A] = B
  → B still in board → return B

Client requests page A (deleted)
  → deletionMap[A] = B
  → B deleted too
  → deletionMap[B] = C
  → C still in board → return C
```

Server follows chain until finding existing page.

---

## Security Model

### Two-Tier Authentication

#### **Tier 1: Master Password**
- Required to create new boards
- Stored as scrypt hash
- Parameters: N=16384, r=8, p=1 (memory-hard, GPU-resistant)

#### **Tier 2: Board Password**
- Generated automatically per board (12 chars, base36)
- Required for edit operations (`MOD_ACTION_PROPOSALS`)
- Anyone with board password can edit
- Read-only access without password (via board UUID)

### Access Control Matrix

| Operation | Board UUID | Board Password | Master Password |
|-----------|-----------|----------------|-----------------|
| View      | ✓         | -              | -               |
| Register  | ✓         | -              | -               |
| Navigate  | ✓         | -              | -               |
| Edit      | ✓         | ✓              | -               |
| Create    | -         | -              | ✓               |

### Anti-Enumeration

- All IDs are UUID v4 (2¹²² possible values)
- No sequential IDs
- No directory listing
- Failed auth gives no information

### Integrity Verification

- Hash chain prevents history tampering
- Clients can verify received data
- Server cannot forge history without detection

---

## Implementation Guide

### Client Implementation Checklist

1. **Connection**
   - [ ] WebSocket connect to `/ws`
   - [ ] Handle connection errors
   - [ ] Implement reconnection logic

2. **Board Management**
   - [ ] CREATE_BOARD or REGISTER_BOARD
   - [ ] Store board UUID + password
   - [ ] Handle BOARD_CREATED / BOARD_REGISTERED

3. **Page Subscription**
   - [ ] REGISTER_PAGE on initial load
   - [ ] Handle PAGE_REGISTERED
   - [ ] Handle PAGE_LOST (redirect logic)

4. **Drawing**
   - [ ] Capture input (mouse/touch/stylus)
   - [ ] Build stroke with points
   - [ ] Generate action UUID
   - [ ] Send MOD_ACTION_PROPOSALS

5. **Syncing**
   - [ ] Handle ACCEPT (apply to local state)
   - [ ] Handle DECLINE (request REPLAY)
   - [ ] Implement REPLAY handler
   - [ ] Verify hash chains

6. **Undo/Redo**
   - [ ] Track local present pointer
   - [ ] Send UNDO/REDO actions
   - [ ] Update UI on ACCEPT/DECLINE

7. **Navigation**
   - [ ] Prev/Next page buttons
   - [ ] Send REGISTER_PAGE with delta
   - [ ] Handle page number updates

8. **Heartbeat**
   - [ ] Handle PING messages
   - [ ] Update page info (hash, totals)
   - [ ] Detect if out of sync

### Server Implementation Notes

- Pages cached in memory (LRU, max 10)
- Boards cached in memory (LRU, max 10)
- Periodic persistence (every 10 seconds)
- Graceful shutdown (persist on SIGTERM/SIGINT)

### Performance Considerations

- **Hash computation**: O(n) where n = serialized size
- **History replay**: O(m) where m = number of actions
- **Visual state compilation**: O(m × v) where v = visible elements
- **Broadcast**: O(c) where c = connected clients

---

## Use Cases

### Use Case 1: Solo Whiteboarding

```
1. User visits app
2. Click "New Board"
3. Enter master password
4. Receive board UUID + password
5. Draw freely
6. Share board UUID with others (optional)
```

### Use Case 2: Real-Time Collaboration

```
1. User A shares board UUID + password with User B
2. User B registers to board
3. Both users draw simultaneously
4. Actions broadcast in real-time
5. Conflicts resolved by server (first-write-wins)
6. Both users eventually see identical canvas
```

### Use Case 3: Presentation Mode

```
1. Teacher creates board with multiple pages
2. Teacher shares board UUID (without password)
3. Students register (read-only)
4. Teacher uses NEW_PAGE to add slides
5. Teacher uses delta navigation (+1/-1) to present
6. Students' views auto-update via PING
```

### Use Case 4: Version Recovery

```
1. User accidentally erases important drawing
2. User finds action UUID from history
3. User sends UNDO targeting that action
4. Drawing restored
5. OR: User requests REPLAY from earlier point
6. Rebuild canvas from known-good state
```

### Use Case 5: Offline Resilience

```
1. User drawing on mobile device
2. Connection drops
3. User continues drawing (actions queued)
4. Connection restored
5. Client requests REPLAY from last known hash
6. Client re-submits queued actions
7. System recovers gracefully
```

---

## Appendix A: Hash Algorithm

```javascript
function hashAny(data) {
    const mask = 0xffffffffffffffffffffffffffffffn;  // 120 bits
    const dataString = serialize(data);
    let hash = 0n;
    for (let i = 0; i < dataString.length; i++) {
        const char = dataString.charCodeAt(i);
        hash += BigInt(char);
        hash = (hash << 25n) - hash;  // Multiply by 2^25 - 1
        hash &= mask;
    }
    return hash.toString(32);  // Base-32 encoding
}

function hashNext(previousHash, newData) {
    return hashAny([previousHash, newData]);
}
```

Properties:
- **Deterministic**: Same input → same hash
- **Fast**: O(n) in string length
- **Collision-resistant**: 120-bit space (not cryptographic)
- **Chainable**: Hash depends on previous hash

---

## Appendix B: Message Validation

All messages validated before processing:

```javascript
is_invalid_XXX_message(data) {
  // Type checks
  if (!data || typeof data !== 'object') return true;
  
  // UUID validation
  if (!isUuid(data.boardId)) return true;
  
  // Numeric validation
  if (typeof data.delta !== 'number') return true;
  if (!Number.isFinite(data.delta)) return true;
  
  // Required field checks
  if (!data.requiredField) return true;
  
  return false;  // Valid
}
```

Invalid messages silently dropped.

---

## Appendix C: Stroke Styles

Predefined stroke templates:

```javascript
CHALK: {
  type: "stroke",
  width: 2.0,
  capStyle: BUTT,
  opacity: 1.0,
  sensitivity: 0  // No pressure variation
}

PEN: {
  type: "stroke",
  width: 2.0,
  capStyle: ROUND,
  sensitivity: 1.0  // Full pressure sensitivity
}

HIGHLIGHTER: {
  type: "stroke",
  width: 24,
  capStyle: SQUARE,
  opacity: 0.5,
  sensitivity: 0
}
```

---

## Appendix D: Error Codes

Server may return DECLINE with reasons:

- `"unauthorized"` - Invalid or missing board password
- `"cannot apply action to current visual state"` - Element already hidden/shown
- `"can only undo the immediate past"` - Undo target mismatch
- `"can only redo the immediate future"` - Redo target mismatch
- `"unknown action type"` - Invalid action.type
- `"Server error: ..."` - Internal server error

---

## Changelog

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
