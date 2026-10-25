# Security Audit Report: kubux-whiteboard-server

**Audit Date:** October 25, 2026
**Auditor:** Security Review (re-audit of v2.2)
**Version:** Current (commit 79fc50a — HEAD; server.js, shared.js, index.html all changed after v2.2)
**Focus Areas:** RCE, Arbitrary File Access, DoS, Crash Vectors, Client-Side XSS

---

## Executive Summary

Re-audit of `server.js`, `shared.js` and `index.html` at HEAD. Unlike v2.2 (static only), the findings in this version were **verified against a live test instance** (`ws://localhost:8099`, isolated data/log dirs).

**Overall Assessment:** ⚠️ **No RCE, no file access, no XSS, no client-reachable crash. DoS surface reduced but still exploitable; two new findings.**

| # | Finding | Severity | Status |
|---|---------|----------|--------|
| 1 | `create-board` scrypt flood (no rate limit) | HIGH | Open; partially mitigated vs v2.2 |
| 2 | Unbounded error-log growth → disk-full crash | MEDIUM | Open (**new** in v3.0) |
| 3 | Plaintext board passwords in `logs/debug.log` | MEDIUM | Open (**new** in v3.0) |
| 4 | Unbounded state: history, pages, deletionMap, files | MEDIUM | Open (unchanged) |
| 5 | No Origin check on WebSocket handshake | LOW | Open (**new** in v3.0) |
| 6 | `x-forwarded-proto` trusted unconditionally | LOW | Open (unchanged) |
| 7 | Error details (`e.message`) sent to clients | LOW | Open (unchanged) |
| 8 | Dockerfile: `node:20` cannot start the server; runs as root | INFRA | Open (**new** in v3.0) |

Key changes vs v2.2:
- **`create-board` CPU DoS recharacterized:** `scryptSync` was replaced by async `crypto.scrypt`. The event loop is *not* blocked anymore — measured fullPage latency of **3 ms during a sustained 60-connection flood** (v2.2 predicted "pins CPU at 100%, unresponsive host" — that impact is gone). The remaining impact is worker-pool starvation: legitimate board creation queues behind an attacker's jobs, and the queue is unbounded (memory). About **50 attempts/sec** were sustained from 60 connections, each attempt costing **one scrypt per stored credential** (~100 ms, 16 MiB each; currently 2 credentials).
- **`maxPayload` enforced.** A 6 MiB message closed the connection (limit 5 MB, commit d6197cd). `ws` upgraded to 8.22.0 (CVE-2026-48779, commit c9694cb).
- **GROUP validation verified live:** a depth-15 nested GROUP payload is silently dropped (`MAX_GROUP_DEPTH = 10`), closing the v2.2 assert-crash / stack-overflow finding.
- **New log-growth finding:** every malformed message writes one `debug.error` line with no cap or rotation. Measured ~1000 lines/s ≈ 87 KB/s from a *single* connection. A full disk turns into a crash: `writeFileAtomic` throws inside the 10 s persist timer (unhandled), losing up to 10 s of edits.
- **New data-exposure finding:** the existing `logs/debug.log` contains board passwords in cleartext (`passwd: 'e0k5ndiszdig'` ×N), written by a pre-current logging configuration. The current config sends `debug.log` to a NullStream, making the entire payload-logging layer dead code — the live leak is one commented-out line away (server.js:71–72).

---

## Audit Scope & Methodology

### In Scope
- All client-to-server message handlers
- File system operations
- Deserialization of user input
- Path construction logic
- HTTP request handling
- WebSocket message routing
- Denial of Service (DoS) / crash vectors via malformed input
- Client-side (index.html) DOM injection / credential storage

### Methodology
1. **Static analysis** of all handlers and validation routines
2. **Live testing** on an isolated instance:
   - HTTP layer: `/.env` → 403, `/%2e%2e%2f…etc/passwd` → 403, `/server.js` → 404, whitelist (`/manifest.json`) → 200
   - Unauthenticated `register-board` + `fullPage-requests` → full page history (view access, by design)
   - `create-board` with wrong credential → rejected; sustained rate measured (~50 attempts/s from 60 connections; event loop latency 3 ms under flood)
   - GROUP nesting depth 15 → dropped by validation
   - MOD_ACTION with wrong password → `decline("unauthorized")`
   - `maxPayload`: 6 MiB message → connection closed
   - 500 000-deep JSON array → parsed, rejected as unknown type — **no crash** (V8 depth-safe)
   - 3000 invalid messages → ~3000 `Rejected message` log lines in 3 s (87 KB/s log growth)
