# Security Audit Report: kubux-whiteboard-server

**Audit Date:** July 1, 2026  
**Auditor:** Security Review  
**Version:** Current (commit: f56d3d5)  
**Focus Areas:** RCE, Arbitrary File Access, DoS, Crash Vectors

---

## Executive Summary

A comprehensive security audit was conducted on `server.js` and `shared.js` covering:
- Remote code execution vulnerabilities
- Arbitrary file read/write access
- Path traversal attacks
- Deserialization vulnerabilities
- Denial of Service (DoS) attacks
- Crash vectors via malformed input

**Overall Assessment:** ⚠️ **No RCE or file access vulnerabilities. Several DoS/crash issues remain unfixed.**

The codebase demonstrates strong security practices for preventing RCE and arbitrary file access. However, several DoS and crash vectors exist that could allow an attacker to disrupt service or crash the server process.

---

## Audit Scope & Methodology

### In Scope
- All client-to-server message handlers
- File system operations
- Deserialization of user input
- Path construction logic
- HTTP request handling
- WebSocket message routing
- Denial of Service (DoS) attacks
- Crash vectors via malformed input
- Resource exhaustion vectors

### Methodology
1. **Static code analysis** of all file operations
2. **Input validation review** for all message handlers
3. **Deserialization security analysis**
4. **Path traversal vulnerability assessment**
5. **Remote code execution vector analysis**
6. **DoS and crash vector analysis**
7. **Assert reachability analysis** (can malformed input trigger asserts?)

---

## Critical Findings

### ✅ No RCE Vulnerabilities Found

**Assessment:** No remote code execution vectors identified.

**Evidence:**
- No use of `eval()`, `Function()`, or similar dangerous functions
- No `vm` module usage with user input
- No command execution (`exec`, `spawn`) with user-controlled data
- Template literals only use validated or server-generated values
- `WHITEBOARD_URL` environment variable properly sanitized (line 164-176)

### ✅ No Arbitrary File Access Vulnerabilities Found

**Assessment:** File access is properly restricted and validated.

**Evidence:**

1. **UUID Validation Layer** (Lines 259-284)
   ```javascript
   function loadItem(itemId, ext, check) {
       if ( ! check( itemId ) ) {  // UUID validation required
           debug.log( `Invalid itemId: ${itemId}` );
           return null; 
       }
       const filePath = getFilePath(itemId, ext);
       // ... safe file operations
   }
   ```

2. **Whitelist for HTTP Requests** (Lines 478-483)
   ```javascript
   const serveableFiles = {
       '/manifest.json': { path: 'manifest.json', type: 'application/json' },
       '/sw.js': { path: 'sw.js', type: 'application/javascript' },
       // ... only these files can be served
   };
   ```

3. **Safe Path Construction** (Line 221)
   ```javascript
   const getFilePath = (uuid,ext) => path.join(DATA_DIR, `${uuid}.${ext}`);
   // UUID validated before reaching this function
   ```

4. **No User-Controlled Paths**
   - All file paths constructed using validated UUIDs or hardcoded values
   - No string concatenation with user input for file paths
   - `fs.readFile()` only used with validated paths

**Path Traversal Testing:**
- Attempted payloads like `../../etc/passwd` would fail UUID validation
- `isUuid()` regex requires proper UUID format: `/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i`

---

## Unfixed Findings (DoS / Crash Vectors)

### ⚠️ 1. CPU DoS via `create-board` endpoint [UNFIXED]

**Risk Level:** HIGH

**Issue:** Every `create-board` request runs `scryptSync` (N=16384, intentionally slow ~50-100ms) for *each* stored credential. There is no rate limiting on this endpoint.

**Attack vector:** An attacker can flood the `create-board` WebSocket message endpoint with requests. Each request triggers expensive scrypt computation across all stored credentials. This pins the server CPU at 100%, making the server (and potentially the host machine) unresponsive.

**Location:** `server.js` lines 1205-1211 (the `for` loop over `credentials` calling `verifyPassword`).

**Recommended fix:**
- Add rate limiting for `create-board` requests (e.g., max 5 per minute per IP)
- Consider asynchronous scrypt (`crypto.scrypt` instead of `crypto.scryptSync`) to avoid blocking the event loop

---

### ⚠️ 2. Crash DoS via uncaught exceptions [UNFIXED]

**Risk Level:** HIGH

**Issue:** Multiple `assert()` calls and null-dereference points exist outside try-catch blocks. While most asserts are unreachable via malformed input (verified by tracing), several null-dereference crash points remain:

**Crash points:**
- `sendPageInfo` (line 737): `page.history` — if `usePage()` returns null (e.g., disk I/O failure), accessing `.history` throws
- `ping_client_with_page` (line 786): `assert(page)` — if `usePage()` returns null
- `FULL_PAGE_REQUEST` handler (line 1232): `assert(board)` — if `useBoard()` returns null
- `REPLAY_REQUEST` handler (line 1533): `existingPage(pageUuid, board)` — if board is null, `board.pageOrder` throws

**Attack vector:** These require specific runtime conditions (e.g., disk failure, race condition during eviction) rather than purely malformed input. However, a single triggered crash kills the entire Node.js process.

