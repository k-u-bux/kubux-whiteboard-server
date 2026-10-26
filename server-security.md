# Security Audit Report: kubux-whiteboard-server

**Audit Date:** October 25, 2026
**Auditor:** Security Review (re-audit of v2.2)
**Version:** Live tests at commit 79fc50a + working tree; text corrected against commit d414690 (see Changelog 3.2); unauthenticated board-creation search (see Changelog 3.3)
**Focus Areas:** RCE, Arbitrary File Access, DoS, Crash Vectors, Client-Side XSS

---

## Executive Summary

Re-audit of `server.js`, `shared.js` and `index.html` at HEAD. Unlike v2.2 (static only), the findings in this version were **verified against a live test instance** (`ws://localhost:8099`, isolated data/log dirs).

**Overall Assessment:** ⚠️ **No RCE, no file access, no XSS, no client-reachable crash. DoS surface reduced but still exploitable; two new findings. No way to create a board without the server credential exists (verified live, v3.3).**

| # | Finding | Severity | Status |
|---|---------|----------|--------|
| 1 | Owner-message scrypt flood (no rate limit) | HIGH | Open; one scrypt per message since logins (was one per stored credential) |
| 2 | Unbounded error-log growth → disk-full crash | MEDIUM | Open (**new** in v3.0) |
| 3 | Plaintext board passwords in `logs/debug.log` | MEDIUM | Partially fixed: payload logging redacts `passwd` since d414690; the old log file remains |
| 4 | Unbounded state: history, pages, deletionMap, files | MEDIUM | Open (unchanged) |
| 5 | No Origin check on WebSocket handshake | LOW | Open (**new** in v3.0) |
| 6 | `x-forwarded-proto` trusted unconditionally | LOW | Open (unchanged) |
| 7 | Error details (`e.message`) sent to clients | LOW | Open (unchanged) |
| 8 | Dockerfile runs as root (no `USER`); base image bumped to `node:23` | MEDIUM | Open; bump verified, startup claim retracted (Erratum) |

Key changes vs v2.2:
- **`create-board` CPU DoS recharacterized:** `scryptSync` was replaced by async `crypto.scrypt`. The event loop is *not* blocked anymore — measured fullPage latency of **3 ms during a sustained 60-connection flood** (v2.2 predicted "pins CPU at 100%, unresponsive host" — that impact is gone). The remaining impact is worker-pool starvation: legitimate board creation queues behind an attacker's jobs, and the queue is unbounded (memory). About **50 attempts/sec** were sustained from 60 connections, each attempt costing **one scrypt per stored credential** (~100 ms, 16 MiB each; currently 2 credentials).
- **`maxPayload` enforced.** A 6 MiB message closed the connection (limit 5 MB, commit d6197cd). `ws` upgraded to 8.22.0 (CVE-2026-48779, commit c9694cb).
- **GROUP validation verified live:** a depth-15 nested GROUP payload is silently dropped (`MAX_GROUP_DEPTH = 10`), closing the v2.2 assert-crash / stack-overflow finding.
- **New log-growth finding:** every malformed message writes one `debug.error` line with no cap or rotation. Measured ~1000 lines/s ≈ 87 KB/s from a *single* connection. A full disk turns into a crash: `writeFileAtomic` throws inside the 10 s persist timer (unhandled), losing up to 10 s of edits.
- **New data-exposure finding:** the existing `logs/debug.log` contains board passwords in cleartext (`passwd: 'e0k5ndiszdig'` ×N), written by a pre-current logging configuration. The current config sends `debug.log` to a NullStream, making the entire payload-logging layer dead code. Since commit d414690 that layer masks every `passwd` field (`redactSecrets`), so re-enabling the commented-out configs (server.js:71–72) no longer leaks passwords.
- **Erratum (v3.0 → v3.1):** v3.0's claim that the Dockerfile's `node:20` base "cannot start the server" was **wrong**. A full boot test under node **v20.18.1** succeeded (HTTP 200, WS up, scrypt credential check working) — Node 20.18 has `require('console')`, `require('stream')`, `fs.createWriteStream` and async `crypto.scrypt`. The bump to `node:23` was **verified the same way under v23.11.1** (the version the `node:23` tag resolves to). The bump is still correct: Node 20 went end-of-life 2026-04-30 (nixpkgs removed it). The Dockerfile's real open issue is running as root (Finding 8).

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
- The only `innerHTML` assignments are static icon glyphs (cap/join style menus) and clearing the overview grid (`''`)
- Storage audit: the server-level credential is persisted to `localStorage['whiteboard_credential']` (design decision; see Recommendation 8)

