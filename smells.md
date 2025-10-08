# Code Smells: Defensive Programming That May Hide Bugs

This document catalogs defensive programming patterns that may be masking underlying bugs rather than properly handling edge cases.

## 1. Fallback Patterns in server.js

**Pattern**: `const boardId = data.boardId || ws.boardId`

**Locations** (5 instances):
- `messageHandlers[FULL_PAGE_REQUESTS.TYPE]`: Line ~650
- `messageHandlers[MOD_ACTION_PROPOSALS.TYPE]`: Line ~550
- Error context in MOD_ACTION_PROPOSALS catch block
- `messageHandlers[REPLAY_REQUESTS.TYPE]`: Line ~750
- `routeMessage` function

**Smell**: 
- If `data.boardId` is missing, why? Should this be an error?
- If `ws.boardId` is undefined, the fallback silently fails later
- The pattern suggests uncertainty about where boardId comes from
- The original bug ("Cannot read properties of undefined (reading 'pageOrder')") occurred because this fallback chain resulted in undefined

**Questions**:
- When is boardId expected in the message vs stored in ws?
- Should missing boardId be a protocol violation?

## 2. Silent Early Returns in index.html

**Pattern**: `if (!condition) return;`

**Count**: 29 instances

**Notable Examples**:

### Settings Functions
```javascript
if (!boardId) return; // Can't save without boardId
if (!boardId) return false; // Can't load without boardId
```
**Smell**: Silent failure - caller doesn't know settings weren't saved/loaded

### Control Triangle Functions
```javascript
if (!controlTriangle) return null;
if (!pasteBounds) return;
```
**Smell**: Functions silently do nothing if state is missing. Is this expected or a bug?

### Cache Functions
```javascript
if (!cacheDB) return;
if (!cacheDB) return null;
```
**Smell**: If IndexedDB failed to initialize, operations silently fail. Should user be notified?

### Rendering Functions
```javascript
if (!element) return;
if (!backgroundCanvas || !backgroundCtx) return;
```
**Smell**: Missing elements during render - is this a normal case or data corruption?

### Clipboard Operations
```javascript
if (!clipboard.elements.length) return;
if (!pasteMode || pastedElements.length === 0) return;
```
**Smell**: Silent no-ops when clipboard is empty - expected or bug?

**Impact**: 
- Failures cascade silently
- Hard to debug "nothing happened" scenarios
- No logging or user feedback

## 3. Try-Catch Blocks That Swallow Errors (index.html)

**Count**: 9 instances

### Pattern 1: console.warn and continue
```javascript
try {
    // settings operations
} catch (err) {
    console.warn('Failed to save settings:', err);
}
```
**Locations**:
- saveSettings()
- loadSettings()

**Smell**: Settings silently fail to persist, user never knows

### Pattern 2: Remove corrupted data silently
```javascript
try {
    const data = shared.deserialize(sessionStorage.getItem(key));
    cached.push({ key, data });
} catch (err) {
    // Corrupted cache entry, remove it
    sessionStorage.removeItem(key);
}
```
**Smell**: Data corruption is silently fixed, no investigation possible

### Pattern 3: Continue without cache
```javascript
try {
    // cache operations
} catch (err) {
    console.warn('Failed to cache page:', err);
    // Continue without caching - not critical
}
```
**Smell**: Cache failures are "not critical" but user experience degrades silently

### Pattern 4: Error in PDF export
```javascript
try {
    // PDF export logic
} catch (err) {
    hideError(); // Hides previous error
    showError(`PDF export failed: ${err.message}`);
}
```
**Smell**: hideError() then showError() - suggests error banner state management issues

## 4. Assert Statements in server.js

**Count**: 11 instances

