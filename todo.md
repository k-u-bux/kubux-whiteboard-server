# Kubux Whiteboard Server - TODO & Recommendations

## Code Quality Assessment Summary

This document contains actionable items for improving code quality, security, performance, and maintainability of the Kubux Whiteboard Server.

---

## Critical Priority (Security/Stability)

### Security

- [x] **HTTPS via reverse proxy** (docker-compose.yml)
  - SSL termination handled by nginx-proxy with Let's Encrypt
  - Server runs plain HTTP on port 80 behind the proxy
  - WebSocket upgraded to WSS through the proxy
  - The commented-out HTTPS config in server.js is a development artifact, not used in production
  - Location: `docker-compose.yml`, `README.md "Mode 2: Docker with Reverse Proxy"`

- [x] **Add salt/pepper to password hashing** (server.js)
  - Done: the server-level credentials in `conf/passwd.json` are scrypt hashes (N=16384, r=8, p=1) with a random 32-byte salt each, stored as `salt:hash`
  - Board edit passwords are random 12-character strings stored with the board and compared in constant time
  - Location: `server.js:96-187`, `passwd_hash`

- [X] **Validate UUIDs before file operations** (server.js)
  - Done: `loadItem()` and `saveItem()` check the ID with `isUuid()` before building a path (`getFilePath()` itself does not check)
  - Prevent potential file system exploits from malformed UUIDs
  - Regex (`isUuid` in shared.js): `/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i`
  - Location: `server.js:329-354`, `shared.js:53-56`

### Error Handling

- [x] **Implement exponential backoff for WebSocket reconnection** (index.html)
  - Done: automatic reconnection with delays from 1 s doubling to at most 30 s; a Reconnect button retries at once
  - Not done: there is no maximum number of retries (the client keeps trying)
  - Connection status is shown in the error banner (countdown, number of edits waiting to be sent)
  - Location: `index.html:~2368-2420` (`getReconnectDelay`, `scheduleReconnect`, `reconnectWebSocket`), `ws.onclose` at `~2486`

- [~] **Add comprehensive error handling for file operations** (server.js)
  - Wrap all file operations in try-catch blocks
  - Handle corrupted JSON gracefully
  - Log errors with context for debugging
  - Locations: `loadItem()`, `saveItem()`, all fs operations
  - **Status (2026-10-25):** `loadItem()` has **no** try-catch: a data file that is not valid JSON throws, and the exception ends the process. This is deliberate fail-fast behaviour (see the "Lookup invariants" comment in server.js). `saveItem()` writes through `writeFileAtomic()` (temporary file, fsync, rename; the temporary file is removed and the error re-thrown on failure), so a crash or full disk cannot leave a truncated file, but a failed write in the periodic save still ends the process (see server-security.md, Finding 2).

- [ ] **Profile file I/O performance before considering async conversion** (server.js)
  - **WARNING**: Converting to async is NOT a simple refactoring
  - Requires solving complex race conditions (page deletion during load, concurrent modifications, cache consistency)
  - Solutions require major architectural changes (event queues, SQLite, or actor model)
  - Estimated effort: 2-4 weeks of work with high risk
  - **Current sync approach may be optimal** for this use case (fast local disk, limited users)
  - **Action**: Profile actual blocking time first - only convert if measurements show bottleneck
  - **Alternative**: Add monitoring for slow file operations, set performance budgets
  - Locations: `loadItem()`, `saveItem()`, `initializeGlobals()`

### State Consistency

- [X] **Add message schema validation** (server.js)
  - Validate incoming messages before processing
  - Check required fields exist and have correct types
  - Done with hand-written validators (`is_invalid_*` in shared.js), no schema library
  - Prevents server crashes from malformed client messages
  - Location: every message handler in server.js calls its validator first

---

## High Priority (Performance/UX)

### Performance Optimization

- [ ] **Implement dirty rectangle rendering** (index.html)
  - Track which regions of canvas changed
  - Only redraw modified areas instead of full canvas
  - Particularly important during active drawing
  - Locations: `redrawCanvas()`, drawing/erasing handlers

