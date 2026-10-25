# Code Smells: Defensive Programming That May Hide Bugs

This document catalogs defensive programming patterns that may be masking underlying bugs rather than properly handling edge cases.

> **Review note (2026-10-25, checked against commit d414690):** Examples, locations and counts below were re-checked against the code. Earlier versions of this note said the `loadItem` corrupted-file crash was fixed by a try-catch; that is not the current code. `loadItem` has no try-catch, and a damaged data file ends the server process on purpose (see section 3). Counts are `grep` counts of the stated pattern and therefore approximate.

## 1. Silent Early Returns in index.html

**Pattern**: `if (!condition) return;`

**Count**: 86 lines in index.html match a one-line `if (…) return` (of these, 20 have the plain form `if (!x) return`)

**Notable Examples**:

### Settings Functions
```javascript
if (!boardId) return; // Can't save without boardId
if (!boardId) return false; // Cannot load without boardId
```
**Smell**: Silent failure - caller doesn't know settings weren't saved/loaded

### Control Triangle Functions
```javascript
if (!controlTriangle) return null;
if (!pasteBounds) return;
```
**Smell**: Functions silently do nothing if state is missing. Is this expected or a bug?

### Rendering Functions
```javascript
if (!element) return;
if (!backgroundCanvas || !backgroundCtx) return;
```
**Smell**: Missing elements during render - is this a normal case or data corruption?

### Clipboard Operations
```javascript
if (!clipboard.elements.length || positions.length === 0) return;
if (!pasteMode || pastedElements.length === 0) return;
```
**Smell**: Silent no-ops when clipboard is empty - expected or bug?

**Impact**: 
- Failures cascade silently
- Hard to debug "nothing happened" scenarios
- No logging or user feedback

## 2. Try-Catch Blocks That Swallow Errors (index.html)

**Count**: 23 `catch` clauses in index.html

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

### Pattern 2: Empty catch blocks
```javascript
try {
    sessionStorage.setItem(SAVED_EDITS_KEY, JSON.stringify({ board: boardId, page: currentPageUuid, edits }));
} catch (err) {
    // storage full or blocked
}
```
**Locations**:
- saveUnconfirmedEdits()
- takeSavedEdits() (also swallows an unreadable entry)

**Smell**: If storage fails, unconfirmed edits are no longer kept across a reload of the tab, and nobody is told

### Pattern 3: console.error and continue
```javascript
try {
    // page cache operations (in-memory LRU, 24 entries)
} catch (e) {
    console.error('Error saving item to LRU cache:', e);
    return false;
}
```
**Locations**:
- saveItem(), loadItem(), removeItem() of the client page cache

**Smell**: Cache failures are logged to the console only; the user experience degrades silently

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

## 3. Assert Statements in server.js

**Count**: 20 `assert()` calls

**Locations**:
- `getPage()`: `assert(board.pageOrder.includes(pageId))`
- `insertPage()`: `assert(0 <= where && where <= board.pageOrder.length)`
- `insertPage()`: `assert(!board.pageOrder.includes(pageId))`
- `existingPage()`: `assert(!visited.has(currentId))` (cycle in the deletion map)
- `existingPage()`: `assert(board.pageOrder.length > 0)`
- `sendFullPage()`: `assert(board)`, `assert(page)`
- `sendPageInfo()`: `assert(board)`, `assert(page)`
- `ping_client_with_page()`: `assert(board)`, `assert(page)`, `assert(board.pageOrder.includes(pageId))`
- `ping_client()`: `assert(board)`
- `describePage()`: `assert(page)`
- `registerPage()`: `assert(page)`
- `handleEditAction()`: `assert(page.hashes.length === page.history.length + 1)`
- `handleUndoAction()`: `assert(reverted)`
- `handleRedoAction()`: `assert(committed)`
- `mod-action-proposals` handler: `assert(page)`
- `replay-requests` handler: `assert(page)`

