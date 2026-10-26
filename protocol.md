# Kubux Whiteboard Protocol

## Overview

This document describes the WebSocket-based communication protocol used by the Kubux Whiteboard Server. The protocol enables real-time collaborative drawing with support for multiple pages, undo/redo, and state synchronization.

The authoritative definitions are the `MESSAGES` and `MOD_ACTIONS` constants and the `is_invalid_*` validators in `shared.js`; the behaviour described here is that of the handlers in `server.js`. Field names below are the literal keys on the wire.

## Transport and Message Format

- The WebSocket endpoint is `/ws` (in direct mode the client is told the full `ws://…/ws` URL; behind the proxy it derives `wss://<host>/ws`).
- Every message is a plain JSON object with a `type` field. Wire messages are parsed with `JSON.parse` and written with `JSON.stringify` on both sides; Map, Set and BigInt never appear on the wire.
- The custom `serialize` / `deserialize` pair in `shared.js` (which encodes Set, Map and BigInt as `{"__type": …}` objects and indents by 2) is used only for the files on disk and as the input of the hash function.
- Most requests carry a `requestId` (a UUID). Responses that answer a request echo it under the same key, so the client can match them.
- The server closes connections that send a message larger than 5 MiB (`maxPayload`). Per-message deflate compression is enabled.

### How the server tracks a client

Each connection has a current board (`ws.boardId`) and a current page (`ws.pageId`). They decide which broadcasts and pings the connection receives. They are set by `register-board`, `register-page`, `board-info-request` with `register: true`, `page-info-request` / `full-page` request / `replay-requests` with `register: true`, `create-board`, and by the server itself when it redirects a client away from a deleted page (see `ping`).

The server keeps no login state. Owner messages (`create-board`, `list-boards`, `set-path`, `rename-prefix`, `change-credential`) each carry the owner's `login` and credential and are checked on their own (see *Owner messages*).

### Validation and rejection

- A message whose JSON cannot be parsed, or whose `type` has no handler, is answered with an `error` message.
- An owner message that is refused (credential not accepted, invalid path, …) is answered with an `error` message carrying the request's `requestId`.
- A message that fails its validator (`is_invalid_*` in `shared.js`) is dropped without a reply.
- A request that names an unknown board is dropped without a reply, except `register-board`, which is answered with an `error` message (`no such board`).

## Client → Server Messages

### `register-board`

Register the connection with a board. The connection's current page becomes the board's first page.

```json
{
  "type": "register-board",
  "board-uuid": "<board-uuid>",
  "clientId": "<client-uuid>",
  "requestId": "<request-uuid>"
}
```

- `board-uuid`: required, UUID.
- `clientId`: optional, UUID.