---

## Findings

### ⚠️ 1. Owner-message scrypt flood — no rate limiting [OPEN, recharacterized for logins]

**Risk Level:** HIGH (availability of board management; memory via unbounded queue)

**Since logins (development branch):** every owner message (`create-board`, `list-boards`, `set-path`, `rename-prefix`, `change-credential`) carries a login and credential and is checked on its own; the server keeps no login state. Anyone can send these messages without an account. `checkLogin` reads `conf/users.json` (the server keeps no copy, so a user the admin removes loses access at once; the small, cached file costs far less than the scrypt), looks up the login and runs **one scrypt per message** (~50 ms, 16 MiB), whatever the number of users; an unknown login is checked against a dummy hash, so it costs the same and gets the same answer as a wrong credential (no login oracle). Before, every `create-board` attempt cost one scrypt **per stored credential**, so the cost per attempt no longer grows with the number of users.

**What is unchanged:**
- Attempts are **unlimited across connections**. `ws.credentialCheckPending` (`asOwner`) allows one check at a time *per connection* only; connections are unlimited.
- Node's worker pool saturates: legitimate owner messages (and any other pool work) queue behind an attacker's checks.
- Pending scrypt jobs queue without bound → memory exhaustion with enough connections.
- A valid owner also pays one scrypt per management action; `change-credential` adds a second one (hash of the new credential).

**Old impact (v2.2):** "pins the server CPU at 100%" — no longer true since async `crypto.scrypt`.

**Measurements (v3.0, before logins):** fullPage latency stayed at **3 ms** while 60 connections hammered `create-board`; about **50 attempts/s** were sustained, each costing one scrypt per stored credential (2 credentials then). The same flood against an owner message costs half the scrypt work per attempt with 2 users; not re-measured.

**Location:** `server.js` `asOwner` (1596–1616), owner handlers (1619–1774), `checkLogin` (195–199), `verifyPassword` (155–191).

**Recommended fix:**
- Token-bucket rate limit per IP on owner messages (e.g., 5/min), perhaps also per login
- Cap concurrent WebSocket connections per IP and globally

---

### ⚠️ 2. Unbounded error-log growth → disk-full crash chain [OPEN — NEW]

**Risk Level:** MEDIUM (unauthenticated; slow disk fill, then process crash + data loss)

Every malformed message (invalid JSON, unknown `type`) reaches `rejectMessage` → `debug.error(...)`, one line per message, appended to `logs/debug.log` with **no cap and no rotation**. Measured: a single connection sustained **~3000 lines / 3 s ≈ 87 KB/s**. Multiple connections scale linearly.

**Crash chain:** when the disk fills, `writeFileAtomic` throws (ENOSPC) inside `periodicallyPersist` (10 s timer) — unhandled → process crash, losing up to 10 s of edits.

**Location:** `server.js` `rejectMessage` (1809), `periodicallyPersist` (1881), `writeFileAtomic` (301).

**Recommended fix:** log rotation + size cap; rate-limit malformed-input logging (dedupe per second); catch/tolerate persist failures (log + retry) instead of crashing.

---

### ⚠️ 3. Plaintext board passwords in `logs/debug.log` [PARTIALLY FIXED]

**Risk Level:** MEDIUM (historical credential exposure + fragile config)