`getPage()` and `insertPage()` are not called anywhere.

**Smell**:
- A failed assert throws, and since handler exceptions are deliberately not caught, it ends the server process
- No graceful error handling or recovery
- All connected clients are disconnected with no explanation

**Context**: The questions an earlier version of this section asked are answered in the code. The "Lookup invariants" comment in server.js (I1: every page in a board's page order has a page file; I2: the page order is never empty; I3: a connection's board exists) names the invariants the asserts rely on, and states that a missing or damaged data file is meant to stop the server rather than be silently recreated. The security audit found no assert reachable by malformed client input. The same fail-fast policy applies to damaged files: `loadItem` has no try-catch, so a data file that is not valid JSON makes `deserialize` throw, and `loadPage` throws on a hash chain of the wrong length.

**Open question**:
- Is ending the process (and disconnecting every board) the right response to one damaged file, or should only requests for that board/page fail?

## 4. Disabled Debugging Code

**Location**: server.js, `flag_and_fix_inconsistent_state()` function

```javascript
function flag_and_fix_inconsistent_state( page, msg ) {
    // this is dead in production. the function is a debug tool.
    return;  // ← FUNCTION IMMEDIATELY RETURNS
    const current_visible = compileVisualState( page.history.slice( 0, page.present ) ).visible;
    const visible = page.state.visible;
    if ( /* check for inconsistency */ ) {
        debug.log( msg, "visible set BAD", ...);
        page.state.visible = current_visible;  // ← SILENTLY FIXES BUG
    }
}
```

It is still called on entry and exit of `handleEditAction`, `handleUndoAction` and `handleRedoAction`.

**Smell**:
- Function that detects and fixes inconsistent state is disabled
- Was this finding bugs? Why was it disabled?
- Are those bugs still present but now undetected?
- The "fix" silently overwrites state - hiding the root cause

## 5. Error Message Handling Pattern

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

## 6. Optimistic Use of Cached Pages

**Pattern**: Showing cached data before the server confirms it

**Example**: In `joinPage()` (index.html):
```javascript
const cachedPage = loadPageFromCache(currentPageUuid);
if (cachedPage) {
    // render the cached history at once ...
    verifiedIndex = present;
    // ... and ask the server for what changed since
    requestReplay( currentPageUuid, true );
} else {
    requestFullPage(currentPageUuid, true, 0);
}
```

**Smell**:
- The cached copy is marked verified (`verifiedIndex = present`) before the server has confirmed it
- A stale cache is visible until the replay arrives; if the server is slow, the user may draw on top of an outdated page
- No logging of cache hit/miss rates (only a `debugLog` line)

## Summary Statistics

| Category | Count | Severity |
|----------|-------|----------|
| Silent early returns (index.html) | 86 one-line `if (…) return` | MEDIUM - hard to debug |
| Silent early returns (server.js) | not re-counted | MEDIUM - hard to debug |
| Try-catch blocks (index.html) | 23 | MEDIUM - silent failures |
| Assert statements (server crash) | 20 | HIGH - crashes server |
| Disabled debug function | 1 | CRITICAL - hides state bugs |

## Recommendations

1. **Add logging to early returns**
   - At minimum, debug log why function returned early
   - Consider returning error codes instead of void

2. **Don't swallow errors in try-catch**
   - Log all errors with context
   - Consider showing user-facing errors for critical failures
   - Don't silently fix data corruption

3. **Reconsider what an assert failure takes down**
   - Log assertion failures for investigation
   - Consider failing only the request (or board) concerned instead of the whole process

4. **Investigate disabled debugging code**
   - Re-enable flag_and_fix_inconsistent_state() in testing
   - Find and fix the root cause of state inconsistencies
   - Don't silently patch over bugs

5. **Add telemetry/metrics**
   - Track cache hit rates
   - Track error frequencies
   - Monitor fallback pattern usage