3. **Assert reachability re-analysis** (all `assert()` calls traced; see Resolved)
4. **Client-side XSS sweep** (DOM sinks, credential storage)

---

## Critical Findings

### ✅ No RCE Vulnerabilities
Unchanged from v2.2: no `eval`/`Function()`/`vm`, no command execution, no user input on template-literal paths. Re-confirmed.

### ✅ No Arbitrary File Access Vulnerabilities
Unchanged and re-verified live:
- `isUuid()` gate on every file-ID path (`getFilePath` = `path.join(DATA_DIR, uuid.ext)`)
- HTTP static serving is an exact-match whitelist (`serveableFiles`), traversal and hidden-file segments blocked before any read
- Traversal probes returned 403/404, never a file body

### ✅ No Deserialization Vulnerabilities
Unchanged: `deserialize` reviver handles only `__type: BigInt|Set|Map`; no `__proto__`/`constructor` handling.

### ✅ No Client-Side XSS (new verification)
- All DOM text assignment goes through `textContent` (incl. server error messages)
- Strokes are rendered on `<canvas>`; stroke colors regex-restricted (`#RGB`/`#RRGGBB`/`[a-z]{1,20}`)
- The only `innerHTML` assignments are static icon glyphs (cap/join style menus)
- Storage audit: the server-level credential is persisted to `localStorage['whiteboard_credential']` (design decision; see Recommendation 8)

---

## Findings

### ⚠️ 1. `create-board` scrypt flood — no rate limiting [OPEN, recharacterized]

**Risk Level:** HIGH (availability of board creation; memory via unbounded queue)

**Old impact (v2.2):** "pins the server CPU at 100%" — **no longer true.** `verifyPassword` now uses async `crypto.scrypt` (worker pool), verified: fullPage latency stayed at **3 ms** while 60 connections hammered `create-board` for 2 s (~60 attempts served).

**Current impact (measured):**
- ~50 attempts/sec sustained from 60 connections; each attempt = **one scrypt per stored credential** (currently 2 × ~100 ms, 16 MiB memory each).
- Node's worker pool saturates: legitimate `create-board` requests (and any other pool work) starve behind attacker jobs.
- Pending scrypt jobs queue without bound → memory exhaustion with enough connections.
- `ws.credentialCheckPending` serializes checks *per connection* only; connections are unlimited.

**Location:** `server.js` `CREATE_BOARD` handler (1411–1442), `isValidCredential` (180–187), `verifyPassword` (141–177).

**Recommended fix:**
- Token-bucket rate limit per IP on `create-board` (e.g., 5/min)
- Cap concurrent WebSocket connections per IP and globally
- Cap the number of stored credentials (flood cost is linear in it)

---

### ⚠️ 2. Unbounded error-log growth → disk-full crash chain [OPEN — NEW]

**Risk Level:** MEDIUM (unauthenticated; slow disk fill, then process crash + data loss)

Every malformed message (invalid JSON, unknown `type`) reaches `rejectMessage` → `debug.error(...)`, one line per message, appended to `logs/debug.log` with **no cap and no rotation**. Measured: a single connection sustained **~3000 lines / 3 s ≈ 87 KB/s**. Multiple connections scale linearly.

**Crash chain:** when the disk fills, `writeFileAtomic` throws (ENOSPC) inside `periodicallyPersist` (10 s timer) — unhandled → process crash, losing up to 10 s of edits.

**Location:** `server.js` `rejectMessage` (1803), `periodicallyPersist` (1875), `writeFileAtomic` (301).

**Recommended fix:** log rotation + size cap; rate-limit malformed-input logging (dedupe per second); catch/tolerate persist failures (log + retry) instead of crashing.

---

### ⚠️ 3. Plaintext board passwords in `logs/debug.log` [OPEN — NEW]

**Risk Level:** MEDIUM (historical credential exposure + fragile config)

The existing production `logs/debug.log` (~792 KB) contains board passwords in cleartext: `passwd: 'e0k5ndiszdig'` (and others) in the `BOARD_CREATED` payload dumps and incoming `shuffle-proposal`/`mod-action-proposals` messages.

**Why:** an earlier run used `new Console({ stdout: debugTee, stderr: debugTee })` (server.js:72, now commented out), logging every sent/received message with full payload. The **current** config (`stdout: debugNull`) sends `debug.log` to a NullStream — the entire payload-logging layer (`routeMessage`, `logSentMessage`) is dead code. The live leak is one commented-out line away from being re-enabled.