**Recommended fix:**
- Add a global `uncaughtException` / `unhandledRejection` handler that logs and continues
- Add null checks before property access in the identified functions

---

### ⚠️ 3. Memory DoS via unbounded resources [UNFIXED]

**Risk Level:** MEDIUM

**Issue:** Several resources are unbounded:

1. **WebSocket message size:** No `maxPayload` limit configured. The `ws` library default is 100MB per message. An attacker can send large messages to exhaust memory.
2. **Connection limit:** No limit on concurrent WebSocket connections. An attacker can open thousands of connections.
3. **Page history growth:** Each draw/erase action appends to `page.history` with no cap. A client with board password can grow history indefinitely, exhausting disk and memory.
4. **Number of boards/pages:** No limit on total boards or pages.

**Location:** `server.js` line 640 (WebSocket server creation — no `maxPayload`), `shared.js` `handleEditAction` (no history cap).

**Recommended fix:**
- Set `maxPayload` on the WebSocket server (e.g., 1MB)
- Add a connection limit (e.g., max 100 concurrent clients)
- Add a page history size cap (e.g., max 10000 edits per page)

---

### ⚠️ 4. Docker runs as root [UNFIXED]

**Risk Level:** MEDIUM

**Issue:** The `Dockerfile` does not create or switch to a non-root user. The Node.js process runs as root inside the container.

**Location:** `Dockerfile` (3 lines, no `USER` directive).

**Impact:** If any other vulnerability is discovered (e.g., a file write outside `data/`), the attacker has root privileges inside the container, increasing the blast radius.

**Recommended fix:**
```dockerfile
FROM node:20 AS builder
WORKDIR /app
RUN useradd -r -u 1001 -g root appuser
USER appuser
CMD ["npm", "start"]
```

---

### ⚠️ 5. Information disclosure via error messages [UNFIXED]

**Risk Level:** LOW

**Issue:** Line 1603 of `server.js` sends `e.message` to clients in the error response. While stack traces were removed (previous fix), the error message itself can leak internal paths, function names, and logic structure.

**Location:** `server.js` line 1603:
```javascript
const errorMessage = {
    type: "error",
    message: e.message,  // ← can leak internals
};
```

**Recommended fix:** Send a generic error message to clients; log the full error server-side only.

---

### ⚠️ 6. `x-forwarded-proto` spoofing [UNFIXED]

**Risk Level:** LOW

**Issue:** The server trusts the `x-forwarded-proto` header unconditionally (line 539) to determine if the connection is secure (for HSTS). If the server is accessed directly (not behind a trusted reverse proxy), an attacker can spoof this header.

**Location:** `server.js` line 539-540:
```javascript
const forwardedProto = req.headers['x-forwarded-proto'];
const isSecure = forwardedProto === 'https' || req.connection.encrypted;
```

**Impact:** An attacker could trick the server into sending HSTS headers over plain HTTP, or suppress HSTS over HTTPS. Low impact in practice since the server is designed to run behind nginx.

**Recommended fix:** Only trust `x-forwarded-proto` when behind a configured proxy, or make it configurable via environment variable.

---

## Resolved Issues

### ✅ GROUP sub-action validation (assert crash + stack overflow) [FIXED]

**Issue:** `is_invalid_action_payload` validated the top-level action type but did not recursively validate GROUP sub-actions. A client could send a GROUP containing sub-actions with types like `undo`, `redo`, `new page`, or `delete page` — types that `commitEdit` doesn't handle, hitting `assert(false)` and crashing the server. The same gap allowed unbounded nesting depth, risking stack overflow.

**Fix:** In `shared.js`, the GROUP case of `is_invalid_action_payload` now:
1. Recursively validates each sub-action
2. Restricts sub-action types to `DRAW`, `ERASE`, `GROUP` only
3. Enforces a max nesting depth of 10 (`MAX_GROUP_DEPTH`)

**Status:** ✅ Resolved

### ✅ Information Disclosure via Stack Traces [FIXED]

**Issue:** Error handling exposed stack traces to clients (Line 1333)

**Before:**
```javascript
const errorMessage = {
    type: "error",
    message: e.message,
    stack: e.stack  // ← Leaked server internals
};
```

**After:**
```javascript
const errorMessage = {
    type: "error",
    message: e.message
    // stack removed
};
```

**Status:** ✅ Resolved

---

## Security Controls Implemented

### 1. Message Validation Layer ✅

Comprehensive validation functions prevent malformed messages:

- `is_invalid_REGISTER_BOARD_message()`
- `is_invalid_REGISTER_PAGE_message()`
- `is_invalid_PAGE_INFO_REQUEST_message()`
- `is_invalid_CREATE_BOARD_message()`
- `is_invalid_FULL_PAGE_REQUESTS_message()`
- `is_invalid_MOD_ACTION_PROPOSALS_message()`
- `is_invalid_REPLAY_REQUESTS_message()`

**Protection against:**
- Type confusion attacks
- Missing required fields
- Invalid UUID formats
- Non-numeric delta values
- Malformed action payloads
- Invalid GROUP sub-action types (recursive validation)