The existing production `logs/debug.log` (~792 KB) contains board passwords in cleartext: `passwd: 'e0k5ndiszdig'` (and others) in the `BOARD_CREATED` payload dumps and incoming `shuffle-proposal`/`mod-action-proposals` messages.

**Why:** an earlier run used `new Console({ stdout: debugTee, stderr: debugTee })` (server.js:72, now commented out), logging every sent/received message with full payload. The **current** config (`stdout: debugNull`) sends `debug.log` to a NullStream — the entire payload-logging layer (`routeMessage`, `logSentMessage`) is dead code.

**Fixed since d414690:** `routeMessage`, `logSentMessage` and the dropped-proposal log of `mod-action-proposals` pass payloads through `redactSecrets`, which masks every `passwd` field (the key used for board passwords and credentials on the wire). Re-enabling payload logging therefore no longer writes passwords.

**Additional notes:** the file is never rotated/truncated; board passwords persist in it indefinitely.

**Recommended fix (remaining):** rotate/truncate the existing log file; delete the commented-out `debugTee` stdout configs.

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

`wss.on('connection', ...)` (server.js:1845) never inspects `req.headers.origin`. Any webpage can open a WebSocket to the server and act as an unauthenticated client (read boards whose ID is known — view access is open by design; participate in the DoS vectors above). Impact is bounded because every privileged action requires the board password or admin credential, which live in the URL / `localStorage` — a cookie-based session this is not. Still, with any future credential-bearing cookie or same-origin-gapless auth change, missing Origin verification becomes CSWSH.

**Recommended fix:** verify `Origin` against the configured host, or deny cross-origin handshakes.

---

### ⚠️ 6. `x-forwarded-proto` spoofing [OPEN, unchanged]

**Risk Level:** LOW — HSTS is emitted when the header says `https`, even on plain HTTP (server.js:715–722). Only trustworthy when the server sits behind the documented nginx proxy. Make proxy trust configurable.

### ⚠️ 7. Error details sent to clients [OPEN, unchanged]

**Risk Level:** LOW — `routeMessage` sends `JSON.parse` failure messages back to clients (`rejectMessage(ws, e.message)`). Not a stack trace, but leaks parser internals; log full detail server-side, send a generic message.

---

## Deployment Findings

### ⚠️ 8. Dockerfile runs as root [OPEN — Erratum: "cannot start" claim retracted]

**Risk Level:** MEDIUM (unchanged from v2.2)

**Remaining issue:** the standalone `Dockerfile` has no `USER` directive — the Node.js process runs as root inside the container. If any file-write vulnerability appears, the blast radius is root. (The documented `docker-compose.yml` path already mitigates this: `user: "1000:1000"`, app mounted `:ro`, only `data/` + `logs/` writable.)

**Erratum — the v3.0 startup claim was wrong:** v3.0 stated the `node:20` base "cannot start the server" because of `require('console')` / `fs.createWriteStream`. **Retracted.** Verified by booting the server under official binaries:
- **node v20.18.1:** full boot OK — HTTP 200, WebSocket up, scrypt credential check returns the expected rejection.
- **node v23.11.1** (= what the `node:23` tag resolves to): same tests, all OK.

Node 20.18 has `console`/`stream`/`fs.createWriteStream`/async `crypto.scrypt`. The `node:20` → `node:23` bump (Dockerfile, Oct 25, 2026) is still a correct change: Node 20 reached end-of-life 2026-04-30 (removed from nixpkgs), and pinning a current LTS avoids future module drift.

**Recommended fix:** add `RUN useradd -r -u 1001 appuser` + `USER appuser` to the standalone `Dockerfile` (as v2.2 originally suggested); the compose override stays.

### ℹ️ `passwd_hash` shell-injection footgun

`node -e "…hashPassword('$passwd')…"` interpolates the password into a JS string literal inside shell double quotes. Embedded `'` runs arbitrary JS as the admin who invoked the tool. **Not remotely exploitable** (local admin tool, self-inflicted), but the utility should quote/clean its input.