**Additional notes:** the file is never rotated/truncated; board passwords persist in it indefinitely.

**Recommended fix:** rotate/truncate the existing log file; delete the commented-out `debugTee` stdout configs; never log `passwd` fields; if payload logging is ever re-enabled, redact secrets.

---

### ⚠️ 4. Unbounded state for authorized users [OPEN, unchanged]

**Risk Level:** MEDIUM (disk + memory + CPU exhaustion; requires board password — shared with collaborators by design in readme.md)

- Page **history grows without bound** (no cap on `handleEditAction`); each action is stored + hashed + persisted every 10 s.
- **Page count** and **`deletionMap`** grow without bound; a deleted page's **file is never removed from disk**; `to_be_removed.json` grows without bound.
- `existingPage` walks deletion chains — length unbounded (assert-guarded against cycles, so no hang, but O(chain) per lookup).
- Each top-level GROUP action deep-clones the whole visual state (`structuredClone` in `commitGroup`) — an O(page-size) cost per GROUP a member can send at will.

**Recommended fix:** history cap (e.g., 100 000 actions/page), page/board caps, delete page files on `delete page`, cap `deletionMap`, avoid the full-state clone per GROUP.

---

### ⚠️ 5. No Origin check on WebSocket handshake [OPEN — NEW]

**Risk Level:** LOW

`wss.on('connection', ...)` (server.js:1839) never inspects `req.headers.origin`. Any webpage can open a WebSocket to the server and act as an unauthenticated client (read boards whose ID is known — view access is open by design; participate in the DoS vectors above). Impact is bounded because every privileged action requires the board password or admin credential, which live in the URL / `localStorage` — a cookie-based session this is not. Still, with any future credential-bearing cookie or same-origin-gapless auth change, missing Origin verification becomes CSWSH.

**Recommended fix:** verify `Origin` against the configured host, or deny cross-origin handshakes.

---

### ⚠️ 6. `x-forwarded-proto` spoofing [OPEN, unchanged]

**Risk Level:** LOW — HSTS is emitted when the header says `https`, even on plain HTTP (server.js:715–722). Only trustworthy when the server sits behind the documented nginx proxy. Make proxy trust configurable.

### ⚠️ 7. Error details sent to clients [OPEN, unchanged]

**Risk Level:** LOW — `routeMessage` sends `JSON.parse` failure messages back to clients (`rejectMessage(ws, e.message)`). Not a stack trace, but leaks parser internals; log full detail server-side, send a generic message.

---

## Deployment Findings

### ⚠️ 8. Dockerfile cannot start the server [NEW]

`FROM node:20` — but `server.js` requires `module 'console'` (line 14) and uses `fs.createWriteStream` (line 19), both of which need **Node ≥ 23**. A standalone `docker build` produces a container that exits at startup (`MODULE_NOT_FOUND`). It also runs as root (no `USER`).

**Note:** the documented `docker-compose.yml` path is fine — `user: "1000:1000"`, app mounted `:ro`, only `data/` + `logs/` writable. Fix the Dockerfile base image (e.g. `node:24`) and add `USER`.

### ℹ️ `passwd_hash` shell-injection footgun

`node -e "…hashPassword('$passwd')…"` interpolates the password into a JS string literal inside shell double quotes. Embedded `'` runs arbitrary JS as the admin who invoked the tool. **Not remotely exploitable** (local admin tool, self-inflicted), but the utility should quote/clean its input.

### ℹ️ `generatePasswd` modulo bias

`b % 36` with `b ∈ [0,255]` makes digits 0–3 slightly more likely (8/256 vs 7/256). Negligible — the 12-char base36 keyspace (~62 bits) dominates; constant-time compare (79fc50a) prevents timing attacks.

---

## Resolved Since v2.2 (verified)

### ✅ GROUP sub-action validation (assert crash + stack overflow) [FIXED, verified live]
`is_invalid_action_payload` recursively validates GROUP sub-actions (DRAW/ERASE/GROUP only) and enforces `MAX_GROUP_DEPTH = 10`. A depth-15 payload was dropped by validation on the live instance. `assert(false)` in `commitEdit` is no longer input-reachable.

### ✅ WebSocket message size limit [FIXED, verified live]
`maxPayload: 5 * 1024 * 1024`; a 6 MiB message closed the connection. (v2.2 flagged the 100 MiB default.)

### ✅ ws library CVE [FIXED]
`ws` 8.22.0 (CVE-2026-48779, commit c9694cb).