**Response:** `board-registered`, or `error` with message `no such board` (and the request's `requestId`) if the board does not exist.

---

### `register-page`

Register the connection with a page of a board.

```json
{
  "type": "register-page",
  "board-uuid": "<board-uuid>",
  "page-uuid": "<page-uuid>",
  "delta": <integer>,
  "clientId": "<client-uuid>",
  "requestId": "<request-uuid>"
}
```

The server first maps a deleted `page-uuid` to its replacement (see *Deletion Map*), then moves `delta` positions in the page order (+1 = next page, -1 = previous page), clamped to the first and last page. `delta` and `clientId` are optional.

**Response:** `page-registered`

---

### `page-info-request`

Request the hash and snapshots of a page (resolved like `register-page`).

```json
{
  "type": "page-info-request",
  "board-uuid": "<board-uuid>",
  "page-uuid": "<page-uuid>",
  "delta": <integer>,
  "register": <boolean>,
  "requestId": "<request-uuid>"
}
```

- `requestId`: required, UUID.
- `delta`, `register`: optional. If `register` is true, the connection's current page becomes the resolved page.

**Response:** `page-info` (for the resolved page; a deleted page is silently replaced, no `page-lost`).

---

### `fullPage-requests`

Request the complete state of a page (history + present position). The constant is `FULL_PAGE_REQUEST`; note the type string.

```json
{
  "type": "fullPage-requests",
  "board-uuid": "<board-uuid>",
  "page-uuid": "<page-uuid>",
  "delta": <integer>,
  "register": <boolean>,
  "requestId": "<request-uuid>"
}
```

All fields are required. The page is resolved like `register-page`.

**Response:**
- `page-lost` if `delta` is 0 and the requested page has been deleted;
- otherwise `fullPage` for the resolved page.

---

### `replay-requests`

Request the actions from a known position of the page's hash chain onward. The constant is `REPLAY_REQUEST`; note the type string.

```json
{
  "type": "replay-requests",
  "board-uuid": "<board-uuid>",
  "page-uuid": "<page-uuid>",
  "present": <integer>,
  "present-hash": "<hash-string>",
  "register": <boolean>,
  "requestId": "<request-uuid>"
}
```

All fields are required; `present` is a non-negative integer. The client states a position `present` in the history and the hash it has there.

**Response:**
- `page-lost` if the page has been deleted;
- `page-info` if the server's hash at position `present` differs from `present-hash` (the client has to find another common position);
- otherwise `replay` with all history entries from `present` to the end of the history (including an undone tail) and the server's current `present`.

---

### `mod-action-proposals`

Propose a modification (draw, erase, group, undo, redo, new page, delete page).

```json
{
  "type": "mod-action-proposals",
  "passwd": "<board-password>",
  "board-uuid": "<board-uuid>",
  "page-uuid": "<page-uuid>",
  "payload": { <action-object> },
  "before-hash": "<hash-string>"
}
```

- `passwd`, `board-uuid`, `page-uuid`, `payload`: required. The payload is validated recursively (see *Action Types*).
- `before-hash`: optional string. The client sends the hash of its state before the action (`NULL_UUID` for page actions). **The server does not check it**: draw, erase and group actions are applied to whatever state the server has, and are declined only if they cannot be applied there.
- There is no `requestId` key; the server uses `requestId`, then `action-uuid`, if present (otherwise `"N/A"`), for logging and as the `requestId` of the responses to page actions.

**Responses:**
- `decline` with reason `unauthorized` if `passwd` does not match the board password;
- `decline` with reason `page not on board` if `page-uuid` is not in the board's page order;
- draw / erase / group / undo / redo: `accept` (or `decline`) to the proposer, and on acceptance a `replay` broadcast to every *other* connection registered with the board (see *Action Broadcast*);
- new page / delete page: see *Page Management Protocol*. No `accept` is sent.

---

### `board-info-request`

Request the current page order of a board.

```json
{
  "type": "board-info-request",
  "board-uuid": "<board-uuid>",
  "register": <boolean>,
  "requestId": "<request-uuid>"
}
```

- `requestId`: required, UUID.
- `register`: optional. If true, the connection is registered with the board and its current page becomes the board's first page.

**Response:** `board-info`

---

### `shuffle-proposal`

Propose a reordering of the pages of a board.

```json
{
  "type": "shuffle-proposal",
  "board-uuid": "<board-uuid>",
  "passwd": "<board-password>",
  "before": ["<page-uuid>", ...],
  "after": ["<page-uuid>", ...],
  "requestId": "<request-uuid>"
}
```

The proposal is dropped unless the connection is registered with `board-uuid`. The server then checks:
1. `passwd` matches the board password;
2. `before` equals the current server-side page order (sync check);
3. `after` has the same length and the same set of UUIDs as `before`.

**Response:**
- on success, the new order is saved and a `board-info` is broadcast to all connections registered with the board (including the proposer);
- on any failed check, a `board-info` with the unchanged order is sent to the proposer only.

---

### Owner messages

The following messages are for owners: users with an entry in `conf/users.json`. Each carries the owner's login and credential:

```json
{
  "login": "<login>",
  "passwd": "<credential>",
  "requestId": "<request-uuid>"
}
```

- `login`: 1 to 64 characters; `passwd`: 1 to 1024 characters; `requestId`: required.
- **Each message is checked on its own.** The server keeps no login state: the credential is checked with scrypt against the hash of that login in `conf/users.json` for every owner message. An unknown login costs one scrypt as well, and gets the same answer as a wrong credential.
- **One check per connection at a time.** An owner message that arrives while another one's check is still running on the same connection is refused with `a credential is already being checked`; clients send owner messages one after the other.
- The action runs once the check has succeeded, against the boards as they are at that moment.
- Refusals common to all owner messages: `error` with message `credential not accepted` or `a credential is already being checked`.

---

### `change-credential`

Change the owner's credential.

```json
{
  "type": "change-credential",
  "login": "<login>",
  "passwd": "<current credential>",
  "new-passwd": "<new credential>",
  "requestId": "<request-uuid>"
}
```

The server reads `conf/users.json` again, replaces this user's hash with the hash of the new credential, and writes the file back atomically, with mode 600 (readable and writable by the server's user only). Everything else in the file stays as it is on disk; id and login stay.

**Response:** `credential-changed`, or `error` with message `credential could not be saved` (the user file could not be read, is invalid, no longer holds the user, or could not be written; nothing is written then, and the old credential stays valid).

---

### `create-board`

Create a new board owned by the sender.