**Locations**:
- `getPage()`: `assert(board.pageOrder.includes(pageId))`
- `insertPage()`: `assert(0 <= where && where <= board.pageOrder.length)`
- `insertPage()`: `assert(!board.pageOrder.includes(pageId))`
- `existingPage()`: `assert(!(replacementId === pageId))`
- `existingPage()`: `assert(N < 100000)`
- `existingPage()`: `assert(board.pageOrder.length > 0)`
- `sendFullPage()`: `assert(board)`
- `sendFullPage()`: `assert(page)`
- `ping_client_with_page()`: `assert(board.pageOrder.includes(pageId))`
- `ping_client()`: `assert(board)`
- `ping_client_with_page()`: `assert(page)`

**Smell**:
- Assertions crash the server in production
- No graceful error handling or recovery
- Client gets disconnected with no explanation
- Should these be proper error responses instead?

**Questions**:
- Are these invariants that should never be violated?
- Or are they conditions that could occur with malicious/buggy clients?
- Should server send DECLINE messages instead of crashing?

## 5. Disabled Debugging Code

**Location**: server.js, `flag_and_fix_inconsistent_state()` function

```javascript
function flag_and_fix_inconsistent_state( page, msg ) {
    return;  // ← FUNCTION IMMEDIATELY RETURNS
    const current_visible = compileVisualState( page.history.slice( 0, page.present ) ).visible;
    const visible = page.state.visible;
    if ( /* check for inconsistency */ ) {
        debug.log( msg, "visible set BAD", ...);
        page.state.visible = current_visible;  // ← SILENTLY FIXES BUG
    }
}
```

**Smell**:
- Function that detects and fixes inconsistent state is disabled
- Was this finding bugs? Why was it disabled?
- Are those bugs still present but now undetected?
- The "fix" silently overwrites state - hiding the root cause

## 6. Error Message Handling Pattern

**Pattern**: WebSocket error handling in index.html

```javascript
ws.onerror = (error) => {
    console.error('WebSocket error:', error);
    connectionEstablished = false;
    showError('Failed to connect to server. Please check your connection.');
};
```

**Smell**:
- Generic error message loses specific error information
- User sees "check your connection" for all errors
- Actual error only in console (users don't see it)

## 7. State Fallback Pattern

**Pattern**: Using previous state when new state is unavailable

**Example**: In `handleFullPageMessage()`:
```javascript
if (cachedPage && cachedPage.hash === data.hash) {
    // Use cached data
} else {
    // Use server data
}
```

**Smell**:
- Hash mismatch silently falls through to server data
- What if cache is stale but server is slow?
- No logging of cache hit/miss rates

## Summary Statistics

| Category | Count | Severity |
|----------|-------|----------|
| Fallback patterns (server.js) | 5 | HIGH - led to actual bug |
| Silent early returns (index.html) | 29 | MEDIUM - hard to debug |
| Silent early returns (server.js) | 9 | MEDIUM - hard to debug |
| Try-catch swallowing errors | 9 | MEDIUM - silent failures |
| Assert statements (server crash) | 11 | HIGH - crashes server |
| Disabled debug function | 1 | CRITICAL - hides state bugs |

## Recommendations

1. **Replace fallback patterns with explicit error handling**
   - `data.boardId || ws.boardId` should error if both are undefined
   - Log when fallback is used

2. **Add logging to early returns**
   - At minimum, debug log why function returned early
   - Consider returning error codes instead of void

3. **Don't swallow errors in try-catch**
   - Log all errors with context
   - Consider showing user-facing errors for critical failures
   - Don't silently fix data corruption

4. **Replace asserts with proper error responses**
   - Send DECLINE messages to clients
   - Log assertion failures for investigation
   - Don't crash server for client errors

5. **Investigate disabled debugging code**
   - Re-enable flag_and_fix_inconsistent_state()
   - Find and fix the root cause of state inconsistencies
   - Don't silently patch over bugs

6. **Add telemetry/metrics**
   - Track cache hit rates
   - Track error frequencies
   - Monitor fallback pattern usage