### ✅ CPU-blocking scrypt [PARTIALLY FIXED]
`scryptSync` → async `crypto.scrypt` (worker pool): event loop stays responsive under flood (measured 3 ms). Residual issue: worker-pool starvation + unbounded queue (Finding 1).

### ✅ Constant-time board-password comparison [FIXED]
SHA-256 digests compared with `crypto.timingSafeEqual` (commit 79fc50a): no length leak, no timing leak.

### ✅ Corrupted-file crash [FIXED, confirmed in code]
`loadItem` wraps read/deserialize in try-catch → `null` (cache miss) instead of crashing.

### ✅ Crash via deep JSON nesting [NOT A FINDING, verified live]
500 000-deep array parsed without crash (V8 is depth-safe here).

---

## Security Controls Implemented (verified)

1. **Message validation layer** — every handler validates before use; GROUP sub-actions recursively.
2. **UUID-based access control** — `isUuid` gates all file IDs and message IDs; no traversal.
3. **Safe deserialization** — BigInt/Set/Map only; no prototype pollution.
4. **scrypt password auth** — N=16384/r=8/p=1, 32-byte salt, timing-safe compare.
5. **HTTP hardening** — whitelist serving, hidden-file block, HSTS (behind proxy).
6. **Assert safety** — all remaining asserts reachable only via disk damage/programmer error, not malformed input.

---

## Recommendations (prioritized)

1. **Rate-limit `create-board`** (per IP/per connection) and **cap WebSocket connections** (Finding 1).
2. **Log rotation + size cap + malformed-input logging rate limit**; make persist failures non-fatal (Finding 2).
3. **Rotate/truncate existing `debug.log`; remove secret-logging configs** (Finding 3).
4. **State caps + GC:** history per page, page count, `deletionMap`, delete page files (Finding 4).
5. **Verify `Origin` on the WS handshake** (Finding 5).
6. **Fix Dockerfile:** `node:24` base, non-root user (Finding 8).
7. **Configurable proxy trust** for `x-forwarded-proto` (Finding 6); generic client error messages (Finding 7).
8. **Storage note:** the admin credential persists in `localStorage['whiteboard_credential']` — acceptable only while there is no XSS and the machine is single-user; add CSP as defense-in-depth.

---

## Test Cases (live, Oct 25, 2026)

| Test | Result |
|------|--------|
| `GET /.env` | 403 Access Denied |
| `GET /..%2f..%2fetc%2fpasswd`, `GET /server.js` | 403 / 404 |
| `GET /manifest.json` (whitelist) | 200 |
| unauthenticated `register-board` + `fullPage-requests` | full history returned (view access by design) |
| `create-board` wrong credential ×2 | `error: credential not accepted`; flood: ~50 attempts/s from 60 conns; 3 ms fullPage latency under flood |
| GROUP nesting depth 15 | dropped (validation) |
| MOD_ACTION wrong password | `decline(unauthorized)` |
| 6 MiB WebSocket message | connection closed (maxPayload) |
| 500 000-deep JSON array | rejected, no crash |
| 3000 invalid messages | ~3000 log lines ≈ 87 KB/s log growth |

---

## Conclusion

The kubux-whiteboard-server remains solid against RCE, file access, deserialization and XSS, and the crash-on-malformed-input class is closed. The DoS surface is smaller than v2.2 suggested (event loop survives the scrypt flood; message sizes are capped), but three availability issues remain exploitable: **unauthenticated scrypt flooding** (HIGH), **log-growth disk fill** (MEDIUM) and **unbounded state growth by board members** (MEDIUM) — plus a historical credential exposure in the unrotated log file. One deployment bug stands out: the provided Dockerfile cannot run the server on its declared base image.

**Action required:** Findings 1–4 (rate limits, log management, state caps) before Findings 5–8.

---

**Document Version:** 3.0
**Last Updated:** October 25, 2026
**Next Review:** after Findings 1–4 are addressed

**Changelog 3.0 (Oct 25, 2026):** Full re-audit at HEAD 79fc50a with live verification. Recharacterized Finding 1 (async scrypt: event loop no longer blocked; impact is worker-pool starvation + unbounded queue — with measurements). Added Findings 2 (error-log disk fill → crash), 3 (plaintext passwords in existing debug.log, dead logging config), 5 (missing Origin check), 8 (Dockerfile node:20 broken). Marked GROUP fix, maxPayload, ws 8.22.0, constant-time compare, corrupt-file guard as verified. Added client-side XSS verification and live test-case table. v2.2 Finding 2 (memory DoS) superseded in part: maxPayload fixed, connection/history caps still open (Finding 4).