### ℹ️ Stale credential backup `conf/passwd.json~`

The repo ships a leftover backup `conf/passwd.json~` containing a single legacy **salt-less** hash (one hex string, no `:`), which the current `salt:hash` splitter in `verifyPassword` rejects. It is **never loaded** (`initializeGlobals` reads only `conf/passwd.json`) and **not served** (HTTP dotfile block + static whitelist). Inert; delete it for hygiene.

### ℹ️ Damaged data files end the process (by design, not fixed)

Earlier versions of this report listed a "corrupted-file crash" as fixed by a try-catch in `loadItem`. **That is not the current code:** `loadItem` (server.js:329–344) has no try-catch, so a board or page file that is not valid JSON makes `deserialize` throw inside the message handler, and the exception ends the process. `loadPage` also throws on a stored hash chain of the wrong length. This is deliberate fail-fast behaviour (see the "Lookup invariants" comment in server.js: a damaged file "shows up as a failed assert, never as a silently recreated empty board or page"). It is reachable only through damaged or hand-edited files in `data/`, not through client input. Note that `writeFileAtomic` (temp file + fsync + rename) makes a truncated file from a crash or full disk unlikely.

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

### ✅ Crash via deep JSON nesting [NOT A FINDING, verified live]
500 000-deep array parsed without crash (V8 is depth-safe here).

---

## Security Controls Implemented (verified)

1. **Message validation layer** — every handler validates before use; GROUP sub-actions recursively.
2. **UUID-based access control** — `isUuid` gates all file IDs and message IDs; no traversal.
3. **Safe deserialization** — BigInt/Set/Map only; no prototype pollution.
4. **scrypt password auth** — N=16384/r=8/p=1, 32-byte salt, timing-safe compare; one scrypt per owner message, unknown logins cost the same as wrong credentials.
5. **HTTP hardening** — whitelist serving, hidden-file block, HSTS (behind proxy).
6. **Assert safety** — all remaining asserts reachable only via disk damage/programmer error, not malformed input.

---

## Recommendations (prioritized)

1. **Rate-limit owner messages** (per IP, perhaps per login) and **cap WebSocket connections** (Finding 1).
2. **Log rotation + size cap + malformed-input logging rate limit**; make persist failures non-fatal (Finding 2).
3. **Rotate/truncate existing `debug.log`; remove the commented-out logging configs** (Finding 3; payload redaction is done).
4. **State caps + GC:** history per page, page count, `deletionMap`, delete page files (Finding 4).
5. **Verify `Origin` on the WS handshake** (Finding 5).
6. **Fix Dockerfile:** add a non-root `USER` (base image already corrected to `node:23`, verified — Erratum; Finding 8).
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
| create-board bypass battery (missing/empty/number/array/object/null/`"true"`/`"undefined"`/`"NaN"`/1 MiB passwd, stored-hash-as-passwd, double-send race) | dropped by validation or `credential not accepted`; exactly **1 board per check**; **0 files created** |
| indirect-creation battery (register-board, board-info(register), fullPage, page-info(register), replay, register-page, mod-action draw / new-page, shuffle-proposal — all on unknown boards) | all dropped silently, zero replies, **0 `.board`/`.page` files** created |
| WS path strictness (`//ws`, `/ws?x=1`), HTTP methods POST/HEAD/OPTIONS on `/` | 400 / 404 / 200 (app page only, no state change) |

---

## Conclusion

The kubux-whiteboard-server remains solid against RCE, file access, deserialization, XSS and — verified live in v3.3 — **unauthorized board creation**, and the crash-on-malformed-input class is closed. The DoS surface is smaller than v2.2 suggested (event loop survives the scrypt flood; message sizes are capped), but three availability issues remain exploitable: **unauthenticated scrypt flooding** (HIGH), **log-growth disk fill** (MEDIUM) and **unbounded state growth by board members** (MEDIUM) — plus a historical credential exposure in the unrotated log file. The Dockerfile was bumped to `node:23` (verified working) and its only remaining deployment issue is running as root.