- [x] **Optimize rendering during active strokes** (index.html)
  - Consider double-buffering or layered canvases
  - Draw current stroke on separate layer
  - Composite only when stroke is complete
  - Location: `redrawCanvas()`, `handlePointerMove()`

- [x] **Add bounding box pre-filtering for intersections** (index.html, shared.js)
  - Performs layer check, then bbox intersection, then pixel comparison
  - Early returns if bboxes don't overlap, avoiding expensive pixel checks
  - Location: `index.html:~6879` (do_intersect function)

### Memory Management

- [ ] **Implement memory-based cache eviction** (server.js)
  - Current caches only count items, not memory size
  - Add memory usage tracking
  - Evict based on memory pressure, not just count
  - Locations: `pageCache`, `boardCache` management

- [ ] **Add history size limits and compaction** (index.html)
  - History arrays grow unbounded in long sessions
  - Implement periodic snapshot + truncation
  - Or set maximum history depth
  - Locations: `history`, `hashes` arrays

- [ ] **Add clipboard size validation** (index.html)
  - Prevent copying excessively large selections
  - Warn user or limit clipboard data
  - Location: `copySelectedElements()`

---

## Medium Priority (Maintainability)

### Code Organization

- [ ] **Replace magic numbers with named constants** (all files)
  ```javascript
  // Examples to fix:
  const PERSIST_INTERVAL_MS = 10000;   // server.js: setInterval( periodicallyPersist, 10000 )
  const AUTO_ERASE_DELAY_MS = 3000;    // index.html: timer pens
  const RESPONSE_TIMEOUT_MS = 100;     // index.html: pings ignored while a proposal is pending
  ```
  - Add comments explaining why these values were chosen
  - Locations: Throughout codebase

- [ ] **Standardize naming conventions** (all files)
  - Choose one convention: camelCase, snake_case, or PascalCase
  - Apply consistently across codebase
  - Update message protocol constants
  - Consider: camelCase for JS, snake_case for protocol messages

