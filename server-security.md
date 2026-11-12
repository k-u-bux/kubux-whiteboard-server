# Security Audit Report: kubux-whiteboard-server

**Audit Date:** November 12, 2026 (v3.7); earlier rounds October 25–26, 2026
**Auditor:** Security Review (re-audit of v3.6)
**Version:** v3.7: static review and live tests at commit 1cb92eb, then the fixes of this round in the working tree (not yet committed), each re-tested live. Earlier rounds: live tests at commit 79fc50a + working tree; text corrected against commit d414690 (see Changelog 3.2); unauthenticated board-creation search (see Changelog 3.3)
**Focus Areas:** RCE, Arbitrary File Access, DoS, Crash Vectors, Client-Side XSS

---

## Executive Summary

Re-audit of `server.js`, `shared.js`, `users.js` and the deployment files. Every finding of this round was **verified against throwaway live instances** (`tests/harness.js`: fresh conf/data/logs directories, local port), and every fix was re-tested the same way.

**Overall Assessment:** ⚠️ **No RCE, no file access, no deserialization issue. v3.6 said "no client-reachable crash" — that was wrong: this round found two crashes any anonymous client could trigger with one message or request, one a board member could trigger, and an unauthenticated memory exhaustion. All four are fixed in the working tree. The remaining open issues are availability issues (rate limits, connection caps, log rotation, state caps) and hardening.**

| # | Finding | Severity | Status |
|---|---------|----------|--------|
| 9 | Unauthenticated crash: deeply nested content in a dropped `mod-action-proposals` message | CRITICAL | **Fixed** in v3.7 (**new**) |
| 10 | Unauthenticated crash: HTTP request target `url.parse` cannot take | HIGH | **Fixed** in v3.7 (**new**) |
| 11 | Board-member crash: deeply nested extra key on a valid action | HIGH | **Fixed** in v3.7 (**new**) |
| 12 | Unauthenticated memory exhaustion: replies to a client that does not read | HIGH | **Fixed** in v3.7 (**new**); per connection only, see Finding 1 |
| 1 | Owner-message scrypt flood (no rate limit), unlimited connections | HIGH | Open (unchanged) |
| 2 | Unbounded error-log growth → disk-full crash | MEDIUM | Partially fixed: client text in log lines clipped (v3.7); no rotation or cap |
| 3 | Plaintext board passwords in `logs/debug.log` | MEDIUM | Partially fixed: payload logging redacts `passwd` since d414690; the old log file remains |
| 4 | Unbounded state: history, pages, deletionMap, files | MEDIUM | Open (unchanged) |
| 5 | No Origin check on WebSocket handshake | LOW | Open (unchanged) |
| 6 | `x-forwarded-proto` trusted unconditionally | LOW | Open (unchanged) |
| 7 | Error details (`e.message`) sent to clients | LOW | Open (unchanged) |
| 8 | Dockerfile runs as root; base image `node:23` out of support | MEDIUM | **Fixed** in v3.7: `node:24`, `USER node` |

Key changes vs v3.6:
- **Three crash vectors, all fixed.** Two are unauthenticated: a 74-byte compressed WebSocket frame (Finding 9) and a single HTTP request (Finding 10). The third needs a board's edit password (Finding 11). Each one threw an uncaught exception and ended the process.
- **Strict protocol conformance.** Every client message and every action (at any depth of a group) is now refused if it carries a key its schema in `shared.js` (`MESSAGES`, `MOD_ACTIONS`) does not name. Before, no validator looked at unknown keys: extra keys on a message were ignored, extra keys on an action were stored, hashed, saved and broadcast.
- **Send backpressure.** A connection with more than 64 MiB of unsent replies is cut off (Finding 12).
- **Log amplification measured and fixed.** The rejection of an unknown message type wrote the whole `type` (up to 5 MiB) to the log: 82 KB on the wire produced 84 MB of `debug.log`. Every client-chosen text in a log line is now clipped; the same input writes 1.5 KB (Finding 2).
- **Erratum (v3.6 → v3.7):** v3.6 called the `node:23` base image "a current LTS". It was not: Node 23 was never an LTS release and went end-of-life in June 2025. The Dockerfile now uses `node:24` (Finding 8).

---

## Audit Scope & Methodology

