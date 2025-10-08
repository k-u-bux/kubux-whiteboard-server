# Kubux Whiteboard Server - TODO & Recommendations

## Code Quality Assessment Summary

This document contains actionable items for improving code quality, security, performance, and maintainability of the Kubux Whiteboard Server.

---

## Critical Priority (Security/Stability)

### Security

- [x] **Re-enable HTTPS in production** (server.js)
  - Uncomment HTTPS server configuration
  - Ensure SSL certificates are properly configured
  - Test WebSocket over WSS protocol
  - Location: `server.js:~330`

- [x] **Add salt/pepper to password hashing** (server.js)
  - Implement per-user salt for password hashes
  - Consider using bcrypt or argon2 instead of plain SHA-256
  - Update credential storage format
  - Location: `server.js:~340, ~475`

- [ ] **Validate UUIDs before file operations** (server.js)
  - Add UUID format validation in `getFilePath()`
  - Prevent potential file system exploits from malformed UUIDs
  - Use regex: `/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i`
  - Location: `server.js:~40`

### Error Handling

- [x] **Implement exponential backoff for WebSocket reconnection** (index.html)
  - Add automatic reconnection logic with increasing delays
  - Implement max retry limit
  - Show connection status to user
  - Location: `index.html:~2150` (ws.onclose)

- [ ] **Add comprehensive error handling for file operations** (server.js)
  - Wrap all file operations in try-catch blocks
  - Handle corrupted JSON gracefully
  - Log errors with context for debugging
  - Locations: `loadItem()`, `saveItem()`, all fs operations

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

- [ ] **Add message schema validation** (server.js)
  - Validate incoming messages before processing
  - Check required fields exist and have correct types
  - Consider using a schema library (Zod, Joi, etc.)
  - Prevents server crashes from malformed client messages
  - Location: `routeMessage()` and all message handlers

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
  - Location: `index.html:~2565` (do_intersect function)

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
  const PING_INTERVAL_MS = 5000;
  const DRAG_THRESHOLD_PX = 5;
  const HASH_BIT_MASK = 0xffffffffffffffffffffffffffffffn; // 120 bits for collision resistance
  const PERSIST_INTERVAL_MS = 10000;
  ```
  - Add comments explaining why these values were chosen
  - Locations: Throughout codebase

- [ ] **Standardize naming conventions** (all files)
  - Choose one convention: camelCase, snake_case, or PascalCase
  - Apply consistently across codebase
  - Update message protocol constants
  - Consider: camelCase for JS, snake_case for protocol messages

- [ ] **Remove or complete canvas caching optimization** (index.html)
  - Commented-out canvas caching code exists
  - Either implement fully or remove
  - If implementing, add documentation
  - Location: `index.html:~2740-2760` (commented canvasCache code)

- [ ] **Replace assertions with proper error handling** (server.js)
  - Assertions may be disabled in production
  - Use explicit error throwing for runtime validation
  - Add meaningful error messages
  - Locations: All `assert()` calls

### Documentation

- [ ] **Add JSDoc comments for public APIs** (all files)
  - Document function parameters and return types
  - Explain complex algorithms (hash chain, state management)
  - Add usage examples for main functions
  - Priority: `shared.js` public API

- [ ] **Document protocol message formats** (shared.js, separate doc)
  - Create protocol documentation from MESSAGES constants
  - Include message flow diagrams
  - Document state machine transitions
  - Explain hash chain synchronization algorithm

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

- [ ] **Add runtime type validation for critical paths** (server.js, index.html)
  - Validate message formats at runtime
  - Validate action payloads
  - Use schemas or type guards
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
  - Check database connectivity
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
  - Indicate when actions are pending server confirmation
  - Warn about poor connection quality

- [ ] **Implement offline mode with sync** (index.html)
  - Cache actions when disconnected
  - Queue for upload when reconnected
  - Show offline indicator
  - Handle conflicts on reconnection

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
Current performance is acceptable for typical use cases but degrades with:
- Many strokes (>1000) on canvas
- Complex selections/erases
- Long sessions without refresh
- Multiple concurrent users on same board

---

## Quick Wins (Start Here)

These items provide maximum impact with minimal effort:

1. Re-enable HTTPS (critical security, 5 min)
2. Add message validation (stability, 2 hours)
3. Document magic numbers (maintainability, 1 hour)
4. Add UUID validation (security, 30 min)
5. Implement exponential backoff for reconnection (stability, 1 hour)

---

Last Updated: 2025-01-03