**Action required:** Findings 1–4 (rate limits, log management, state caps) before Findings 5–8.

---

**Document Version:** 3.5
**Last Updated:** October 26, 2026
**Next Review:** after Findings 1–4 are addressed

**Changelog 3.5 (Oct 26, 2026):** Finding 1 follows the stateless protocol: there is no `login` message any more; every owner message carries login and credential and costs one scrypt. Text only, no new live tests.

**Changelog 3.4 (Oct 26, 2026):** Finding 1 recharacterized for logins (development branch, d66fe02): the scrypt flood now targets `login`, which costs one scrypt per attempt regardless of the number of users (was one per stored credential on `create-board`); unknown logins cost the same as wrong credentials. Attempts are still unlimited across connections. Recommendation 1 and control 4 updated; the recommendation to cap stored credentials dropped. Text only, no new live tests; the v3.3 statements about `create-board` and `conf/passwd.json` describe the code before logins.

**Changelog 3.3 (Oct 25, 2026):** Targeted search: "create a board without credentials". **Verified negative.** Statically, `createBoard()` is reachable only from `createNewBoard` (server.js:1095) via the `create-board` handler after `isValidCredential` (1417–1448); no other handler calls `loadOrCreateBoard(id, true)`, and mutation handlers require an existing board plus its password. Live instance: a 14-variant bypass battery (missing/empty/non-string/`"true"`/`"undefined"`/`"NaN"`/1 MiB passwd, stored-hash-as-passwd, same-connection double-send) created nothing — malformed inputs dropped by validation, others `credential not accepted`, exactly one board per completed check with a valid credential (control). An indirect-creation battery over register-board, board-info(register), fullPage, page-info(register), replay, register-page, mod-action draw/new-page and shuffle-proposal on unknown boards produced zero replies and zero `.board`/`.page` files. Missing/empty `conf/passwd.json` is fail-closed (board creation disabled, server.js:271–288). Client refuses to send `create-board` without a credential. WS path option is enforced (`//ws`, `/ws?x=1` refused); POST/HEAD/OPTIONS on `/` serve only the app page. New informational note: stale `conf/passwd.json~` backup (salt-less legacy hash, never loaded, never served).

**Changelog 3.2 (Oct 25, 2026):** Text checked against the code at d414690; no new live tests. Finding 3 marked partially fixed (payload logging redacts `passwd` since d414690). Removed the "Corrupted-file crash [FIXED]" entry from *Resolved*: `loadItem` has no try-catch; damaged data files end the process by design (new informational note). Updated line numbers for Findings 1, 2 and 5. Noted the overview-grid `innerHTML = ''` in the XSS sweep.

**Changelog 3.1 (Oct 25, 2026):** Dockerfile `node:20` → `node:23` (user change). **Erratum:** v3.0's "cannot start on node:20" claim retracted — server verified booting under node v20.18.1 and v23.11.1 (HTTP 200, WS, scrypt check). Finding 8 reduced to the root-user issue (MEDIUM, as v2.2); recommendation 6 updated accordingly. Node 20 EOL 2026-04-30 noted as the reason the bump remains correct.

**Changelog 3.0 (Oct 25, 2026):** Full re-audit at HEAD 79fc50a with live verification. Recharacterized Finding 1 (async scrypt: event loop no longer blocked; impact is worker-pool starvation + unbounded queue — with measurements). Added Findings 2 (error-log disk fill → crash), 3 (plaintext passwords in existing debug.log, dead logging config), 5 (missing Origin check) and 8 (Dockerfile runs as root; the initial "cannot start on node:20" wording was retracted in 3.1). Marked GROUP fix, maxPayload, ws 8.22.0, constant-time compare, corrupt-file guard as verified. Added client-side XSS verification and live test-case table. v2.2 Finding 2 (memory DoS) superseded in part: maxPayload fixed, connection/history caps still open (Finding 4).