```json
{
  "type": "create-board",
  "login": "<login>",
  "passwd": "<credential>",
  "path": "<path>",
  "clientId": "<client-uuid>",
  "requestId": "<request-uuid>"
}
```

`path` names the board for its owner (see *Users, Owners and Paths*); the server normalizes it.

**Response:**
- on success: `board-created`, followed by a `fullPage` of the board's first (empty) page with `do-move: true`; the connection is registered with the new board;
- `error` with message `invalid path` or `path taken`.

---

### `list-boards`

List the sender's boards.

```json
{
  "type": "list-boards",
  "login": "<login>",
  "passwd": "<credential>",
  "requestId": "<request-uuid>"
}
```

**Response:** `board-list`. A client can use this message to check a login and credential.

---

### `set-path`

Rename or move one of the sender's boards.

```json
{
  "type": "set-path",
  "login": "<login>",
  "passwd": "<credential>",
  "board-uuid": "<board-uuid>",
  "path": "<new path>",
  "requestId": "<request-uuid>"
}
```

**Response:** `board-list` with the updated list, or `error` with message `not your board` (also for an unknown board), `invalid path`, or `path taken`.

---

### `rename-prefix`

Rename or move a folder of the sender: every board whose path lies below `from` gets `to` in place of `from`.

```json
{
  "type": "rename-prefix",
  "login": "<login>",
  "passwd": "<credential>",
  "from": "<folder path>",
  "to": "<new folder path>",
  "requestId": "<request-uuid>"
}
```

Moving a folder onto an existing folder merges the two if no path collides.

**Response:** `board-list` with the updated list, or `error` with message `invalid path` (also if a new path would be too long), `no such folder`, `path taken`, or `rename cannot be written safely` (no write order keeps the disk consistent; see *Writing Path Changes*).

---

## Server → Client Messages

### `board-created`

```json
{
  "type": "board-created",
  "board-uuid": "<new-board-uuid>",
  "passwd": "<new-board-password>",
  "first-page-uuid": "<page-uuid>",
  "requestId": "<request-uuid>"
}
```

- `passwd`: the board's edit password (12 characters, `0-9a-z`).
- `first-page-uuid`: the board's initial (empty) page.

---

### `credential-changed`

Answer to a successful `change-credential`.

```json
{
  "type": "credential-changed",
  "requestId": "<request-uuid>"
}
```

---

### `board-list`

The sender's boards, sorted by path. Answer to `list-boards`, `set-path` and `rename-prefix`.

```json
{
  "type": "board-list",
  "boards": [
    { "board-uuid": "<board-uuid>", "path": "<path>", "passwd": "<edit password>", "createdAt": <unix time in ms> },
    ...
  ],
  "requestId": "<request-uuid>"
}
```

The edit password lets the owner open each board with edit rights.

A `board-list` is a snapshot for the request it answers. Other sessions of the same owner are not told about creations or path changes; their board manager shows the old list until it asks again. Requests based on an old list are still checked against the current paths.

---

### `board-registered`

```json
{
  "type": "board-registered",
  "board-uuid": "<board-uuid>",
  "first-page-uuid": "<page-uuid>",
  "last-page-uuid": "<page-uuid>",
  "totalPages": <integer>,
  "requestId": "<request-uuid>"
}
```

---

### `page-registered`

```json
{
  "type": "page-registered",
  "page-uuid": "<page-uuid>",
  "hash": "<hash-string>",
  "snapshots": ["<hash-string>", ...],
  "pageNr": <integer>,
  "totalPages": <integer>,
  "requestId": "<request-uuid>"
}
```

`page-uuid` is the resolved page, which differs from the requested one after a redirect or a non-zero `delta`.

---

### `fullPage`

The complete state of a page. The constant is `FULL_PAGE`; note the type string.

```json
{
  "type": "fullPage",
  "page-uuid": "<page-uuid>",
  "history": [<action>, ...],
  "present": <integer>,
  "hash": "<hash-string>",
  "pageNr": <integer>,
  "totalPages": <integer>,
  "do-move": <boolean>,
  "requestId": "<request-uuid>"
}
```