### 2. UUID-Based Access Control ✅

All file operations require valid UUIDs:

```javascript
function isUuid(str) {
  const regex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return regex.test(str);
}
```

**Ensures:**
- No path traversal (`../`, `..\\`)
- No absolute paths (`/etc/passwd`)
- No null bytes or special characters
- Cryptographically random identifiers via `crypto.randomBytes(16)`

### 3. Safe Deserialization ✅

The `deserialize()` function (shared.js:71-87) safely handles custom types:

```javascript
const deserialize = (jsonString) => {
    const reviver = (key, value) => {
        if (value && typeof value === 'object' && !Array.isArray(value)) {
            if (value.__type === 'BigInt') {
                return BigInt(value.value);
            }
            if (value.__type === 'Set') {
                return new Set(value.value);
            }
            if (value.__type === 'Map') {
                return new Map(value.value);
            }
        }
        return value;
    };
    return JSON.parse(jsonString, reviver);
};
```

**Protection against:**
- Prototype pollution (no `__proto__` or `constructor` handling)
- Arbitrary code execution through deserialization
- Only handles safe types: BigInt, Set, Map

### 4. Password Authentication ✅

Secure password verification using scrypt (Lines 104-153):

- **Key derivation:** scrypt with N=16384, r=8, p=1
- **Salt:** 32 bytes (256 bits) of random data
- **Timing-safe comparison:** `crypto.timingSafeEqual()`
- **Memory-hard:** Resistant to GPU/ASIC attacks

### 5. HTTP Security Headers ✅

HSTS header for HTTPS connections (Line 497):
```javascript
res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
```

### 6. Assert Safety ✅

All `assert()` calls in the codebase were traced to verify they cannot be triggered by malformed input. The one assert that was reachable (`assert(false)` in `commitEdit` via GROUP sub-actions) has been fixed. Remaining asserts are only reachable on programmer error or runtime failure (disk I/O), not malformed client input.

---

## Recommendations

### 1. DoS Hardening (Priority)

Implement the following to protect against denial of service:
- **Rate limiting** for `create-board` requests (CPU DoS)
- **WebSocket `maxPayload`** limit (memory DoS)
- **Connection limit** (resource exhaustion)
- **Page history size cap** (disk/memory DoS)
- **Global `uncaughtException` handler** (crash resilience)

### 2. Docker Hardening

- Run the container as a non-root user
- Consider read-only filesystem for the app directory (only `data/` writable)

### 3. Monitoring & Logging
Consider implementing:
- Rate limiting for failed authentication attempts
- Alerting for unusual file access patterns
- Monitoring for validation failures (potential attack attempts)

### 4. Regular Security Reviews
- Periodic code audits when adding new message handlers
- Review any new file operations for UUID validation
- Test deserialization with malicious payloads
- Trace assert reachability for any new assert() calls

### 5. Future Enhancements
Consider adding:
- Content Security Policy (CSP) headers
- Rate limiting on WebSocket connections
- Failed authentication lockout mechanism
- Configurable trust for `x-forwarded-proto` header

---

## Test Cases (Theoretical)

### Path Traversal Attempts (All Blocked ✅)
```
../../../etc/passwd          → Fails UUID validation
..\\..\\..\\windows\\system32 → Fails UUID validation
%2e%2e%2f%2e%2e%2f%2e%2e%2f   → Fails UUID validation
/etc/passwd                    → Fails UUID validation
```

### RCE Attempts (All Blocked ✅)
- No `eval()` to exploit
- No `Function()` constructor accessible
- No command injection vectors
- Template literals use only validated data

### Deserialization Attacks (All Blocked ✅)
```json
{"__proto__": {"polluted": true}}        → Not processed
{"constructor": {"prototype": {}}}       → Not processed
{"__type": "Function", "value": "..."}  → Only BigInt/Set/Map allowed
```

### GROUP Sub-action Attacks (All Blocked ✅ after fix)
```json
{"type": "group", "actions": [{"type": "undo", ...}]}        → Rejected (invalid sub-type)
{"type": "group", "actions": [{"type": "delete page", ...}]} → Rejected (invalid sub-type)
{"type": "group", "actions": [{"type": "group", "actions": [...deeply nested...] }]} → Rejected (depth > 10)
{"type": "group", "actions": ["not-an-object"]}              → Rejected (invalid sub-action)
```

---

## Conclusion

The kubux-whiteboard-server demonstrates strong security practices for preventing RCE and arbitrary file access vulnerabilities. The implemented validation layer, combined with UUID-based file access controls and safe deserialization, provides robust protection against these critical attack vectors.

However, several DoS and crash vectors remain unfixed. These do not allow system compromise but could allow an attacker to disrupt service availability. The most critical unfixed issues are:
1. CPU DoS via unauthenticated `create-board` endpoint
2. Crash DoS via uncaught exceptions (requires specific runtime conditions)
3. Memory DoS via unbounded WebSocket messages and connections

**Action required:** Implement DoS hardening measures listed in the Recommendations section.

---

**Document Version:** 2.0  
**Last Updated:** July 1, 2026  
**Next Review:** Recommend review after DoS hardening is implemented
