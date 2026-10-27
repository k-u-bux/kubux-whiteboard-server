# Tests

```
node --test tests/
```

(or `npm test`). Node's own test runner, no further dependencies; about 30 seconds.

Each server test starts its own `server.js` in a fresh temporary directory (its own
`conf/`, `data/` and `logs/`, removed afterwards) on a free port of 127.0.0.1, so the
tests touch neither this checkout's data nor a running server, and the files run in
parallel.

| File | What |
|---|---|
| `shared.test.js` | `shared.js`: path rules, snapshots, hashes (pinned values), serialization, message validation, visual state |
| `users.test.js` | `users.js`: hashing and verifying credentials, reading the user file |
| `http.test.js` | what the server serves over HTTP, and what not |
| `owner.test.js` | owner messages: credentials, the user file read for every check, `change-credential`, `create-board`, `list-boards`, `set-path`, `rename-prefix` |
| `sync.test.js` | proposals, accept and decline, the replay broadcast, undo and redo, the hash chain, full pages, page info, replays, pings, concurrent drawing |
| `pages.test.js` | adding and deleting pages, the deletion map, navigation, reordering |
| `robustness.test.js` | malformed input |
| `persistence.test.js` | restarts, the periodic save, legacy boards, hash chain repair, and the data the server refuses to start or run on |
| `tools.test.js` | `passwd_hash` and `assign_board` |
| `harness.js` | the throwaway server and a protocol client (not a test) |

The client in `index.html` is not covered: it needs a browser.

A test marked `todo` describes a known open bug: it runs and reports its failure as
`# TODO`, but does not fail the run. Remove the `todo` once the bug is fixed.