- `history`: all actions of the page, including an undone tail beyond `present`.
- `present`: number of history entries currently in effect (undo/redo position).
- `hash`: the hash chain value at `present`.
- `do-move`: if true, the client should switch to this page (the server has already made it the connection's current page).

---

### `page-info`

The hash and snapshots of a page.

```json
{
  "type": "page-info",
  "page-uuid": "<page-uuid>",
  "hash": "<hash-string>",
  "snapshots": ["<hash-string>", ...],
  "pageNr": <integer>,
  "totalPages": <integer>,
  "do-move": <boolean>,
  "requestId": "<request-uuid>"
}
```

`hash` is the chain value at the page's `present`; `snapshots` is described under *Snapshots*.

---

### `page-lost`

The requested page has been deleted; `page-uuid` is its replacement.

```json
{
  "type": "page-lost",
  "lost-uuid": "<deleted-page-uuid>",
  "page-uuid": "<replacement-page-uuid>",
  "pageNr": <integer>,
  "totalPages": <integer>,
  "do-move": <boolean>,
  "requestId": "<request-uuid>"
}
```

---

### `replay`

A run of history entries starting at a position of the hash chain.

```json
{
  "type": "replay",
  "page-uuid": "<page-uuid>",
  "beforeHash": "<hash-string>",
  "afterHash": "<hash-string>",
  "edits": [<action>, ...],
  "present": <integer>,
  "currentHash": "<hash-string>",
  "pageNr": <integer>,
  "totalPages": <integer>,
  "do-move": <boolean>,
  "requestId": "<request-uuid>"
}
```

- `beforeHash`: chain value just before the first entry of `edits`.
- `afterHash`: in a reply to `replay-requests`, the value at the server's `present`; in an action broadcast, the value at the end of the history.
- `present` / `currentHash`: the server's present position and the chain value there.
- In an action broadcast, `requestId` is the UUID of the accepted action and `do-move` is false.

---

### `accept`

Sent to the proposer when a draw, erase, group, undo or redo action is accepted.

```json
{
  "type": "accept",
  "page-uuid": "<page-uuid>",
  "action-index": <integer>,
  "action-uuid": "<action-uuid>",
  "before-hash": "<hash-string>",
  "after-hash": "<hash-string>",
  "pageNr": <integer>,
  "totalPages": <integer>
}
```

`action-index` is `present - 1` after the action; `before-hash` and `after-hash` are the chain values at `present - 1` and `present`. There is no `requestId`; the client matches on `action-uuid`.

---

### `decline`

Sent to the proposer when a proposal is refused.

```json
{
  "type": "decline",
  "page-uuid": "<page-uuid>",
  "action-uuid": "<action-uuid>",
  "reason": "<string>"
}
```

See *Appendix C* for the reasons.

---

### `ping`

Sent every 5 seconds to every open connection that has a current board and page.

```json
{
  "type": "ping",
  "page-uuid": "<page-uuid>",
  "hash": "<hash-string>",
  "pageNr": <integer>,
  "totalPages": <integer>,
  "snapshots": ["<hash-string>", ...]
}
```

Before sending, the server maps the connection's current page through the deletion map, so a client whose page was deleted is moved to the replacement and receives a ping for it. Pings are also sent to all connections on a board right after a page was added or deleted. There is no `requestId`.

---

### `board-info`

The current page order of a board.

```json
{
  "type": "board-info",
  "board-uuid": "<board-uuid>",
  "pages": ["<page-uuid>", ...],
  "requestId": "<request-uuid>"
}
```

Sent:
- in response to `board-info-request`;
- in response to a `shuffle-proposal` (broadcast on success, to the proposer only on failure);
- broadcast to the board after a page was added or deleted;
- every 5 seconds to every open connection with a current board, with `requestId` set to `NULL_UUID`.

---

### `error`

Sent when a message is rejected before reaching a handler, when an owner message is refused, and when `register-board` names an unknown board.

```json
{
  "type": "error",
  "message": "<string>",
  "requestId": "<request-uuid>"
}
```

`requestId` is present for refused requests. `message` is one of:
- the `JSON.parse` error text, or `Unhandled message type: <type>` (no `requestId`);
- `credential not accepted`, `a credential is already being checked`, `credential could not be saved`;
- `invalid path`, `path taken`, `not your board`, `no such folder`, `rename cannot be written safely`;
- `no such board` (to `register-board`).

---

## Action Types

Actions are the units of modification. Each action has a `uuid` (string) and a `type` (string). The type strings are:

| Constant | `type` |
|---|---|
| `MOD_ACTIONS.DRAW` | `draw` |
| `MOD_ACTIONS.ERASE` | `erase` |
| `MOD_ACTIONS.GROUP` | `group` |
| `MOD_ACTIONS.UNDO` | `undo` |
| `MOD_ACTIONS.REDO` | `redo` |
| `MOD_ACTIONS.NEW_PAGE` | `new page` |
| `MOD_ACTIONS.DELETE_PAGE` | `delete page` |

Draw, erase and group are *edit* actions: they enter the page history. Undo and redo only move `present`. New page and delete page change the board's page order and never enter a history.

### `draw`

Add a stroke to the page.

```json
{
  "type": "draw",
  "uuid": "<action-uuid>",
  "stroke": <stroke-array>
}
```

The stroke becomes a visible element whose UUID is the draw action's `uuid`. Declined if an element with that UUID is already visible.

### `erase`

Hide an element.

```json
{
  "type": "erase",
  "uuid": "<action-uuid>",
  "targetActionUuid": "<uuid of the draw action>"
}
```

Elements are identified by the UUID of the draw action that created them (also when that draw is nested in a group). Declined if the element is not visible.

### `group`

Several edit actions applied atomically: if one of them cannot be applied, the state is rolled back and the whole group is declined.

```json
{
  "type": "group",
  "uuid": "<action-uuid>",
  "actions": [<action>, ...]
}
```

Sub-actions may only be `draw`, `erase` or `group`; nesting deeper than 10 levels (`MAX_GROUP_DEPTH`) fails validation. Used for operations like cut, move, layer change, paste and batch erase.

### `undo`

```json
{
  "type": "undo",
  "uuid": "<action-uuid>",
  "targetActionUuid": "<action-uuid>"
}
```

Accepted only if `targetActionUuid` is the UUID of the history entry just before `present` (the immediate past); `present` then decreases by one.

### `redo`

```json
{
  "type": "redo",
  "uuid": "<action-uuid>",
  "targetActionUuid": "<action-uuid>"
}
```

Accepted only if `targetActionUuid` is the UUID of the history entry at `present` (the immediate future); `present` then increases by one.

A new edit action discards the undone tail of the history beyond `present`.

### `new page`

```json
{
  "type": "new page",
  "uuid": "<action-uuid>"
}
```

Inserts a new empty page after the page named in the enclosing proposal. See *Page Management Protocol*.

### `delete page`

```json
{
  "type": "delete page",
  "uuid": "<action-uuid>"
}
```

Deletes the page named in the enclosing proposal. See *Page Management Protocol*.

---

## Stroke Structure

A stroke is a 13-element array indexed by the `ELEMENT` constants in `shared.js`:

| Index | `ELEMENT` | Content | Accepted values |
|---|---|---|---|
| 0 | `TYPE` | drawable type | `"stroke"` or `"fill"` |
| 1 | `PATH` | path kind | `"opl"`, `"cpl"`, `"obz"`, `"cbz"` (open/closed piecewise linear, open/closed Bézier) |
| 2 | `POINTS` | points | non-empty list of `[x, y, pressure]` or `[x, y, pressure, timestamp]`, finite numbers |
| 3 | `COLOR` | color | `#RGB`, `#RRGGBB`, or 1–20 lowercase letters (a color name) |
| 4 | `WIDTH` | width | finite number > 0 |
| 5 | `TRANSFORM` | affine transform `[a, b, c, d, e, f]` | 6 finite numbers |
| 6 | `OPACITY` | opacity | 0 … 1 |
| 7 | `CAP_STYLE` | cap style | 0 = round, 1 = butt, 2 = square |
| 8 | `JOIN_STYLE` | join style | 0 = round, 1 = bevel, 2 = miter |
| 9 | `DASH_PATTERN` | dash pattern | up to 16 non-negative numbers (empty = solid) |
| 10 | `SENSITIVITY` | pressure sensitivity | finite number |
| 11 | `LAYER` | layer | integer 0 … 7 |
| 12 | `PEN_TYPE` | pen type | 0 = marker, 1 = pencil, 2 = highlighter, 3 = brush |

---

## Hash Chain

The protocol uses a hash chain to detect diverging copies of a page:

1. **Anchor**: `hashes[0] = hashAny(pageUuid)`.
2. **Chain**: `hashes[i+1] = hashNext(hashes[i], history[i])`, where `hashNext(h, action) = hashAny([h, action])`.
3. **Page hash**: the value reported for a page (`hash` in `page-info`, `fullPage`, `ping`, …) is `hashes[present]`.

The chain covers the whole history, including an undone tail; undo and redo only move `present`.

`hashAny` is a non-cryptographic 128-bit hash (the cyrb128 construction, four 32-bit lanes) over the text produced by `serialize`, returned as 32 hex digits. Client and server use the same functions from `shared.js`, so any deviation breaks every hash comparison. The server stores the chain with the page; when it loads a page whose stored chain was produced by a different hash function, it rebuilds the chain from the history.

### Snapshots

`snapshots` (in `page-registered`, `page-info` and `ping`) are chain values at a sparse set of positions, computed by `recent_snapshots(history.length)`: position 0 plus positions at power-of-two distances back from `history.length - 1`. For example, a history of 100 actions gives positions `[0, 64, 80, 88, 92, 96, 98, 99]`; an empty history gives no snapshots. The positions depend on the history length, not on `present`. Clients use them to find the latest position their own chain shares with the server's and request a `replay` from there.

---

## Action Broadcast

When a draw, erase, group, undo or redo action is accepted, the server sends `accept` to the proposer and a `replay` to every other open connection registered with the same board (whatever page it is on). Let `p` be `present` after the action. The replay's `edits` are the history entries from position `max(0, p - 1)` to the end of the history:
- for a new or redone action, this is that action (plus the remaining redo tail after a redo);
- for an undo, it starts with the entry just before the undone one and contains the undone tail.

---

## Users, Owners and Paths

### Users

`conf/users.json` is a list of users `{ "id": "<uuid>", "login": "<login>", "hash": "<salt>:<hash>" }`, created by the admin with `passwd_hash`. The id never changes and is what boards record as their owner; the login is what people type; the hash is the scrypt hash of the credential. The server keeps no copy: it reads the file for every credential check (and once at startup, to log a problem with it), so changes by the admin count at once. On `change-credential` it writes the file back with the one hash replaced.

### Board files

A board file holds the edit password (`passwd`), the page order (`pageOrder`), and, for boards created with an owner, `owner` (user id), `path` and `createdAt` (unix time in ms). Boards from before ownership have no owner, are listed for nobody, and can be given an owner and a path with `assign_board` while the server is stopped.

Owner and path never reach clients other than the owner: `board-info` and all other board messages carry neither, and only `board-list` contains paths.

### Path rules

A path names a board like a file path: segments separated by `/` (`teaching/algebra/week1`). Folders are not stored; boards whose paths share a prefix appear in the same folder.

- **Normalization** (`normalizePath` in `shared.js`): segments are trimmed and empty segments dropped (`" a // b "` becomes `a/b`). A path with no segment left, longer than 256 characters, or with control characters is invalid.
- **Unique per owner:** a path appears only once among one owner's boards.
- **Board or folder, never both:** no board lies inside another board's path; while `teaching/algebra/week1` exists, no board may be called `teaching/algebra`, and vice versa.

`findPathConflict` in `shared.js` checks the last two rules for a set of paths. The server checks every change against the owner's paths after the change, with `newBoardProblem` (`create-board`), `boardMoveProblem` (`set-path`) and `folderMove` (`rename-prefix`) in `shared.js`; they give the `error` reason (`invalid path`, `path taken`, `no such folder`). The client runs the same functions against its board list while a path is typed.

### Board index

At startup the server reads every board file into an index of owned boards (owner, path, edit password, creation time), which answers `list-boards` and the path checks. A damaged board file, a malformed owner or path, a duplicate path or a board inside another board's path stops the server: the board files are the single source of truth, and such a state is a bug or damage.

### Writing Path Changes

`create-board`, `set-path` and `rename-prefix` write the affected board files at once, each followed by a sync of the data directory, before answering. A change of several boards is written in an order in which every state on disk keeps the path rules: a board moves to its new path only after every board whose old path equals, contains or lies inside that path has been written. A crash in between leaves a partly moved folder, never two boards with the same path.

## Board State

### Page Order

Each board stores its edit password (`passwd`) and an ordered list of page UUIDs (`pageOrder`). The order determines page numbering (1-based `pageNr`), next/previous navigation, and the overview display order. Boards are never deleted, and `pageOrder` is never empty.

### Shuffle Protocol

Page reordering follows a proposal/acceptance protocol:

1. The client sends `shuffle-proposal` with `before` (the order it knows) and `after` (the desired order).
2. The server validates the password, the sync check and the permutation (see `shuffle-proposal`).
3. The server applies and saves the new order and broadcasts `board-info`, or sends the unchanged order back to the proposer.

---

## Page Management Protocol

### Adding a Page

1. The client sends `mod-action-proposals` with a `new page` action; `page-uuid` names the page after which to insert.
2. The server creates an empty page with a server-generated UUID and inserts it after that page.
3. The server sends `fullPage` for the new page to the proposer, with `do-move: true`.
4. The server pings every connection on the board.
5. The server broadcasts `board-info` to the board.

### Deleting a Page

1. The client sends `mod-action-proposals` with a `delete page` action for `page-uuid`.
2. If the board has more than one page, the page is removed from the page order and the page now at its position (or the new last page) becomes its replacement; the server sends `page-info` for the replacement to the proposer, with `do-move: true`.
3. If it is the board's only page, a new empty page takes its place in the page order; the server sends `fullPage` for it to the proposer, with `do-move: true`.
4. In both cases, the deletion map records deleted UUID → replacement UUID.
5. The server pings every connection on the board (which moves other clients off the deleted page).
6. The server broadcasts `board-info` to the board.

### Deletion Map

The deletion map lets clients that still ask for a deleted page (e.g., from their cache) be redirected. The server follows the chain of replacements; if the final replacement is not on the board, it falls back to the board's first page. The map is saved to `data/to_be_removed.json` (every 10 seconds and on shutdown). The file of a deleted page stays on disk.

---

## Overview Mode

Overview mode is a client-side feature that displays all pages as thumbnails in a grid. It uses the protocol as follows:

1. **Entering**: the client stores the current page in its cache, builds the grid from the page order it knows, and sends `board-info-request`.
2. **Thumbnails**: pages in the client's cache are rendered from it; missing pages are fetched with `fullPage-requests` (`delta: 0`, `register: false`).
3. **Reordering**: drag-and-drop and "move to front/back" are local; on Confirm, the client sends a `shuffle-proposal` if the order changed. Cancel, or clicking a thumbnail to open that page, discards the local order.
4. **Deleting**: after a confirmation dialog, the client immediately sends one `mod-action-proposals` with a `delete page` action per selected page.
5. **Adding**: the client sends a `new page` action anchored at the last page.
6. **Exporting**: for each page, the client sends `page-info-request`, finds the latest snapshot its cached history matches, and, unless the cached copy is already current, sends `replay-requests` from there; if that gives no data it falls back to `fullPage-requests`. The pages are then rendered into one PDF.
7. **Updates**: while the overview is open, incoming `board-info` and `ping` messages refresh the grid; new pages are inserted and deleted pages removed, while a pending local reordering is preserved.

---

## Error Handling

### Message Validation

Every client message type has a validator in `shared.js` (see *Appendix B*). Messages that fail validation are dropped without a reply. Messages that cannot be parsed, or have an unknown type, are answered with `error`.

### State Inconsistency

On a `ping` for its current page (ignored while one of its own proposals awaits an answer, for at most 100 ms), the client looks up the server's hash in its own chain:
1. if it is there at the client's `present`, the client is in sync;
2. if it is there at another position, the client moves its `present` to that position (an undo or redo it missed);
3. if it is not there, the client rewinds to the latest of the server's snapshots that occurs in its own chain (position 0, the anchor, always does) and sends `replay-requests` from that position.

### Unconfirmed edits

Edit actions the client has made but the server has not yet confirmed (e.g., while offline) are kept in the client's history and saved in `sessionStorage`, so they survive a reload of the tab. After reconnecting, the client fetches the page and proposes the edits again, skipping those the server already has.

### Reconnection

The client reconnects with exponential backoff:
- initial delay 1 second, doubling per attempt, at most 30 seconds;
- no limit on the number of attempts; the Reconnect button retries at once and resets the delay;
- after connecting, the client sends `register-board` (or `create-board` when it was creating a board).

---

## Appendix A: Message Type Constants

```javascript
// Client → Server
MESSAGES.CLIENT_TO_SERVER = {
  REGISTER_BOARD:        { TYPE: "register-board" },
  BOARD_INFO_REQUEST:    { TYPE: "board-info-request" },
  REGISTER_PAGE:         { TYPE: "register-page" },
  PAGE_INFO_REQUEST:     { TYPE: "page-info-request" },
  CHANGE_CREDENTIAL:     { TYPE: "change-credential" },
  CREATE_BOARD:          { TYPE: "create-board" },
  LIST_BOARDS:           { TYPE: "list-boards" },
  SET_PATH:              { TYPE: "set-path" },
  RENAME_PREFIX:         { TYPE: "rename-prefix" },
  FULL_PAGE_REQUEST:     { TYPE: "fullPage-requests" },
  SHUFFLE_PROPOSAL:      { TYPE: "shuffle-proposal" },
  MOD_ACTION_PROPOSALS:  { TYPE: "mod-action-proposals" },
  REPLAY_REQUEST:        { TYPE: "replay-requests" }
};

// Server → Client
MESSAGES.SERVER_TO_CLIENT = {
  CREDENTIAL_CHANGED: { TYPE: "credential-changed" },
  BOARD_LIST:         { TYPE: "board-list" },
  BOARD_CREATED:    { TYPE: "board-created" },
  BOARD_REGISTERED: { TYPE: "board-registered" },
  BOARD_INFO:       { TYPE: "board-info" },
  PAGE_REGISTERED:  { TYPE: "page-registered" },
  PAGE_INFO:        { TYPE: "page-info" },
  PAGE_LOST:        { TYPE: "page-lost" },
  FULL_PAGE:        { TYPE: "fullPage" },
  ACCEPT:           { TYPE: "accept" },
  DECLINE:          { TYPE: "decline" },
  REPLAY:           { TYPE: "replay" },
  PING:             { TYPE: "ping" }
};
// plus the "error" message, which has no constant
```

## Appendix B: Validation

All client message types have validation functions in `shared.js`:

```javascript
is_invalid_REGISTER_BOARD_message(data)
is_invalid_REGISTER_PAGE_message(data)
is_invalid_PAGE_INFO_REQUEST_message(data)
is_invalid_CHANGE_CREDENTIAL_message(data)
is_invalid_CREATE_BOARD_message(data)
is_invalid_LIST_BOARDS_message(data)
is_invalid_SET_PATH_message(data)
is_invalid_RENAME_PREFIX_message(data)
is_invalid_FULL_PAGE_REQUEST_message(data)
is_invalid_REPLAY_REQUEST_message(data)
is_invalid_MOD_ACTION_PROPOSALS_message(data)
is_invalid_BOARD_INFO_REQUEST_message(data)
is_invalid_SHUFFLE_PROPOSAL_message(data)
```

They check that:
- the message is a non-null object;
- UUID fields are version-4 UUIDs (`isUuid`), and required ones are present;
- integer fields (`delta`, `present`) are integers and boolean fields (`register`) are booleans;
- password fields are non-empty strings; owner messages carry a login (at most 64 characters) and a credential (at most 1024);
- raw paths are strings of at most 1024 characters (the server then normalizes them and answers an invalid path with `error`);
- shuffle lists are non-empty lists of UUIDs;
- action payloads have a known type and the fields that type needs, strokes have the structure in *Stroke Structure*, and groups contain only edit actions and are at most 10 levels deep.

## Appendix C: Decline Reasons

| Reason | When |
|---|---|
| `unauthorized` | `passwd` does not match the board password |
| `page not on board` | `page-uuid` is not in the board's page order |
| `cannot apply action to current visual state` | a draw whose element is already visible, an erase whose target is not visible, or a group with such a sub-action |
| `can only undo the immediate past` | undo target is not the entry before `present` |
| `can only redo the immediate future` | redo target is not the entry at `present` |
| `unknown action type` | not reachable in practice: validation drops unknown types first |

---

## Changelog

### Version 4.0 (October 2026)
- Users: `conf/users.json` (id, login, credential hash) replaces `conf/passwd.json`; `change-credential` / `credential-changed`.
- Owner messages carry `login` and `passwd` and are checked one by one; the server keeps no login state.
- Boards get an owner (user id), a path and a creation time; `create-board` carries the owner's login and credential and a `path`.
- `list-boards` / `board-list`, `set-path`, `rename-prefix` for the owner's board manager; path rules, board index and ordered writes (see *Users, Owners and Paths*).
- `error` carries the `requestId` of refused requests; new reasons.

### Document revision (October 2026)
- Corrected the document to match `shared.js` and `server.js`: the literal wire keys (`board-uuid`, `page-uuid`, `clientId`, `passwd`, `do-move`, `pageNr`, `totalPages`, `edits`, `beforeHash`, …), the type strings `fullPage-requests`, `replay-requests`, `fullPage`, `new page` and `delete page`, and the stroke format (a 13-element array, not an object).
- Documented the `error` message, the `page not on board` decline, the `replay` broadcast that follows each accepted action, the periodic `board-info` broadcast, and the `hash` / `snapshots` fields of `page-registered` and `fullPage`.
- Corrected: wire messages are plain JSON; the server does not check `before-hash`; `ping` and `accept` carry no `requestId`; shuffle failures go to the proposer only; there is no `Server error: …` decline.

### Version 3.1 (July 2026)
- Added the first page's UUID (`first-page-uuid`) to `board-created` (was sent under a wrong key before; now matches `board-registered`)
- Documented that client and server share the identical hash-chain anchor (`hashAny(pageUuid)`)

### Version 3.0 (May 2026)
- Added `board-info-request` / `board-info` messages for page order synchronization
- Added `shuffle-proposal` message for collaborative page reordering
- Added `new page` and `delete page` action types for page management
- Added `snapshots` field to `ping` message for efficient hash-chain verification
- Added overview mode protocol description
- Added board states and page management protocol sections
- Added deletion map documentation

### Version 2.0 (April 2026)
- Added comprehensive validation layer
- Introduced the `do-move` (`SWITCH`) flag for client state management
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