- [x] **Remove or complete canvas caching optimization** (index.html)
  - Done: the commented-out `canvasCache` code is gone
  - (The client's page cache is an in-memory LRU of 24 pages; the old sessionStorage version of it is still present as a commented-out block at `index.html:~1355-1414`)

- [ ] **Replace assertions with proper error handling** (server.js)
  - Node's `assert` is never disabled; a failed assert throws, and since handler exceptions are not caught, it ends the process
  - The asserts guard server-side invariants (see "Lookup invariants" in server.js), not client input
  - Add meaningful error messages
  - Locations: All `assert()` calls (20)

### Documentation

- [ ] **Add JSDoc comments for public APIs** (all files)
  - Document function parameters and return types
  - Explain complex algorithms (hash chain, state management)
  - Add usage examples for main functions
  - Priority: `shared.js` public API

- [x] **Document protocol message formats** (shared.js, separate doc)
  - Create protocol documentation from MESSAGES constants
  - Include message flow diagrams
  - Document state machine transitions
  - Explain hash chain synchronization algorithm
  - **Done:** see `protocol.md` (message flow diagrams still a nice-to-have)

- [ ] **Add code comments for complex logic** (index.html, server.js)
  - Explain why, not what
  - Document edge cases and assumptions
  - Add examples for non-obvious code
  - Priority: State management, intersection detection, hash verification

- [ ] **Create architecture documentation** (new file)
  - Document overall system design
  - Explain client-server synchronization model
  - Document security considerations
  - Include deployment guide

### Error Recovery

- [ ] **Implement circuit breaker for repeated failures** (server.js)
  - Track failure rates per client
  - Temporarily disconnect abusive/buggy clients
  - Prevent cascade failures
  - Location: `routeMessage()` error handling

- [ ] **Add user-friendly error messages** (index.html)
  - Replace generic error alerts with specific guidance
  - Provide recovery actions
  - Add error categorization (network, state, permission)
  - Locations: All error display code

---

## Low Priority (Nice-to-Have)

### Testing

- [ ] **Add unit tests for state management** (new test files)
  - Test `commitEdit()`, `revertEdit()` functions
  - Test hash chain consistency
  - Test visual state compilation
  - Framework: Jest, Mocha, or similar

- [ ] **Add integration tests for protocol** (new test files)
  - Test message round-trips
  - Test synchronization scenarios
  - Test conflict resolution
  - Mock WebSocket for testing

- [ ] **Add performance benchmarks** (new test files)
  - Measure rendering performance with many strokes
  - Measure intersection detection performance
  - Track memory usage over time
  - Set performance budgets

### Type Safety

- [ ] **Consider TypeScript migration** (all files)
  - Pros: Compile-time type checking, better IDE support
  - Cons: Build step required, learning curve
  - Alternative: Use JSDoc type annotations for incremental improvement
  - Start with shared.js if migrating

- [~] **Add runtime type validation for critical paths** (server.js, index.html)
  - Done on the server: message formats and action payloads (including stroke structure and group nesting) are validated (`is_invalid_*` in shared.js)
  - Not done: the client does not validate server messages
  - Prevents type-related bugs

### Monitoring & Observability

- [ ] **Add performance monitoring** (server.js, index.html)
  - Track WebSocket message latency
  - Monitor file I/O performance
  - Track cache hit/miss rates
  - Log slow operations

- [ ] **Add usage analytics** (server.js)
  - Track number of active boards
  - Monitor storage usage
  - Track error rates
  - Privacy-conscious implementation

- [ ] **Implement health check endpoint** (server.js)
  - HTTP endpoint for monitoring
  - Check that the data directory is writable (there is no database)
  - Report cache status
  - Use for load balancer health checks

### Features

- [ ] **Implement WebSocket ping/pong heartbeat** (server.js, index.html)
  - Currently only server sends ping messages
  - Add proper WebSocket ping/pong frames
  - Detect dead connections faster
  - Clean up stale connections

- [ ] **Add connection quality indicators** (index.html)
  - Show latency to user
  - Indicate when actions are pending server confirmation (while offline, the error banner already shows how many edits wait; a sync indicator exists only as commented-out code)
  - Warn about poor connection quality

- [~] **Implement offline mode with sync** (index.html)
  - Done: edits made while disconnected stay in the local history as unconfirmed edits, are kept in sessionStorage across a reload of the tab, and are proposed again after reconnecting (`resendUnconfirmedEdits`)
  - Done: the error banner shows the offline state and the number of waiting edits; page actions are refused while offline
  - Conflicts: resent edits are applied to the server's current page; an edit whose target is gone is declined, with no further resolution

---

## Architecture Strengths (Keep These)

✅ Security-conscious single-file serving (index.html)  
✅ Hash chain for state verification (not cryptographic, appropriate use)  
✅ Clear separation of concerns (client/server/shared)  
✅ File-based persistent storage with caching  
✅ Message protocol with clear constants  
✅ Resource cleanup on shutdown  
✅ Optimistic client updates with server verification  
✅ Layer-based drawing system  
✅ Selection tools with clipboard support  

---

## Notes

### Hash Function Clarification
The custom hash function in `shared.js` is **not** a security concern because it's used for:
- State consistency verification (detecting divergence)
- Not for cryptographic purposes (authentication, encryption)
- Collision resistance is sufficient for this use case

### Monolithic index.html Justification
The single-file approach is **intentional** for security:
- Minimizes attack surface by serving only one file
- Eliminates path traversal risks
- Simplifies deployment
- Embedding shared.js prevents external dependency attacks

### Performance Context
No measurements exist yet (see `performance/README.md`, a plan that has not been run). The expectation is that performance is acceptable for typical use cases but degrades with:
- Many strokes (>1000) on canvas
- Complex selections/erases
- Long sessions without refresh
- Multiple concurrent users on same board

---

## Quick Wins (Start Here)

These items provide maximum impact with minimal effort:

1. ~~Add message validation~~ (done)
2. Document magic numbers (maintainability, 1 hour)
3. ~~Add UUID validation~~ (done)
4. ~~Implement exponential backoff for reconnection~~ (done)
5. Cache hit/miss logging (observability, 30 min)

---

Last Updated: 2026-10-25