### In Scope
- All client-to-server message handlers
- File system operations
- Deserialization of user input
- Path construction logic
- HTTP request handling
- WebSocket message routing and sending
- Logging of client input
- Denial of Service (DoS) / crash vectors via malformed input
- Client-side (index.html) DOM injection / credential storage (v3.0–v3.6; **not re-audited in v3.7**, apart from checking which fields the client's messages carry)

### Methodology
1. **Static analysis** of all handlers, validators and log calls
2. **Live testing** on isolated instances (v3.7: throwaway instances from `tests/harness.js`; earlier: `ws://localhost:8099`):
   - HTTP layer: `/.env` → 403, `/%2e%2e%2f…etc/passwd` → 403, `/server.js` → 404, whitelist (`/manifest.json`) → 200
   - HTTP request targets (v3.7): absolute-form, invalid host, `*`, `__proto__`/`constructor` paths, repeated and bad-escape query parameters
   - Unauthenticated `register-board` + `fullPage-requests` → full page history (view access, by design)
   - `create-board` with wrong credential → rejected; sustained rate measured (~50 attempts/s from 60 connections; event loop latency 3 ms under flood)
   - Deep nesting (v3.7): in dropped messages, in extra keys of valid actions
   - Slow reader (v3.7): full-page requests from a connection that never reads
   - Log growth (v3.7): oversized `type` values, compressed; a copy of the server with all logging enabled and 1 MB values in every client-chosen field
   - GROUP nesting depth 15 → dropped by validation
   - MOD_ACTION with wrong password → `decline("unauthorized")`
   - `maxPayload`: 6 MiB message → connection closed
3. **Assert reachability re-analysis** (all `assert()` calls traced; see Resolved)
4. **Client-side XSS sweep** (DOM sinks, credential storage; v3.0–v3.6)

**Node version (v3.7):** the live tests of this round ran under **node v18.19.1**, the only version available on the audit host. The crash mechanisms (`JSON.stringify` recursion, `url.parse` throwing `ERR_INVALID_URL`) are not version-specific, but the production image (`node:24`) was **not booted** in this round.

---

## Critical Findings

### ✅ No RCE Vulnerabilities
Unchanged: no `eval`/`Function()`/`vm`, no command execution, no user input on template-literal paths. Re-confirmed in v3.7.

### ✅ No Arbitrary File Access Vulnerabilities
Unchanged and re-verified live:
- `isUuid()` gate on every file-ID path (`getFilePath` = `path.join(DATA_DIR, uuid.ext)`)
- HTTP static serving is an exact-match whitelist (`serveableFiles`), traversal and hidden-file segments blocked before any read
- Traversal probes returned 403/404, never a file body

### ✅ No Deserialization Vulnerabilities
Unchanged: `deserialize` reviver handles only `__type: BigInt|Set|Map`; no `__proto__`/`constructor` handling.

### ✅ No Client-Side XSS (v3.0–v3.6, not re-verified in v3.7)
- All DOM text assignment goes through `textContent` (incl. server error messages)
- Strokes are rendered on `<canvas>`; stroke colors regex-restricted (`#RGB`/`#RRGGBB`/`[a-z]{1,20}`)
- The only `innerHTML` assignments are static icon glyphs (cap/join style menus) and clearing the overview grid (`''`)
- Storage audit: the owner's credential is kept **only in the page's memory** (`storedCredential`), never in `localStorage` or `sessionStorage`; a reload forgets it (the owner logs in again; a password manager can fill in the form). The tab remembers the login in `sessionStorage['whiteboard_login']`. A `credential=` URL parameter is read once and removed from the address. Board edit passwords travel in edit links (`?passwd=`) by design; see Recommendation 7

---

## Fixed in v3.7 (found and fixed in this round, verified live)

### ✅ 9. Unauthenticated crash via a dropped `mod-action-proposals` message [FIXED — NEW]

**Risk Level:** CRITICAL (any anonymous client; no login, no board id; one message)

The handler of `mod-action-proposals` logged a message that failed validation with `redactSecrets(data)`, i.e. `JSON.stringify` over the **unvalidated** message. `JSON.stringify` recurses, so a deeply nested value overflowed the stack; the `RangeError` escaped the message handler and ended the process. The argument was evaluated even though `debug.log` writes to a NullStream.

**Verified live:** `{"type":"mod-action-proposals","j":[[[…]]]}` nested 5000 levels deep (10 KB, **74 bytes on the wire** with per-message deflate) ended the server; so did depths 10 000 and 20 000. The existing robustness tests nested deeply only in other message types, which is why they did not catch it.

**Fix:** the dropped message is logged by client id only, like every other dropped message (`server.js:1805`). Regression test in `tests/robustness.test.js`.

### ✅ 10. Unauthenticated crash via the HTTP request target [FIXED — NEW]

**Risk Level:** HIGH (any anonymous client, one request; reachable whenever Node is exposed directly, i.e. `KUBUX_WHITEBOARD_URL` mode; behind nginx an absolute-form target is probably rejected or rewritten first — not verified)

The HTTP handler called `url.parse(req.url)` unguarded. For an absolute-form target with an invalid host, e.g. `GET http://[zz/ HTTP/1.1`, `url.parse` throws `ERR_INVALID_URL`; the exception ended the process. `isValidRequest` parsed the URL a second time, also unguarded.

**Verified live:** the request above ended the server. All other probes were handled correctly: `*` → 404, `?board=x` and `http:x` → 400 (Node's parser), `http://x?board=1` → 200, `__proto__`/`constructor` paths → 404, repeated parameters and bad escapes → served or refused as intended.

**Fix:** the target is parsed once (`server.js:779`); a target `url.parse` cannot take is answered with 400 Bad Request, and `isValidRequest` receives the parsed result. Regression test in `tests/http.test.js`.

### ✅ 11. Board-member crash via an extra key on a valid action [FIXED — NEW]

**Risk Level:** HIGH (needs a board's edit password, which is shared with collaborators by design)

The validators checked only the fields they knew; extra keys passed. A valid `draw` action with an extra, deeply nested key was accepted, and hashing it (`hashNext` → `hashAny` → `serialize`, `shared.js`) overflowed the stack and ended the process. Short of that, any extra key on an action was stored in the history, hashed, saved to disk and broadcast to every viewer.

**Verified live:** a `draw` action with an extra key nested 200 000 levels deep ended the server.

**Fix:** strict protocol conformance (`has_unknown_keys`, `shared.js:628`). Every message validator refuses a message with a key its `MESSAGES.CLIENT_TO_SERVER` entry does not name; `is_invalid_action_payload` (`shared.js:683`) does the same for every action against its `MOD_ACTIONS` entry, at every depth of a group. A message sent as a JSON array is refused, too. The allowed keys come from the existing schemas, so there is no second list to keep in step. `mod-action-proposals` may carry the optional `requestId` and `action-uuid` that protocol.md documented; both are now listed in its schema. The client in `index.html` sends exactly the schema keys (checked statically, not in a browser). Regression tests in `tests/robustness.test.js`; protocol.md states the rule.

### ✅ 12. Unauthenticated memory exhaustion by a client that does not read [FIXED — NEW, per connection]

**Risk Level:** HIGH (needs only a board id, i.e. a view link)

TCP flow control stops the kernel from sending to a client that does not read its socket; `ws.send` then keeps every further message in the server process. The server never looked at `ws.bufferedAmount`, so cheap requests for large pages piled up without limit.

**Verified live:** on a page of about 13 MB of history, 400 `fullPage-requests` of ~200 bytes each from a paused connection raised the server's RSS from 183 MiB to **4197 MiB (4.1 GiB)**.

**Fix:** every send goes through `sendText` (`server.js:972`). A connection with more than `MAX_BUFFERED_AMOUNT` = 64 MiB queued (`server.js:966`, counted before compression) is cut off with `terminate()`, so it holds at most 64 MiB plus one message; a single reply larger than the limit still goes out. The same probe now peaks at 314 MiB. Regression test in `tests/robustness.test.js`.

**Remaining:**
- The limit is per connection; connections are unlimited (Finding 1).
- An honest client reaches the limit only with one burst of replies larger than it. The page overview requests the full pages of all thumbnails at once, so the overview of a board whose pages total more than 64 MiB on the wire would be cut off. The boards on the audit host total at most 0.1 MB; production boards were not measured. Remedies if needed: a larger limit, or thumbnails fetched a few at a time.

---

## Findings

### ⚠️ 1. Owner-message scrypt flood — no rate limiting [OPEN, unchanged]

**Risk Level:** HIGH (availability of board management; memory via unbounded queue)

**Since logins (development branch):** every owner message (`create-board`, `list-boards`, `set-path`, `rename-prefix`, `change-credential`) carries a login and credential and is checked on its own; the server keeps no login state. Anyone can send these messages without an account. `checkLogin` reads `conf/users.json` (the server keeps no copy, so a user the admin removes loses access at once; the small, cached file costs far less than the scrypt), looks up the login and runs **one scrypt per message** (~50 ms, 16 MiB), whatever the number of users; an unknown login is checked against a dummy hash, so it costs the same and gets the same answer as a wrong credential (no login oracle). Before, every `create-board` attempt cost one scrypt **per stored credential**, so the cost per attempt no longer grows with the number of users.

**What is unchanged:**
- Attempts are **unlimited across connections**. `ws.credentialCheckPending` (`asOwner`) allows one check at a time *per connection* only; connections are unlimited.
- Node's worker pool saturates: legitimate owner messages (and any other pool work, e.g. the `fs.readFile` that serves the client page) queue behind an attacker's checks.
- Pending scrypt jobs queue without bound → memory exhaustion with enough connections.
- A valid owner also pays one scrypt per management action; `change-credential` adds a second one (hash of the new credential).
- Since v3.7, unlimited connections also multiply the per-connection send limit of Finding 12.

**Old impact (v2.2):** "pins the server CPU at 100%" — no longer true since async `crypto.scrypt`.

**Measurements (v3.0, before logins):** fullPage latency stayed at **3 ms** while 60 connections hammered `create-board`; about **50 attempts/s** were sustained, each costing one scrypt per stored credential (2 credentials then). The same flood against an owner message costs half the scrypt work per attempt with 2 users; not re-measured.

**Location:** `server.js` `asOwner` (1533), owner handlers (1556–1684), `checkLogin` (107); `users.js` `verifyPassword` (55), `loadUsers` (86).

**Recommended fix:**
- Token-bucket rate limit per IP on owner messages (e.g., 5/min), perhaps also per login
- Cap concurrent WebSocket connections per IP and globally

---

### ⚠️ 2. Unbounded error-log growth → disk-full crash chain [PARTIALLY FIXED in v3.7]

**Risk Level:** MEDIUM (unauthenticated; slow disk fill, then process crash + data loss)

Every malformed message (invalid JSON, unknown `type`) reaches `rejectMessage` → `debug.error(...)`, one line per message, appended to `logs/debug.log` and copied to stdout (container logs) with **no cap and no rotation**. Measured (v3.0): a single connection sustained **~3000 lines / 3 s ≈ 87 KB/s**. Multiple connections scale linearly.

**Amplification (v3.7, fixed):** the rejection of an unknown type wrote the whole `type` into the line (`Unhandled message type: <type>`) and sent it back to the client. A `type` can be almost 5 MiB, and repetitive text compresses to almost nothing with per-message deflate: **20 messages, 82 KB on the wire, grew `debug.log` by 84 MB** (~1000×). Other client-chosen strings reached log lines unbounded, too: the `type` and `requestId` of every received message, an action's uuid, echoed `requestId`/`action-uuid` values in outgoing payloads, the whole unvalidated message of a dropped `replay-requests`, and the erase target in `hideElement` (`shared.js`, stdout).

**Fixed since v3.7:** every client-chosen text in a log line goes through `clip` (`shared.js:64`): a uuid stays whole (it is all an honest client sends as an id, and at most 36 characters); any other text longer than `LOG_TEXT_LENGTH` = 20 characters becomes its first 20 followed by `...`. The unknown-type error, which is both logged and sent back, uses the same rule (protocol.md). Outgoing payloads are logged through `payloadForLog`, which clips `requestId` and `action-uuid`. A dropped `replay-requests` is logged by client id only. Verified live: the 82 KB input above now writes 1.5 KB; a copy of the server with all logging enabled, sent 1 MB values in every client-chosen field, wrote no line longer than 169 characters.

**Remaining:** the number of lines is still unbounded (one per malformed message), and so is the file. **Crash chain:** when the disk fills, `writeFileAtomic` (`server.js:259`) throws (ENOSPC) inside `periodicallyPersist` (`server.js:2133`, 10 s timer) — unhandled → process crash, losing up to 10 s of edits.

**Location:** `server.js` `rejectMessage` (2048), `routeMessage` (2062).

**Recommended fix (remaining):** log rotation + size cap; rate-limit malformed-input logging (dedupe per second). How a full disk should end is a design decision: the server deliberately ends on errors in its own data rather than run on (see the damaged-files note); a full disk is not damaged data, though.

---

### ⚠️ 3. Plaintext board passwords in `logs/debug.log` [PARTIALLY FIXED]

**Risk Level:** MEDIUM (historical credential exposure + fragile config)

The existing `logs/debug.log` (~792 KB) contains board passwords in cleartext: `passwd: 'e0k5ndiszdig'` (and others) in the `BOARD_CREATED` payload dumps and incoming `shuffle-proposal`/`mod-action-proposals` messages. Re-checked in v3.7: 28 such lines remain in the author's working copy.

**Why:** an earlier run used `new Console({ stdout: debugTee, stderr: debugTee })` (`server.js:71–72`, now commented out), logging every sent/received message with full payload. The **current** config (`stdout: debugNull`) sends `debug.log` to a NullStream — the entire payload-logging layer (`routeMessage`, `logSentMessage`) is dead code.

**Fixed since d414690:** `logSentMessage` passes payloads through a masking function (named `payloadForLog` since v3.7, formerly `redactSecrets`), which masks every `passwd` and `new-passwd` field (the keys used for board passwords and credentials on the wire). Received messages are logged by type and requestId only (fc7870d), and a dropped `mod-action-proposals` by client id only (v3.7). Re-enabling payload logging therefore no longer writes passwords.

**Additional notes:** the file is never rotated/truncated; board passwords persist in it indefinitely.

**Recommended fix (remaining):** rotate/truncate the existing log file; delete the commented-out `debugTee` stdout configs.

---

### ⚠️ 4. Unbounded state for authorized users [OPEN, unchanged]

**Risk Level:** MEDIUM (disk + memory + CPU exhaustion; requires board password — shared with collaborators by design in readme.md)

- Page **history grows without bound** (no cap on `handleEditAction`); each action is stored + hashed + persisted every 10 s. Since v3.7 an action can carry only the fields of its schema, but a single stroke may still have up to ~5 MB of points (`maxPayload`).
- **Page count** and **`deletionMap`** grow without bound; a deleted page's **file is never removed from disk**; `to_be_removed.json` grows without bound.
- `existingPage` walks deletion chains — length unbounded (assert-guarded against cycles, so no hang, but O(chain) per lookup).
- Each top-level GROUP action deep-clones the whole visual state (`structuredClone` in `commitGroup`) — an O(page-size) cost per GROUP a member can send at will.

**Recommended fix:** history cap (e.g., 100 000 actions/page), page/board caps, delete page files on `delete page`, cap `deletionMap`, avoid the full-state clone per GROUP.

---

### ⚠️ 5. No Origin check on WebSocket handshake [OPEN, unchanged]

**Risk Level:** LOW

`wss.on('connection', ...)` (`server.js:2097`) never inspects `req.headers.origin`. Any webpage can open a WebSocket to the server and act as an unauthenticated client (read boards whose ID is known — view access is open by design; participate in the DoS vectors above). Impact is bounded because every privileged action requires the board password or an owner's login and credential, which live in the URL and in the page's memory — a cookie-based session this is not. Still, with any future credential-bearing cookie or same-origin-gapless auth change, missing Origin verification becomes CSWSH.

**Recommended fix:** verify `Origin` against the configured host, or deny cross-origin handshakes.

---

### ⚠️ 6. `x-forwarded-proto` spoofing [OPEN, unchanged]

**Risk Level:** LOW — HSTS is emitted when the header says `https`, even on plain HTTP (`server.js:794`). Only trustworthy when the server sits behind the documented nginx proxy. Make proxy trust configurable.

### ⚠️ 7. Error details sent to clients [OPEN, unchanged]

**Risk Level:** LOW — `routeMessage` sends `JSON.parse` failure messages back to clients (`rejectMessage(ws, e.message)`, `server.js:2067`). Not a stack trace, but leaks parser internals; log full detail server-side, send a generic message. (The other client-visible rejection text, `Unhandled message type: …`, is clipped since v3.7; see Finding 2.)

---

## Deployment Findings

### ✅ 8. Dockerfile: root user and out-of-support base image [FIXED in v3.7]

**Risk Level:** MEDIUM (until v3.7)

**Root user:** the standalone `Dockerfile` had no `USER` directive, so the Node.js process ran as root inside the container: with Docker's default (no user-namespace remapping), container root is host UID 0 for bind-mounted files, ignores file permissions, and is the best starting point for a container escape. **Fixed:** `USER node`, the non-root user (UID 1000) of the official node images. The documented `docker-compose.yml` already ran the server as `user: "1000:1000"` (same UID) with the app mounted `:ro` and only `conf/`, `data/` and `logs/` writable; it is unaffected. Whoever runs the image without compose must now make those mounted directories writable by UID 1000.

**Base image — Erratum (v3.6 → v3.7):** v3.6 called the `node:20` → `node:23` bump "pinning a current LTS". **Wrong:** Node 23 was never an LTS release (odd-numbered releases never are) and went end-of-life in June 2025; the image received no security fixes. **Fixed:** `node:24`, the current LTS line. Not booted in v3.7 (see Methodology); Node 24 may print a deprecation warning for `url.parse` (used in the HTTP handler), which is harmless.

**Earlier erratum (v3.0 → v3.1), kept for the record:** v3.0 stated the `node:20` base "cannot start the server" because of `require('console')` / `fs.createWriteStream`. Retracted in v3.1 after full boot tests under node v20.18.1 and v23.11.1 (HTTP 200, WebSocket up, scrypt credential check).

### ✅ `passwd_hash` shell-injection footgun [FIXED]

`passwd_hash` used to interpolate the password into a JS string literal inside shell double quotes, so an embedded `'` ran arbitrary JS as the admin who invoked the tool. Now login and credential reach node only through environment variables, never as code, and the hash comes from `users.js`, the same scrypt code the server checks with.

### ℹ️ Stale credential files `conf/passwd.json`, `conf/passwd.json~`

`conf/` is not part of the repository, but the author's working directory still holds the legacy `conf/passwd.json` and its backup `conf/passwd.json~` (a single **salt-less** hash, one hex string, no `:`). Since logins, the server reads only `conf/users.json` (`loadUsers` in `users.js`); the old files are **never loaded** (at most mentioned in a startup hint) and **not served** (HTTP dotfile block + static whitelist). Inert; delete them for hygiene. (Still present in v3.7.)

### ℹ️ Damaged data files end the process (by design, not fixed)

Earlier versions of this report listed a "corrupted-file crash" as fixed by a try-catch in `loadItem`. **That is not the current code:** `loadItem` (`server.js:301`) has no try-catch, so a board or page file that is not valid JSON makes `deserialize` throw inside the message handler, and the exception ends the process. `loadPage` also throws on a stored hash chain of the wrong length. This is deliberate fail-fast behaviour (see the "Lookup invariants" comment in server.js: a damaged file "shows up as a failed assert, never as a silently recreated empty board or page"). It is reachable only through damaged or hand-edited files in `data/`, not through client input. Note that `writeFileAtomic` (temp file + fsync + rename) makes a truncated file from a crash or full disk unlikely.

### ℹ️ `generatePasswd` modulo bias

`b % 36` with `b ∈ [0,255]` makes digits 0–3 slightly more likely (8/256 vs 7/256). Negligible — the 12-char base36 keyspace (~62 bits) dominates; constant-time compare (79fc50a) prevents timing attacks.

### ℹ️ Unreachable branch with an undefined variable (v3.7)

The `page-info-request` handler's fallback branch (`server.js:1522`) logs `clientId`, which is not defined in that scope; reaching it would throw a `ReferenceError`. It is unreachable: the validator already requires both ids to be UUIDs, so the branch never runs. Harmless today; a trap if the validator changes.

---

## Resolved Since v2.2 (verified)

### ✅ Crashes and memory exhaustion found in v3.7 [FIXED, verified live]
Findings 9–12 above, each with a regression test.

### ✅ GROUP sub-action validation (assert crash + stack overflow) [FIXED, verified live]
`is_invalid_action_payload` recursively validates GROUP sub-actions (DRAW/ERASE/GROUP only) and enforces `MAX_GROUP_DEPTH = 10`. A depth-15 payload was dropped by validation on the live instance. `assert(false)` in `commitEdit` is no longer input-reachable.

### ✅ WebSocket message size limit [FIXED, verified live]
`maxPayload: 5 * 1024 * 1024`; a 6 MiB message closed the connection. (v2.2 flagged the 100 MiB default.)

### ✅ ws library CVE [FIXED]
`ws` 8.22.0 (CVE-2026-48779, commit c9694cb). Still the installed version in v3.7.

### ✅ CPU-blocking scrypt [PARTIALLY FIXED]
`scryptSync` → async `crypto.scrypt` (worker pool): event loop stays responsive under flood (measured 3 ms). Residual issue: worker-pool starvation + unbounded queue (Finding 1).

### ✅ Constant-time board-password comparison [FIXED]
SHA-256 digests compared with `crypto.timingSafeEqual` (commit 79fc50a): no length leak, no timing leak.

### ✅ Crash via deep JSON nesting while parsing [NOT A FINDING, verified live]
500 000-deep array parsed without crash (V8's `JSON.parse` is depth-safe). `JSON.stringify` is not: stringifying deep client input is what Findings 9 and 11 were about.

---

## Security Controls Implemented (verified)

1. **Message validation layer** — every handler validates before use; GROUP sub-actions recursively. Since v3.7 strict: a message or action with a key its schema does not name is refused.
2. **UUID-based access control** — `isUuid` gates all file IDs and message IDs; no traversal.
3. **Safe deserialization** — BigInt/Set/Map only; no prototype pollution.
4. **scrypt password auth** — N=16384/r=8/p=1, 32-byte salt, timing-safe compare (one implementation, `users.js`); one scrypt per owner message, unknown logins cost the same as wrong credentials. The user file is read for every check, so a removed user loses access at once; credential changes rewrite it from disk with mode 600.
5. **HTTP hardening** — whitelist serving, hidden-file block, HSTS (behind proxy); an unparseable request target is answered with 400 (v3.7).
6. **Assert safety** — all remaining asserts reachable only via disk damage/programmer error, not malformed input.
7. **Send backpressure** (v3.7) — at most 64 MiB of unsent replies per connection.
8. **Bounded log lines** (v3.7) — client-chosen text clipped to 20 characters (uuids whole); unvalidated messages are never stringified for the log.
9. **Non-root container** (v3.7) — `USER node` in the Dockerfile, `user: "1000:1000"` in compose.

---

## Recommendations (prioritized)

1. **Rate-limit owner messages** (per IP, perhaps per login) and **cap WebSocket connections** per IP and globally (Finding 1; also bounds the total of Finding 12's per-connection limit).
2. **Log rotation + size cap + malformed-input logging rate limit**; decide how a full disk should end (Finding 2).
3. **Rotate/truncate existing `debug.log`; remove the commented-out logging configs** (Finding 3; payload redaction is done).
4. **State caps + GC:** history per page, page count, `deletionMap`, delete page files (Finding 4).
5. **Verify `Origin` on the WS handshake** (Finding 5).
6. **Configurable proxy trust** for `x-forwarded-proto` (Finding 6); generic client error messages (Finding 7).
7. **Storage note:** no credential is stored in the browser any more (memory only; see the storage audit). Board edit passwords are part of edit links by design, so whoever has a link can edit. A CSP remains useful as defense-in-depth against XSS, which could read the credential from the page's memory while it is open.
8. **Boot the `node:24` image once** and load a board, to confirm the base-image change (Finding 8).

---

## Test Cases

### Live, Nov 12, 2026 (v3.7; node v18.19.1, throwaway instances)

| Test | Before the fixes | After the fixes |
|------|------------------|-----------------|
| `{"type":"mod-action-proposals","j":…}` nested 5000 / 10 000 / 20 000 deep (74–103 bytes on the wire), no login | process ended (`RangeError` in `redactSecrets`) | dropped, server running |
| valid `draw` with an extra key nested 200 000 deep (edit password) | process ended (`RangeError` in `hashNext`) | dropped, server running |
| `GET http://[zz/?board=1 HTTP/1.1` | process ended (`ERR_INVALID_URL`) | 400, server running |
| `GET` with `*`, `?board=x`, `http:x`, `http://x?board=1`, `http://a:99999999/?board=1`, `/__proto__`, `/constructor`, `/?board=1&board=2`, `/?__proto__=1`, `/?board=%ZZ` | 404 / 400 / 400 / 200 / 200 / 404 / 404 / 200 / 404 / 200, no crash | unchanged |
| 400 unread `fullPage-requests` for a ~13 MB page | RSS 183 → 4197 MiB | RSS 188 → 314 MiB; connection cut |
| 20 messages with a 4 MiB `type`, deflate (82 KB on the wire) | `debug.log` +84 MB | `debug.log` +1.5 KB |
| server copy with all logging on, 1 MB values in type, requestId, action uuid, erase target, echoed requestId/action-uuid, dropped replay | — | longest line 169 characters; no client text longer than 20 characters (uuids whole) |
| extra key on a message, on an action, on a group's sub-action (any depth) | accepted | dropped without a reply |
| test suite (`node --test tests/`) | 134 tests | 137 tests, all pass |

### Live, Oct 25, 2026 (v3.0–v3.3)

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

The kubux-whiteboard-server remains solid against RCE, file access, deserialization and — verified live in v3.3 — **unauthorized board creation**. v3.6's claim that the crash-on-malformed-input class was closed did not hold: v3.7 found three client-triggerable crashes (two of them anonymous, one message or request each) and an anonymous memory exhaustion. All four are fixed, with regression tests, and the protocol is now enforced strictly: a message or action with a key its schema does not name is refused. Log lines no longer grow with client input, and the container runs as a non-root user on a supported Node.

The open issues are availability issues: **unauthenticated scrypt flooding and unlimited connections** (HIGH), **log-growth disk fill** without rotation (MEDIUM, amplification removed) and **unbounded state growth by board members** (MEDIUM) — plus the historical credential exposure in the unrotated log file.

**Action required:** commit the v3.7 fixes; then Findings 1–4 (rate limits and connection caps, log management, state caps) before Findings 5–7.

---

**Document Version:** 3.7
**Last Updated:** November 12, 2026
**Next Review:** after Findings 1–4 are addressed

**Changelog 3.7 (Nov 12, 2026):** Re-audit at commit 1cb92eb with live verification (node v18.19.1, throwaway instances). New Findings 9 (unauthenticated crash: dropped `mod-action-proposals` stringified for the log), 10 (unauthenticated crash: `url.parse` on an invalid absolute-form request target), 11 (board-member crash: deeply nested extra key on a valid action) and 12 (unauthenticated memory exhaustion: no send backpressure) — all fixed in the working tree and re-tested: dropped messages are logged by client id only; the request target is parsed once and an unparseable one answered with 400; every message and action is refused if it carries a key its schema does not name (protocol.md documents the rule and the optional `requestId`/`action-uuid` of `mod-action-proposals`); every send goes through `sendText`, which cuts off a connection with more than 64 MiB unsent. Finding 2: amplification via the echoed `type` measured (82 KB → 84 MB) and fixed by clipping every client-chosen text in log lines (`clip`, 20 characters, uuids whole); rotation and cap remain open. Finding 3: masking function renamed `payloadForLog`; 28 password lines remain in the old log. Finding 8 fixed: `node:24`, `USER node`; erratum: v3.6 wrongly called `node:23` an LTS (end-of-life June 2025). v3.6's "no client-reachable crash" corrected. New informational note on an unreachable branch with an undefined variable. Client-side XSS not re-audited. Line numbers refer to the working tree with the fixes.

**Changelog 3.6 (Oct 26, 2026):** Text brought in line with the code (development branch, up to 3f20cc7); no new live tests, findings unchanged. Storage audit and Recommendation 8: the credential is no longer persisted in `localStorage`, it is kept in the page's memory only. Finding 5: credentials live in the URL and page memory. Finding 8: the compose file also mounts `conf/` writable. `passwd_hash` footgun marked fixed (environment variables; shared `users.js`). Stale credential note: `conf/` is not in the repository; the server reads only `conf/users.json`. Control 4: one scrypt implementation, user file read per check, written with mode 600. Line numbers updated (Findings 1, 2, 5, 6; damaged-files note).

**Changelog 3.5 (Oct 26, 2026):** Finding 1 follows the stateless protocol: there is no `login` message any more; every owner message carries login and credential and costs one scrypt. Text only, no new live tests.

**Changelog 3.4 (Oct 26, 2026):** Finding 1 recharacterized for logins (development branch, d66fe02): the scrypt flood now targets `login`, which costs one scrypt per attempt regardless of the number of users (was one per stored credential on `create-board`); unknown logins cost the same as wrong credentials. Attempts are still unlimited across connections. Recommendation 1 and control 4 updated; the recommendation to cap stored credentials dropped. Text only, no new live tests; the v3.3 statements about `create-board` and `conf/passwd.json` describe the code before logins.

**Changelog 3.3 (Oct 25, 2026):** Targeted search: "create a board without credentials". **Verified negative.** Statically, `createBoard()` is reachable only from `createNewBoard` (server.js:1095) via the `create-board` handler after `isValidCredential` (1417–1448); no other handler calls `loadOrCreateBoard(id, true)`, and mutation handlers require an existing board plus its password. Live instance: a 14-variant bypass battery (missing/empty/non-string/`"true"`/`"undefined"`/`"NaN"`/1 MiB passwd, stored-hash-as-passwd, same-connection double-send) created nothing — malformed inputs dropped by validation, others `credential not accepted`, exactly one board per completed check with a valid credential (control). An indirect-creation battery over register-board, board-info(register), fullPage, page-info(register), replay, register-page, mod-action draw/new-page and shuffle-proposal on unknown boards produced zero replies and zero `.board`/`.page` files. Missing/empty `conf/passwd.json` is fail-closed (board creation disabled, server.js:271–288). Client refuses to send `create-board` without a credential. WS path option is enforced (`//ws`, `/ws?x=1` refused); POST/HEAD/OPTIONS on `/` serve only the app page. New informational note: stale `conf/passwd.json~` backup (salt-less legacy hash, never loaded, never served).

**Changelog 3.2 (Oct 25, 2026):** Text checked against the code at d414690; no new live tests. Finding 3 marked partially fixed (payload logging redacts `passwd` since d414690). Removed the "Corrupted-file crash [FIXED]" entry from *Resolved*: `loadItem` has no try-catch; damaged data files end the process by design (new informational note). Updated line numbers for Findings 1, 2 and 5. Noted the overview-grid `innerHTML = ''` in the XSS sweep.

**Changelog 3.1 (Oct 25, 2026):** Dockerfile `node:20` → `node:23` (user change). **Erratum:** v3.0's "cannot start on node:20" claim retracted — server verified booting under node v20.18.1 and v23.11.1 (HTTP 200, WS, scrypt check). Finding 8 reduced to the root-user issue (MEDIUM, as v2.2); recommendation 6 updated accordingly. Node 20 EOL 2026-04-30 noted as the reason the bump remains correct.

**Changelog 3.0 (Oct 25, 2026):** Full re-audit at HEAD 79fc50a with live verification. Recharacterized Finding 1 (async scrypt: event loop no longer blocked; impact is worker-pool starvation + unbounded queue — with measurements). Added Findings 2 (error-log disk fill → crash), 3 (plaintext passwords in existing debug.log, dead logging config), 5 (missing Origin check) and 8 (Dockerfile runs as root; the initial "cannot start on node:20" wording was retracted in 3.1). Marked GROUP fix, maxPayload, ws 8.22.0, constant-time compare, corrupt-file guard as verified. Added client-side XSS verification and live test-case table. v2.2 Finding 2 (memory DoS) superseded in part: maxPayload fixed, connection/history caps still open (Finding 4).
