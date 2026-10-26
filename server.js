const WebSocket = require('ws');
const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const url = require('url');
const assert = require('assert');


// Config storage configuration
const CONF_DIR = './conf';

// Logging
const { Console } = require('console');
const { Writable } = require('stream');

const LOGS_DIR = './logs';
const getDebugLogPath = () => path.join(LOGS_DIR, 'debug.log');
const debugOutput = fs.createWriteStream(getDebugLogPath(), { flags: 'a' });

class NullStream extends Writable {
  _write(chunk, encoding, callback) {
    callback();
  }
}

const debugNull = new NullStream();

class TeeStream extends Writable {

  constructor(...streams) {
    super();
    this.streams = streams;
  }

  _write(chunk, encoding, callback) {
    // We use Promise.all to wait for all the write operations to complete.
    Promise.all(
      this.streams.map(stream => {
        return new Promise((resolve, reject) => {
          stream.write(chunk, encoding, (err) => {
            if (err) {
              reject(err);
            } else {
              resolve();
            }
          });
        });
      })
    )
      .then(() => {
        callback();
      })
      .catch(error => {
        callback(error);
      });
  }

  destroy() {
    for (const stream of this.streams) {
      // End the stream and then destroy it.
      stream.end(() => stream.destroy());
    }
  }

}

const debugTee = new TeeStream( process.stdout, debugOutput );

const debug = new Console({ stdout: debugNull, stderr: debugTee });
// const debug = new Console({ stdout: debugOutput, stderr: debugTee });
// const debug = new Console({ stdout: debugTee, stderr: debugTee });


// Password hashing with scrypt (memory-hard, resistant to rainbow tables and brute-force)
const crypto = require('crypto');


function generateSecureUuid() {
    let randomBytes = crypto.randomBytes(16);
    // Set version (4) and variant bits per RFC 4122
    randomBytes[6] = (randomBytes[6] & 0x0f) | 0x40; // Version 4
    randomBytes[8] = (randomBytes[8] & 0x3f) | 0x80; // Variant 10
    // Format as UUID string
    const hex = Array.from(randomBytes, b => b.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20,32)}`;
}

function generatePasswd() {
    // Generate 12 characters from base36 alphabet (0-9, a-z)
    let randomBytes = crypto.randomBytes(12);
    // Convert to base36 (0-9a-z)
    return Array.from(randomBytes, b => (b % 36).toString(36)).join('');
}

// Constant-time comparison of a board password. Comparing digests gives
// timingSafeEqual the equal lengths it needs and hides the length, too.
function passwdMatches(password, passwd) {
    const digest = (text) => crypto.createHash('sha256').update(text).digest();
    return crypto.timingSafeEqual(digest(password), digest(passwd));
}

/**
 * Hash a password using scrypt
 * scrypt is a password-based key derivation function that is intentionally slow and memory-hard,
 * making it resistant to both rainbow table attacks and hardware-accelerated brute-force attacks.
 * 
 * @param {string} password - The password to hash
 * @returns {string} The hash in format: salt:hash (both hex-encoded)
 */
function hashPassword(password) {
  // Generate a random salt (32 bytes = 256 bits)
  const salt = crypto.randomBytes(32);
  
  // scrypt parameters:
  // - N (cost): 16384 (2^14) - CPU/memory cost parameter (reasonable balance)
  // - r (blockSize): 8 - block size parameter
  // - p (parallelization): 1 - parallelization parameter
  // - keylen: 64 - desired key length in bytes
  const hash = crypto.scryptSync(password, salt, 64, {
    N: 16384,
    r: 8,
    p: 1
  });
  
  // Return salt:hash (both in hex format)
  return salt.toString('hex') + ':' + hash.toString('hex');
}

// hashPassword in Node's worker pool, so that a credential change does not block the event loop
function hashPasswordAsync(password) {
  return new Promise((resolve, reject) => {
    const salt = crypto.randomBytes(32);
    crypto.scrypt(password, salt, 64, { N: 16384, r: 8, p: 1 }, (error, hash) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(salt.toString('hex') + ':' + hash.toString('hex'));
    });
  });
}

/**
 * Verify a password against a stored hash
 * 
 * scrypt runs asynchronously in Node's worker pool, so the ~50 ms it takes do
 * not block the event loop. The password file is edited by the admin and is
 * treated like input: a malformed entry is logged and simply does not match.
 *
 * @param {string} password - The password to verify
 * @param {string} storedHash - The stored hash in format salt:hash
 * @returns {Promise<boolean>} Resolves to true if password matches
 */
function verifyPassword(password, storedHash) {
  return new Promise((resolve) => {
    let salt;
    let storedHashBuffer;
    try {
      const [saltHex, hashHex] = storedHash.split(':');
      if (!saltHex || !hashHex) {
        debug.error('[SERVER] Invalid hash format - expected salt:hash format');
        resolve(false);
        return;
      }
      salt = Buffer.from(saltHex, 'hex');
      storedHashBuffer = Buffer.from(hashHex, 'hex');
    } catch (error) {
      debug.error('[SERVER] Error verifying password:', error.message);
      resolve(false);
      return;
    }

    // Compute hash with same parameters
    crypto.scrypt(password, salt, 64, { N: 16384, r: 8, p: 1 }, (error, computedHash) => {
      if (error) {
        debug.error('[SERVER] Error verifying password:', error.message);
        resolve(false);
        return;
      }
      // timingSafeEqual throws on a length mismatch, i.e. on a malformed stored hash
      if (storedHashBuffer.length !== computedHash.length) {
        debug.error('[SERVER] Invalid hash format - stored hash has the wrong length');
        resolve(false);
        return;
      }
      // Use timing-safe comparison to prevent timing attacks
      resolve(crypto.timingSafeEqual(storedHashBuffer, computedHash));
    });
  });
}

// The user with this login if the credential matches, else null. An unknown login
// costs one scrypt like a wrong credential, so the answer does not tell which logins exist;
// so does a missing or invalid user file, which leaves no user to match.
async function checkLogin(login, password) {
  const users = usersForCheck();
  const user = users ? users.find(entry => entry.login === login) : undefined;
  const matches = await verifyPassword(password, user ? user.hash : DUMMY_HASH);
  return (matches && user) ? user : null;
}

// Dual-mode configuration: proxy vs direct
const WHITEBOARD_URL = process.env.KUBUX_WHITEBOARD_URL;
let serverPort = 80; // Default for proxy mode
let isDirectMode = false;
let websocketUrl = null;

if (WHITEBOARD_URL) {
    // Parse the URL to extract port and protocol
    try {
        const parsedUrl = new URL(WHITEBOARD_URL);
        serverPort = parseInt(parsedUrl.port) || (parsedUrl.protocol === 'https:' ? 443 : 80);
        isDirectMode = true;
        websocketUrl = WHITEBOARD_URL.replace(/^http/, 'ws') + '/ws';
        debug.log(`[SERVER] Direct mode enabled: ${WHITEBOARD_URL}`);
        debug.log(`[SERVER] Listening on port: ${serverPort}`);
        debug.log(`[SERVER] Clients should connect to: ${websocketUrl}`);
    } catch (err) {
        debug.error(`[SERVER] Invalid KUBUX_WHITEBOARD_URL: ${WHITEBOARD_URL}`);
        debug.error(`[SERVER] Error: ${err.message}`);
        process.exit(1);
    }
} else {
    debug.log(`[SERVER] Proxy mode (production): listening on port ${serverPort}`);
    debug.log(`[SERVER] Expecting nginx-proxy to handle SSL and forward to port ${serverPort}`);
}

const { 
    PORT,
    recent_snapshots,
    hashAny, 
    hashNext, 
    isUuid,
    isEqual,
    serialize, 
    deserialize,
    createEmptyVisualState, 
    compileVisualState,
    commitEdit, 
    revertEdit,
    commitGroup, 
    MESSAGES, 
    CREDENTIAL_NOT_ACCEPTED,
    CREDENTIAL_NOT_SAVED,
    PATH_INVALID,
    PATH_TAKEN,
    NOT_OWNER,
    NO_SUCH_BOARD,
    NO_SUCH_FOLDER,
    RENAME_BLOCKED,
    normalizePath,
    findPathConflict,
    MOD_ACTIONS, 
    NULL_UUID,
    ELEMENT, 
    POINT,
    is_invalid_REGISTER_BOARD_message,
    is_invalid_REGISTER_PAGE_message,
    is_invalid_PAGE_INFO_REQUEST_message,
    is_invalid_CHANGE_CREDENTIAL_message,
    is_invalid_CREATE_BOARD_message,
    is_invalid_LIST_BOARDS_message,
    is_invalid_SET_PATH_message,
    is_invalid_RENAME_PREFIX_message,
    is_invalid_FULL_PAGE_REQUEST_message,
    is_invalid_REPLAY_REQUEST_message,
    is_invalid_MOD_ACTION_PROPOSALS_message,
    is_invalid_BOARD_INFO_REQUEST_message,
    is_invalid_SHUFFLE_PROPOSAL_message
} = require('./shared');


// Data storage configuration
const DATA_DIR = './data';

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    debug.log(`[SERVER] Created data directory: ${DATA_DIR}`);
}

// Path helpers
const getUsersFilePath = () => path.join(CONF_DIR, 'users.json');
const getOldPasswdFilePath = () => path.join(CONF_DIR, 'passwd.json');
const getRemovalLogPath = () => path.join(DATA_DIR, 'to_be_removed.json');
const getFilePath = (uuid,ext) => path.join(DATA_DIR, `${uuid}.${ext}`);


// Server state structures

// Users: conf/users.json is a list of { id, login, hash }. The id never changes and
// is what boards record as their owner; the login is what people type. The server
// keeps no copy: the file is read for every credential check (see loadUsers).

// Stands in for the hash of an unknown login (see checkLogin)
const DUMMY_HASH = hashPassword(crypto.randomBytes(16).toString('hex'));

const deletionMap = {};
const clients = {}; // Map client IDs to WebSocket instances
const pingInterval = 5000;
const boardInterval = 5000;
let pingTimer;
let boardTimer;

// The user file is edited by the admin and treated like input. This is the one place
// that reads it: the entries as they are in the file (extra fields included), or an
// error that says whether the file is missing, unreadable (permissions, mounts) or
// invalid. The file is the only truth about users: the server keeps no copy and reads
// it for every credential check, so a user the admin adds, changes or removes counts
// at once. The file is small and cached by the system; a read costs far less than the
// scrypt check that follows.
function loadUsers() {
    const filePath = getUsersFilePath();
    let text;
    try {
        text = fs.readFileSync(filePath, 'utf8');
    } catch (error) {
        // a missing file and one the server may not read look alike otherwise
        if (error.code !== 'ENOENT') {
            throw new Error(`Cannot read user file ${filePath}: ${error.message}`);
        }
        const oldFilePath = getOldPasswdFilePath();
        const hint = fs.existsSync(oldFilePath)
            ? `${oldFilePath} is no longer read; create ${filePath} with passwd_hash (see readme.md)`
            : 'create it with passwd_hash (see readme.md)';
        throw new Error(`No user file ${filePath}: ${hint}`);
    }
    try {
        const entries = JSON.parse(text);
        checkUsers(entries);
        return entries;
    } catch (error) {
        throw new Error(`Invalid user file ${filePath}: ${error.message}`);
    }
}

function checkUsers(entries) {
    if (!Array.isArray(entries)) {
        throw new Error('expected a list of { "id", "login", "hash" } entries');
    }
    const ids = new Set();
    const logins = new Set();
    for (const entry of entries) {
        if (!entry || typeof entry !== 'object'
            || !isUuid(entry.id)
            || typeof entry.login !== 'string' || entry.login.length === 0
            || typeof entry.hash !== 'string' || !entry.hash.includes(':')) {
            throw new Error(`malformed entry ${JSON.stringify(entry)}`);
        }
        if (ids.has(entry.id)) { throw new Error(`id ${entry.id} appears twice`); }
        if (logins.has(entry.login)) { throw new Error(`login ${entry.login} appears twice`); }
        ids.add(entry.id);
        logins.add(entry.login);
    }
}

// The users for a credential check, or null, after logging why there are none
function usersForCheck() {
    try {
        return loadUsers();
    } catch (error) {
        debug.error(`[SERVER] Nobody can log in: ${error.message}`);
        return null;
    }
}

// Replace one user's hash in the user file, as it is on disk now: entries the admin
// added or changed stay as they are, and only this user's hash changes. Throws, and
// writes nothing, if the file cannot be read, is invalid, no longer holds the user,
// or cannot be written (e.g. conf/ mounted read-only).
function saveUsersWithHash(userId, hash) {
    const entries = loadUsers();
    const entry = entries.find(candidate => candidate.id === userId);
    if (!entry) {
        throw new Error(`user ${userId} is no longer in ${getUsersFilePath()}`);
    }
    entry.hash = hash;
    // the hashes are for the server alone
    writeFileAtomic(getUsersFilePath(), JSON.stringify(entries, null, 2) + '\n', 0o600);
}

function initializeGlobals() {
    // read once at startup only for the log: a problem with the file shows at once,
    // not only at the first login
    const users = usersForCheck();
    if (users) {
        debug.log(`[SERVER] ${users.length} users in ${getUsersFilePath()}`);
    }
    const removalLogPath = getRemovalLogPath();
    if (fs.existsSync(removalLogPath)) {
        const itemText = fs.readFileSync(removalLogPath, 'utf8');
        const parsedMap = JSON.parse(itemText);
        Object.assign(deletionMap, parsedMap);
        debug.log(`[SERVER] Loaded ${Object.keys(deletionMap).length} deletion mappings`);
    }
}

// Write via a temporary file and a rename, so that a crash or a full disk
// leaves either the old or the new content on disk, never a truncated file.
// Errors are passed on to the caller, as with fs.writeFileSync.
// With a mode, the file gets exactly that mode, whatever the umask or a leftover
// temporary file had.
function writeFileAtomic(filePath, text, mode) {
    const tmpPath = `${filePath}.tmp`;
    try {
        const fd = fs.openSync(tmpPath, 'w');
        try {
            if (mode !== undefined) {
                fs.fchmodSync(fd, mode);
            }
            fs.writeFileSync(fd, text, 'utf8');
            fs.fsyncSync(fd);
        } finally {
            fs.closeSync(fd);
        }
        fs.renameSync(tmpPath, filePath);
    } catch (error) {
        try { fs.unlinkSync(tmpPath); } catch (ignored) {}
        throw error;
    }
}

// A rename makes the new file durable only once the directory is synced. Path changes
// sync after every board file they write, so their write order survives a power loss.
function syncDataDir() {
    const fd = fs.openSync(DATA_DIR, 'r');
    try {
        fs.fsyncSync(fd);
    } finally {
        fs.closeSync(fd);
    }
}

function persistDeletionMap() {
    const removalLogPath = getRemovalLogPath();
    writeFileAtomic(removalLogPath, JSON.stringify(deletionMap, null, 2));
}

initializeGlobals();


// helper functions for persistent storage and caching
// ===================================================

function loadItem(itemId, ext, check) {
    if ( ! check( itemId ) ) { 
        debug.log( `Invalid itemId: ${itemId}` );
        return null; 
    }
    const filePath = getFilePath(itemId, ext);
    if (fs.existsSync(filePath)) {
        const fileText = fs.readFileSync(filePath, 'utf8');
        if (fileText) {
            const item = deserialize(fileText);
            if (item) { return item; }
        }
    }
    debug.log(`[SERVER] Error loading ${ext} from disk: ${itemId}`);
    return null;
}

function saveItem(itemId, item, ext, check) {
    if ( ! check( itemId ) ) { 
        debug.log( `Invalid itemId: ${itemId}` );
        return; 
    }
    const filePath = getFilePath(itemId, ext);
    const fileText = serialize(item);
    writeFileAtomic(filePath, fileText);
}


const loadBoard = (boardId) => loadItem(boardId, 'board', isUuid);
const saveBoard = (boardId, board) => saveItem(boardId, board, 'board', isUuid);
const savePage = (pageId, page) => saveItem(pageId, page, 'page', isUuid);


// Hash chain provenance
// =====================
// The hash chain is written to disk with the page, so the stored values are only
// meaningful for the hash function that produced them. A page written by an older
// hash function carries a chain no current client can reproduce (clients always
// rebuild hashAny(pageId) + hashNext(...) from the history), which desynchronizes
// every ping and traps the client in a replay / full-page loop.
//
// This is a version test of the hash function, NOT a validation of the chain: it
// samples one entry per hash entry point — hashAny at the anchor, hashNext at the
// first chain step — and trusts the rest. A page with an empty history stores only
// the anchor, which the first comparison already covers. On a mismatch the chain is
// rebuilt from the history and written back once, so a load costs O(1) and the
// rebuild path runs at most once per page per hash function change.

// The chain must describe the history: one hash per action plus the anchor. A
// violation is not a provenance question — the array simply cannot be indexed
// (ping / accept / replay read page.hashes[present]) and it was already wrong
// when the page was written, i.e. it is a bug in the writer (handleEditAction
// asserts the invariant) or a damaged file. It is reported as an error, never
// silently repaired.
function hashesAreUnusable(page) {
    return ! Array.isArray( page.hashes ) || page.hashes.length !== page.history.length + 1;
}

function hashesLookStale(pageId, page) {
    // hashAny: the anchor. Feeds through serialize, so this also covers a change
    // to the serialization the hash is computed over.
    if ( page.hashes[0] !== hashAny( pageId ) ) {
        return true;
    }
    // hashNext: the chaining itself, which can change independently of hashAny.
    if ( page.history.length >= 1
         && page.hashes[1] !== hashNext( page.hashes[0], page.history[0] ) ) {
        return true;
    }
    return false;
}

function rebuildHashes(pageId, page) {
    const hashes = [ hashAny( pageId ) ];
    for ( let i = 0; i < page.history.length; ++i ) {
        hashes.push( hashNext( hashes[i], page.history[i] ) );
    }
    return hashes;
}

function repairChain(pageId, page) {
    page.hashes = rebuildHashes( pageId, page );
    savePage( pageId, page );
    return page;
}

function loadPage(pageId) {
    const page = loadItem(pageId, 'page', isUuid);
    if ( ! page ) {
        return page;
    }
    if ( hashesAreUnusable(page) ) {
        const stored = Array.isArray(page.hashes) ? page.hashes.length : typeof page.hashes;
        throw new Error(`[SERVER] page ${pageId} has an unusable hash chain on disk: ${stored} hashes for ${page.history.length} actions (present = ${page.present}), expected ${page.history.length + 1}. This is a writer bug or a damaged file, not a hash function change.`);
    }
    if ( hashesLookStale( pageId, page ) ) {
        debug.log(`[SERVER] hash chain of page ${pageId} was not produced by the current hash function, rebuilding from history.`);
        return repairChain( pageId, page );
    }
    return page;
}


function createBoard(boardId, owner, path) {
    if ( ! isUuid( boardId ) ) { 
        debug.log( `refuse to create a board with ID ${boardId}.` );
        return null; 
    }
    debug.log(`[SERVER] Create a standard board.`);
    const pageId = generateSecureUuid();
    const password = generatePasswd();
    const board = {
        passwd: password,
        pageOrder: [pageId],
        owner: owner,
        path: path,
        createdAt: Date.now()
    };
    // Every entry of pageOrder must have a page (see "Lookup invariants" below).
    // The page is written before the board, so no board on disk ever lists a
    // page that was not yet written.
    createPage(pageId);
    saveBoard(boardId, board);
    return board;
}

function createPage(pageId) {
    if ( ! isUuid( pageId ) ) { 
        debug.log( `refuse to create a page with ID ${pageId}.` );
        return null; 
    }
    debug.log(`[SERVER] Create an empty page.`);
    const page = { 
        history: [], // array of edit-ops
        present: 0, // int
        state: { visible: new Set() },
        hashes: [hashAny(pageId)]
    };
    savePage(pageId, page);
    return (page);
}

function loadOrCreatePage(pageId, create=false) {
    let page = loadPage(pageId);
    if (page) { return page; }
    if ( create ) {
        return createPage(pageId);
    } else {
        return null;
    }
}


// Lookup invariants
// =================
// useBoard never creates and usePage does not create by default: boards are
// created only by createNewBoard, pages only by createBoard, new-page and
// delete-page. A lookup therefore returns null for an unknown ID, and every
// caller whose ID comes straight from a client message has to handle that. Callers whose ID comes
// from server state may instead assert non-null, based on:
//
// I1: every entry of a board's pageOrder has a page. pageOrder is written by
//     createBoard, new-page, delete-page (each creates the page first) and
//     shuffle (a permutation of existing entries).
// I2: pageOrder is never empty: createBoard starts it with one page, delete-page
//     keeps at least one, shuffle preserves the length.
// I3: ws.boardId is only set to a board that was just found; boards are never
//     deleted.
// existingPage always returns an entry of pageOrder (by I2); so does findPage,
// given that message validation only admits integer deltas.
//
// All three rest on intact data files: a missing or damaged file shows up as a
// failed assert, never as a silently recreated empty board or page.
//
// Cache bookkeeping: only cached entries are ever evictable, so eviction and
// persistence never touch an ID that is not in the cache.

// page cache
const pageCache = new Map();
const pageCacheMax = 24;
const evictablePages = new Set();

function usePage(pageId, create=false) {
    if (!pageCache.has(pageId)) {
        const page = loadOrCreatePage(pageId, create);
        if ( page ) {
            pageCache.set(pageId, page );
        }
    }
    if (evictablePages.has(pageId)) {
        evictablePages.delete(pageId);
    }
    return pageCache.get(pageId);
}

function persistPage(pageId) {
    const page = pageCache.get(pageId);
    if (page) {
        savePage(pageId, page);
    }
}

function persistAllPages() {
    for (const [uuid, page] of pageCache) {
        savePage(uuid, page);
    }
}

function releasePage(pageId) {
    // a failed lookup has nothing to release
    if (!pageCache.has(pageId)) {
        return;
    }
    if (evictablePages.has(pageId)) {
        evictablePages.delete(pageId);
    }
    evictablePages.add(pageId);
    for (const Id of [...evictablePages]) {
        if (pageCache.size > pageCacheMax) {
            persistPage(Id);
            pageCache.delete(Id);
            evictablePages.delete(Id);
            debug.log(`[SERVER]: evicting page ${Id}`);
        }
    }
}

// board cache
const boardCache = new Map();
const boardCacheMax = 10;
const evictableBoards = new Set();

function useBoard(boardId) {
    if (evictableBoards.has(boardId)) {
        evictableBoards.delete(boardId);
    }
    if (boardCache.has(boardId)) {
        return boardCache.get(boardId);
    }
    const board = loadBoard(boardId);
    if (board) {
        boardCache.set(boardId, board);
    }
    return board;
}

function persistBoard(boardId) {
    const board = boardCache.get(boardId);
    if (board) {
        saveBoard(boardId, board);
    }
}

function persistAllBoards() {
    for (const [uuid, board] of boardCache) {
        saveBoard(uuid, board);
    }
}

function releaseBoard(boardId) {
    // a failed lookup has nothing to release
    if (!boardCache.has(boardId)) {
        return;
    }
    if (evictableBoards.has(boardId)) {
        evictableBoards.delete(boardId);
    }
    evictableBoards.add(boardId);
    for (const Id of [...evictableBoards]) {
        if (boardCache.size > boardCacheMax) {
            persistBoard(Id);
            boardCache.delete(Id);
            evictableBoards.delete(Id);
        }
    }
}


// Board index
// ===========
// Owner, path, password and creation time of every owned board, read from the board
// files at startup and updated wherever a board file with a new path is written. The
// board files stay the single source of truth; the index saves reading them for
// listing boards and checking the path rules. A board's password never changes, so
// the index may hold it. Boards from before ownership have no owner and no entry.

const boardIndex = new Map(); // boardId -> { owner, path, passwd, createdAt }
const ownerPaths = new Map(); // owner -> Map( path -> boardId )

function indexBoard(boardId, entry) {
    boardIndex.set(boardId, entry);
    if (!ownerPaths.has(entry.owner)) {
        ownerPaths.set(entry.owner, new Map());
    }
    ownerPaths.get(entry.owner).set(entry.path, boardId);
}

function pathsOf(owner) {
    return ownerPaths.get(owner) || new Map();
}

// Startup: index every owned board. A board file this server wrote that is damaged
// or breaks the path rules is inconsistent data: the server refuses to start.
function buildBoardIndex() {
    for (const file of fs.readdirSync(DATA_DIR)) {
        if (!file.endsWith('.board')) { continue; }
        const boardId = file.slice(0, -'.board'.length);
        if (!isUuid(boardId)) { continue; }
        const board = loadBoard(boardId);
        if (!board) {
            throw new Error(`[SERVER] board file ${file} is empty or unreadable`);
        }
        if (board.owner === undefined) { continue; }
        if (!isUuid(board.owner) || typeof board.path !== 'string' || normalizePath(board.path) !== board.path
            || typeof board.passwd !== 'string' || typeof board.createdAt !== 'number') {
            throw new Error(`[SERVER] board ${boardId} has a malformed owner, path, password or creation time`);
        }
        const sameName = pathsOf(board.owner).get(board.path);
        if (sameName !== undefined) {
            throw new Error(`[SERVER] boards ${sameName} and ${boardId} of user ${board.owner} have the same path ${board.path}`);
        }
        indexBoard(boardId, { owner: board.owner, path: board.path, passwd: board.passwd, createdAt: board.createdAt });
    }
    for (const [owner, paths] of ownerPaths) {
        const conflict = findPathConflict(paths.keys());
        if (conflict) {
            throw new Error(`[SERVER] boards of user ${owner} break the path rules: ${conflict}`);
        }
    }
    debug.log(`[SERVER] Indexed ${boardIndex.size} owned boards`);
}

buildBoardIndex();

// Path changes
// ============
// A change of one or more board paths is checked against the owner's final set of
// paths and then written board by board, each board file (and the directory) synced
// before the next. The order keeps every state on disk within the path rules: a board
// moves to its new path only after every board whose old path equals, contains or lies
// inside that path has been written. Then a crash between two writes leaves some boards
// moved and the others not, never two boards with one path, so the startup check of
// the index fails only on a bug.

function pathsOverlap(a, b) {
    return a === b || a.startsWith(b + '/') || b.startsWith(a + '/');
}

// changes: [{ boardId, oldPath, newPath }]; the same changes in a safe write order,
// or null if there is none
function writeOrder(changes) {
    const pending = [...changes];
    const order = [];
    while (pending.length > 0) {
        const next = pending.findIndex(change =>
            pending.every(other => other === change || !pathsOverlap(change.newPath, other.oldPath)));
        if (next === -1) {
            return null;
        }
        order.push(...pending.splice(next, 1));
    }
    return order;
}

// Write ordered changes of one owner's board paths and update the index
function applyPathChanges(owner, orderedChanges) {
    const paths = pathsOf(owner);
    for (const { boardId, oldPath, newPath } of orderedChanges) {
        const board = useBoard(boardId);
        assert( board ); // the index lists only boards whose files it read
        board.path = newPath;
        saveBoard(boardId, board);
        syncDataDir();
        releaseBoard(boardId);
        assert( paths.get(oldPath) === boardId );
        paths.delete(oldPath);
        paths.set(newPath, boardId);
        boardIndex.get(boardId).path = newPath;
    }
}


// page manipulation
// =================

function getPage(boardId, pageId) {
    const board = useBoard(boardId);
    assert(board.pageOrder.includes(pageId));
    return usePage(pageId);
}

function insertPage(boardId, pageId, where) {
    const board = useBoard(boardId);
    assert(0 <= where && where <= board.pageOrder.length);
    assert(!board.pageOrder.includes(pageId));
    board.pageOrder.splice(where, 0, pageId);
}


function existingPage(pageId, board) {
    if (board.pageOrder.includes(pageId)) {
        return pageId;
    }
    
    // The deletion map has no cycles: its values were live pages when they were
    // entered, and a deleted page never returns to any pageOrder. A cycle is a bug.
    // Chains may be arbitrarily long, though, so their length is not bounded here.
    let currentId = pageId;
    let replacementId = deletionMap[currentId];
    const visited = new Set( [ pageId ] );
    while (replacementId) {
        currentId = replacementId;
        assert(!visited.has(currentId));
        visited.add(currentId);
        replacementId = deletionMap[currentId];
    }
    
    // Verify the final replacement actually exists
    if (board.pageOrder.includes(currentId)) {
        return currentId;
    }
    
    // Fallback: if we still don't have a valid page, return the first page of the board
    assert(board.pageOrder.length > 0);
    return board.pageOrder[0];
}


// internet
// ========

// const serverOptions = {
//     key: fs.readFileSync(getFilePath("server", "key")),
//     cert: fs.readFileSync(getFilePath("server", "cert"))
// };

// debug.log(`key = ${serverOptions.key}, cert = ${serverOptions.cert}`);

// Whitelist of files to serve for PWA support
const serveableFiles = {
    '/manifest.json': { path: 'manifest.json', type: 'application/json' },
    '/sw.js': { path: 'sw.js', type: 'application/javascript' },
    '/icon-192.png': { path: 'icon-192.png', type: 'image/png' },
    '/icon-512.png': { path: 'icon-512.png', type: 'image/png' },
    '/apple-touch-icon.png': { path: 'apple-touch-icon.png', type: 'image/png' },
    '/favicon.ico': { path: 'favicon.ico', type: 'image/vnd.microsoft.icon' },
    '/robots.txt': { path: 'robots.txt', type: 'text/plain' }
};


function isValidRequest(req) {
    const urlParts = url.parse(req.url, true);
    const pathname = urlParts.pathname;
    
    // 1. Strict Path Validation: Only allow the root path
    // This blocks /prefix, /admin, /.env, etc.
    if (pathname !== '/') {
        return false;
    }

    // 2. Query Parameter Validation
    const queryKeys = Object.keys(urlParts.query);
    const allowedKeys = ['board', 'passwd', 'login', 'credential'];

    // Ensure all keys used are in the whitelist
    const hasInvalidParams = queryKeys.some(key => !allowedKeys.includes(key));
    if (hasInvalidParams) {
        return false;
    }
    
    // Ensure that there is a key:
    const hasValidParams = queryKeys.some(key => allowedKeys.includes(key));

    return hasValidParams;
}


// const httpServer = https.createServer( serverOptions, (req, res) => {
const httpServer = http.createServer( (req, res) => {
    const requestUrl = url.parse(req.url).pathname;
    
    // Trust proxy headers - critical for HTTPS detection behind reverse proxy
    // This allows PWA/service workers to work correctly
    const forwardedProto = req.headers['x-forwarded-proto'];
    const isSecure = forwardedProto === 'https' || req.connection.encrypted;
    
    // Add security headers for HTTPS responses
    if (isSecure) {
        // Inform browser this should always be accessed via HTTPS
        res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    
    // Check if this is a PWA file request
    if (serveableFiles[requestUrl]) {
        const fileInfo = serveableFiles[requestUrl];
        const filePath = path.join(__dirname, fileInfo.path);
        
        fs.readFile(filePath, (err, data) => {
            if (err) {
                if (err.code === 'ENOENT') {
                    res.writeHead(404, { 'Content-Type': 'text/plain' });
                    res.end('File not found');
                } else {
                    res.writeHead(500);
                    res.end('Server error: ' + err.code);
                }
                return;
            }
            
            res.writeHead(200, { 'Content-Type': fileInfo.type });
            res.end(data);
        });
        return;
    }
    
    // Block hidden files (like .env) immediately
    if ( requestUrl.split('/').some( part => part.startsWith('.') ) ) {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('Access Denied');
        return;
    }

    if ( ! isValidRequest( req ) ) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('File not found');
        return;
    }


    // Default: serve index.html with embedded shared.js
    // rationale: allowing the client to request files opens the attack surface
    // consequence: index.html will be a self contained file; thus we embed shared.js on the fly
    const filePath = path.join(__dirname, 'index.html');
    const contentType = 'text/html';
    
    fs.readFile(filePath, 'utf8', (err, data) => {
        if (err) {
            if (err.code === 'ENOENT') {
                res.writeHead(404, { 'Content-Type': 'text/html' });
                res.end('<h1>404 Not Found</h1><p>The requested URL was not found on this server.</p>');
            } else {
                res.writeHead(500);
                res.end('Sorry, check with the site admin for the error: ' + err.code + ' ..\n');
            }
            return;
        }
        
        // Check if the HTML contains a placeholder for shared.js
        if (data.includes('<script src="shared.js"></script>')) {
            // Read the contents of shared.js
            fs.readFile(path.join(__dirname, 'shared.js'), 'utf8', (jsErr, jsData) => {
                if (jsErr) {
                    res.writeHead(500);
                    res.end('Error loading shared.js: ' + jsErr.code);
                    return;
                }
                
                // Create the WebSocket configuration script
                const wsConfigScript = isDirectMode 
                    ? `const WHITEBOARD_WS_URL = "${websocketUrl}";`
                    : 'const WHITEBOARD_WS_URL = null;';
                
                // Replace the script tag with the actual content and inject WebSocket config
                const modifiedData = data
                    .replace(
                        '<script src="shared.js"></script>',
                        `<script>\n// Begin shared.js content\n${jsData}\n// End shared.js content\n</script>`
                    )
                    .replace(
                        '</head>',
                        `<script>${wsConfigScript}</script>\n</head>`
                    );
                
                res.writeHead(200, { 'Content-Type': contentType });
                res.end(modifiedData);
            });
        } else {
            // No replacement needed, serve the file as-is
            res.writeHead(200, { 'Content-Type': contentType });
            res.end(data);
        }
    });
});

const wss = new WebSocket.Server({
    server: httpServer,
    path: '/ws',
    // Largest message a client may send (after decompression); ws closes the
    // connection on anything bigger. The ws default is 100 MiB.
    maxPayload: 5 * 1024 * 1024,
    perMessageDeflate: {
        zlibDeflateOptions: { level: 1 },
        zlibInflateOptions: { chunkSize: 32 * 1024 },
        serverNoContextTakeover: false,
        clientNoContextTakeover: false,
        threshold: 1024
    }
});

httpServer.listen(serverPort, () => {
    debug.log(`[SERVER] HTTP server is running on port ${serverPort}`);
    if (isDirectMode) {
        debug.log(`[SERVER] Direct access: ${WHITEBOARD_URL}`);
        debug.log(`[SERVER] WebSocket endpoint: ${websocketUrl}`);
    } else {
        debug.log(`[SERVER] WebSocket endpoint available at: /ws`);
        debug.log(`[SERVER] (Accessible via reverse proxy at wss://<your-domain>/ws)`);
    }
});


// Never let secrets reach the logs: a copy of a payload with passwd fields masked.
// Wire messages are plain JSON (no BigInt/Set/Map), so JSON round-trips safely here.
const SECRET_KEYS = new Set(['passwd', 'new-passwd']);
function redactSecrets(value) {
    return JSON.parse(JSON.stringify(value, (key, v) => (SECRET_KEYS.has(key) ? '[redacted]' : v)));
}

function logSentMessage(type, payload, requestId = 'N/A', clientId = 'unknown' ) {
    debug.log(`[SERVER > CLIENT] Sending message of type '${type}' to '${clientId}' in response to '${requestId}' with payload:`, redactSecrets(payload));
}

// Wire messages are plain JSON. serialize/deserialize, with their replacer, reviver
// and indentation, stay for the files on disk and the visible-set comparison.

// The JSON text of every action in a page history, made once: an action is never
// changed after it entered a history, so replays and full pages only join stored text.
const actionText = new WeakMap();

function actionsJson( actions ) {
    const texts = actions.map( action => {
        let text = actionText.get( action );
        if ( text === undefined ) {
            text = JSON.stringify( action );
            actionText.set( action, text );
        }
        return text;
    } );
    return `[${texts.join( ',' )}]`;
}

// Wire text of a message plus a field `key` holding a list of history actions
function messageWithActions( message, key, actions ) {
    const head = JSON.stringify( message );
    return `${head.slice( 0, -1 )},${JSON.stringify( key )}:${actionsJson( actions )}}`;
}

// The text is the same for every recipient: serialize once, not once per client.
function broadcastMessageToBoard( message, boardId, excludeWs = null ) {
    broadcastTextToBoard( JSON.stringify( message ), boardId, excludeWs );
}

function broadcastTextToBoard( text, boardId, excludeWs = null ) {
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN && client.boardId === boardId && client !== excludeWs) {
            client.send( text );
        }
    });
}

function broadcastMessageToPage( message, pageId, excludeWs = null ) {
    const text = JSON.stringify( message );
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN && client.pageId === pageId && client !== excludeWs) {
            client.send( text );
        }
    });
}

function get_page_snapshots(page) {
    const snapshot_indices = recent_snapshots( page.history.length );
    const snapshots = snapshot_indices.map( index => page.hashes[ index ] );
    return ( snapshots );
}

function sendFullPage(ws, boardId, requestedPageId, do_switch, requestId) {
    const board = useBoard(boardId);
    assert( board ); // every caller has just found or created this board

    const pageId = existingPage(requestedPageId, board);
    if ( pageId != requestedPageId ) {
        sendPageLost(ws, board, requestedPageId, pageId, do_switch, requestId );
        releaseBoard(boardId);
        return;
    }
    const page = usePage(pageId);
    assert( page ); // I1: existingPage returns an entry of pageOrder
    if (page) {

        const pageHistory = page.history;
        const pagePresent = page.present;
        const pageHash = page.hashes[pagePresent];
        const pageNr = board.pageOrder.indexOf(pageId) + 1;
        const totalPages = board.pageOrder.length;
        
        const message = {
            type: MESSAGES.SERVER_TO_CLIENT.FULL_PAGE.TYPE,
            [MESSAGES.SERVER_TO_CLIENT.FULL_PAGE.PAGE]: pageId,
            [MESSAGES.SERVER_TO_CLIENT.FULL_PAGE.PRESENT]: pagePresent,
            [MESSAGES.SERVER_TO_CLIENT.FULL_PAGE.HASH]: pageHash,
            [MESSAGES.SERVER_TO_CLIENT.FULL_PAGE.PAGE_NR]: pageNr,
            [MESSAGES.SERVER_TO_CLIENT.FULL_PAGE.TOTAL_PAGES]: totalPages,
            [MESSAGES.SERVER_TO_CLIENT.FULL_PAGE.REQUEST_ID]: requestId,
            [MESSAGES.SERVER_TO_CLIENT.FULL_PAGE.SWITCH]: do_switch
        };
        
        if ( do_switch ) {
            ws.pageId = pageId;
        }

        releasePage(pageId);
        ws.send(messageWithActions(message, MESSAGES.SERVER_TO_CLIENT.FULL_PAGE.HISTORY, pageHistory));
        logSentMessage(message.type, message, requestId, ws.clientId);
    }
    releaseBoard(boardId);
}

function sendPageInfo(ws, boardId, requestedPageId, do_switch, requestId) {
    const board = useBoard(boardId);
    assert( board ); // every caller has just found this board
    const pageId = existingPage(requestedPageId, board);
    const page = usePage(pageId);
    assert( page ); // I1: existingPage returns an entry of pageOrder
    const pageHistory = page.history;
    const pagePresent = page.present;
    const pageHash = page.hashes[pagePresent];
    const pageNr = board.pageOrder.indexOf(pageId) + 1;
    const totalPages = board.pageOrder.length;
    const snapshots = get_page_snapshots(page)
    const message = {
        type: MESSAGES.SERVER_TO_CLIENT.PAGE_INFO.TYPE,
        [MESSAGES.SERVER_TO_CLIENT.PAGE_INFO.PAGE]: pageId,
        [MESSAGES.SERVER_TO_CLIENT.PAGE_INFO.HASH]: pageHash,
        [MESSAGES.SERVER_TO_CLIENT.PAGE_INFO.SNAPSHOTS]: snapshots,
        [MESSAGES.SERVER_TO_CLIENT.PAGE_INFO.PAGE_NR]: pageNr,
        [MESSAGES.SERVER_TO_CLIENT.PAGE_INFO.TOTAL_PAGES]: totalPages,
        [MESSAGES.SERVER_TO_CLIENT.PAGE_INFO.SWITCH]: do_switch, 
        [MESSAGES.SERVER_TO_CLIENT.PAGE_INFO.REQUEST_ID]: requestId
    };
    releasePage(pageId);
    releaseBoard(boardId);
    if ( do_switch ) {
        ws.pageId = pageId;
    }
    ws.send(JSON.stringify(message));
    logSentMessage(message.type, message, requestId, ws.clientId);
}

function sendPageLost(ws, board, requestedPageId, pageId, do_switch, requestId) {
    const pageNr = board.pageOrder.indexOf(pageId) + 1;
    const totalPages = board.pageOrder.length;
    const message = {
        type: MESSAGES.SERVER_TO_CLIENT.PAGE_LOST.TYPE,
        [MESSAGES.SERVER_TO_CLIENT.PAGE_LOST.LOST]: requestedPageId,
        [MESSAGES.SERVER_TO_CLIENT.PAGE_LOST.PAGE]: pageId,
        [MESSAGES.SERVER_TO_CLIENT.PAGE_LOST.PAGE_NR]: pageNr,
        [MESSAGES.SERVER_TO_CLIENT.PAGE_LOST.TOTAL_PAGES]: totalPages,
        [MESSAGES.SERVER_TO_CLIENT.PAGE_LOST.SWITCH]: do_switch,
        [MESSAGES.SERVER_TO_CLIENT.PAGE_LOST.REQUEST_ID]: requestId
    };
    if ( do_switch ) {
        ws.pageId = pageId;
    }
    ws.send(JSON.stringify(message));
    logSentMessage(message.type, message, requestId, ws.clientId);
}


function ping_client_with_page ( client, pageId, board ) {
    assert(board);
    client.pageId = pageId;
    const page = usePage(pageId);
    assert(page); // I1
    assert(board.pageOrder.includes(pageId));
    
    const pageNr = board.pageOrder.indexOf(pageId) + 1;
    const totalPages = board.pageOrder.length;
    const pageHash = page.hashes[page.present];
    const snapshots = get_page_snapshots(page);
    
    const message = {
        type: MESSAGES.SERVER_TO_CLIENT.PING.TYPE,
        [MESSAGES.SERVER_TO_CLIENT.PING.PAGE]: pageId,
        [MESSAGES.SERVER_TO_CLIENT.PING.HASH]: pageHash,
        [MESSAGES.SERVER_TO_CLIENT.PING.PAGE_NR]: pageNr,
        [MESSAGES.SERVER_TO_CLIENT.PING.TOTAL_PAGES]: totalPages,
        [MESSAGES.SERVER_TO_CLIENT.PING.SNAPSHOTS]: snapshots
    };
    releasePage(pageId);
    releaseBoard(client.boardId);
    
    client.send(JSON.stringify(message));
    logSentMessage(message.type, message, 'N/A', client.clientId);
}

function ping_client( client ) {
    const board = useBoard(client.boardId);
    assert(board); // I3
    const pageId = existingPage(client.pageId, board);
    client.pageId = pageId;
    ping_client_with_page( client, pageId, board );
}

function sendPing() {
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN && client.boardId && client.pageId) {
            ping_client( client );
        }
    });
}

function sendPingToBoard ( boardId ) {
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN && boardId === client.boardId && client.pageId) {
            ping_client( client );
        }
    });
}

function boardInfo ( boardId, board, requestId ) {
    const board_info_message = {
        type: MESSAGES.SERVER_TO_CLIENT.BOARD_INFO.TYPE,
        [MESSAGES.SERVER_TO_CLIENT.BOARD_INFO.BOARD]: boardId,
        [MESSAGES.SERVER_TO_CLIENT.BOARD_INFO.PAGES]: board.pageOrder,
        [MESSAGES.SERVER_TO_CLIENT.BOARD_INFO.REQUEST_ID]: requestId
    };
    return ( board_info_message );
}

function broadcastBoardInfo( boardId, board, requestId ) {
    const message = boardInfo( boardId, board, requestId );
    broadcastMessageToBoard( message, boardId );
}

function sendBoardInfo() {
    wss.clients.forEach(client => {
        if ( client.readyState === WebSocket.OPEN && client.boardId ) {
            const boardId = client.boardId;
            const board = useBoard( boardId );
            if ( board ) {
                const message = boardInfo( boardId, board, NULL_UUID );
                releaseBoard( boardId );
                client.send( JSON.stringify( message ) );
            }
        }
    });
}

// Message handlers
const messageHandlers = {};


// A socket that re-registers under a new client ID drops its old entry;
// otherwise the stale entry would keep the socket alive after it closes.
function trackClient(ws, clientId) {
    if (ws.clientId && clients[ws.clientId] === ws) {
        delete clients[ws.clientId];
    }
    ws.clientId = clientId; // Store client ID for tracking
    if (clientId) {
        clients[clientId] = ws;
    }
}

function createNewBoard(ws, clientId, owner, path, requestId) {
    const boardId = generateSecureUuid();
    const board = createBoard(boardId, owner, path);
    if (board) {
        syncDataDir();
        indexBoard(boardId, { owner, path, passwd: board.passwd, createdAt: board.createdAt });
        ws.boardId = boardId; // Store boardId in WebSocket client
        trackClient(ws, clientId);
        ws.pageId = board.pageOrder[0]; // Default to first page
        
        debug.log(`[SERVER] Client ${clientId} registered with board: ${boardId}`);
        
        const response = {
            type: MESSAGES.SERVER_TO_CLIENT.BOARD_CREATED.TYPE,
            [MESSAGES.SERVER_TO_CLIENT.BOARD_CREATED.BOARD]: boardId,
            [MESSAGES.SERVER_TO_CLIENT.BOARD_CREATED.PASSWORD]: board.passwd,
            [MESSAGES.SERVER_TO_CLIENT.BOARD_CREATED.FIRST_PAGE]: ws.pageId,
            [MESSAGES.SERVER_TO_CLIENT.BOARD_CREATED.REQUEST_ID]: requestId
        };
        ws.send(JSON.stringify(response));
        logSentMessage( MESSAGES.SERVER_TO_CLIENT.BOARD_CREATED.TYPE, response, requestId, clientId );
        releaseBoard(boardId);
        sendFullPage(ws, boardId, ws.pageId, true, requestId);
    }
}

function registerBoard(ws, boardId, clientId, requestId) {
    const board = useBoard(boardId);
    if (board) {
        ws.boardId = boardId; // Store boardId in WebSocket client
        trackClient(ws, clientId);
        ws.pageId = board.pageOrder[0]; // Default to first page
        
        debug.log(`[SERVER] Client ${clientId} registered with board: ${boardId}`);
        
        const response = {
            type: MESSAGES.SERVER_TO_CLIENT.BOARD_REGISTERED.TYPE,
            [MESSAGES.SERVER_TO_CLIENT.BOARD_REGISTERED.BOARD]: boardId,
            [MESSAGES.SERVER_TO_CLIENT.BOARD_REGISTERED.FIRST_PAGE]: ws.pageId,
            [MESSAGES.SERVER_TO_CLIENT.BOARD_REGISTERED.LAST_PAGE]: board.pageOrder[ board.pageOrder.length - 1 ],
            [MESSAGES.SERVER_TO_CLIENT.BOARD_REGISTERED.TOTAL_PAGES]: board.pageOrder.length,
            [MESSAGES.SERVER_TO_CLIENT.BOARD_REGISTERED.REQUEST_ID]: requestId
        };
        ws.send(JSON.stringify(response));
        releaseBoard(boardId);
    } else {
        rejectMessage(ws, NO_SUCH_BOARD, requestId);
    }
}

// Returns an entry of board.pageOrder; relies on delta being an integer
// (enforced by message validation) or undefined.
function findPage ( board, pageId, delta ) {
    if ( delta === undefined ) { delta = 0; }
    pageId = existingPage( pageId, board );
    const index = board.pageOrder.indexOf(pageId);
    if (index === -1) {
        debug.log(`[SERVER] Page not found in board: ${pageId}.`);
        return ( board.pageOrder[0] );
    }
    let newIndex = index + delta;
    if ( newIndex < 0 ) { newIndex = 0; }
    if ( newIndex >= board.pageOrder.length ) { newIndex = board.pageOrder.length - 1; }
    return ( board.pageOrder[newIndex] );
}

function describePage(ws, boardId, pageId, delta, do_switch, requestId) {
    const board = useBoard(boardId);
    if ( board ) {
        const resolvedPageId = findPage( board, pageId, delta );
        debug.log(`[SERVER] Client ${ws.clientId} wants info about page: ${pageId}+${delta} on board ${boardId}`);
        if (resolvedPageId !== pageId) {
            debug.log(`[SERVER] Requested page ${pageId} was deleted, redirecting to replacement ${resolvedPageId}`);
        }
        const page = usePage(resolvedPageId);
        assert( page ); // I1: findPage returns an entry of pageOrder
        const pageNr = board.pageOrder.indexOf(resolvedPageId) + 1;
        const totalPages = board.pageOrder.length;
        const pageHash = page.hashes[page.present];        
        const snapshots = get_page_snapshots(page);
        
        const response = {
            type: MESSAGES.SERVER_TO_CLIENT.PAGE_INFO.TYPE,
            [MESSAGES.SERVER_TO_CLIENT.PAGE_INFO.PAGE]: resolvedPageId,
            [MESSAGES.SERVER_TO_CLIENT.PAGE_INFO.HASH]: pageHash,
            [MESSAGES.SERVER_TO_CLIENT.PAGE_INFO.SNAPSHOTS]: snapshots,
            [MESSAGES.SERVER_TO_CLIENT.PAGE_INFO.PAGE_NR]: pageNr,
            [MESSAGES.SERVER_TO_CLIENT.PAGE_INFO.TOTAL_PAGES]: board.pageOrder.length,
            [MESSAGES.SERVER_TO_CLIENT.PAGE_INFO.SWITCH]: do_switch,           
            [MESSAGES.SERVER_TO_CLIENT.PAGE_INFO.REQUEST_ID]: requestId
        };
        if ( do_switch ) {
            ws.pageId = resolvedPageId;
        }
        ws.send(JSON.stringify(response));
        releasePage(resolvedPageId);
    }
    releaseBoard(boardId);
}

function registerPage(ws, boardId, clientId, pageId, delta, requestId) {
    const board = useBoard(boardId);
    if ( !board ) {
        debug.log(`[SERVER]: Cannot find board ${boardId}`);
    } else {
        const resolvedPageId = findPage( board, pageId, delta );
        ws.boardId = boardId; // Store boardId in WebSocket client
        ws.pageId = resolvedPageId;
        trackClient(ws, clientId);
        
        debug.log(`[SERVER] Client ${clientId} registered with page: ${resolvedPageId} on board ${boardId}`);
        
        const page = usePage(resolvedPageId, false);
        assert( page ); // I1: findPage returns an entry of pageOrder
        if ( !page ) {
            debug.log(`[SERVER]: Cannot find page ${resolvedPageId}`);
        } else {
            const pageNr = board.pageOrder.indexOf(resolvedPageId) + 1;
            const totalPages = board.pageOrder.length;
            const pageHash = page.hashes[page.present];        
            const snapshots = get_page_snapshots(page);
            
            // If requested page was deleted, just register to replacement page seamlessly
            if (resolvedPageId !== pageId) {
                debug.log(`[SERVER] Requested page ${pageId} was deleted, registering to replacement ${resolvedPageId}`);
            }
            
            const response = {
                type: MESSAGES.SERVER_TO_CLIENT.PAGE_REGISTERED.TYPE,
                [MESSAGES.SERVER_TO_CLIENT.PAGE_REGISTERED.PAGE]: resolvedPageId,
                [MESSAGES.SERVER_TO_CLIENT.PAGE_REGISTERED.HASH]: pageHash,
                [MESSAGES.SERVER_TO_CLIENT.PAGE_REGISTERED.SNAPSHOTS]: snapshots,
                [MESSAGES.SERVER_TO_CLIENT.PAGE_REGISTERED.PAGE_NR]: pageNr,
                [MESSAGES.SERVER_TO_CLIENT.PAGE_REGISTERED.TOTAL_PAGES]: board.pageOrder.length,
                [MESSAGES.SERVER_TO_CLIENT.PAGE_REGISTERED.REQUEST_ID]: requestId
            };
            ws.send(JSON.stringify(response));
        }
        releasePage(resolvedPageId);
    }
    releaseBoard(boardId);
}

// Handler for board registration
messageHandlers[MESSAGES.CLIENT_TO_SERVER.REGISTER_BOARD.TYPE] = (ws, data, requestId) => {
    if ( is_invalid_REGISTER_BOARD_message( data ) ) { 
        debug.log(`[SERVER] dropped register page request from `, ws.clientId); 
        return;
    }
    const clientId = data[MESSAGES.CLIENT_TO_SERVER.REGISTER_BOARD.CLIENT_ID];
    let boardId = data[MESSAGES.CLIENT_TO_SERVER.REGISTER_BOARD.BOARD];
    if ( boardId && isUuid( boardId ) ) {
        registerBoard(ws, boardId, clientId, requestId);
    } else {
        debug.error( `Client ${clientId} wants to register invalid board ${boardId}` );
    }
};

// Handler for board info request
messageHandlers[MESSAGES.CLIENT_TO_SERVER.BOARD_INFO_REQUEST.TYPE] = (ws, data, requestId) => {
    if ( is_invalid_BOARD_INFO_REQUEST_message( data ) ) {
        debug.log(`[SERVER] dropped board info request from `, ws.clientId);
        return;
    }
    const boardId = data[MESSAGES.CLIENT_TO_SERVER.BOARD_INFO_REQUEST.BOARD];
    const do_register = data[MESSAGES.CLIENT_TO_SERVER.BOARD_INFO_REQUEST.REGISTER];

    const board = useBoard( boardId );
    if ( board ) {
        if ( do_register ) {
            ws.boardId = boardId;
            ws.pageId = board.pageOrder[0];
            debug.log(`[SERVER] Client ${ws.clientId} registered with board via board-info-request: ${boardId}`);
        }

        const message = {
            type: MESSAGES.SERVER_TO_CLIENT.BOARD_INFO.TYPE,
            [MESSAGES.SERVER_TO_CLIENT.BOARD_INFO.BOARD]: boardId,
            [MESSAGES.SERVER_TO_CLIENT.BOARD_INFO.PAGES]: board.pageOrder,
            [MESSAGES.SERVER_TO_CLIENT.BOARD_INFO.REQUEST_ID]: requestId
        };
        ws.send(JSON.stringify(message));
        logSentMessage(message.type, message, requestId, ws.clientId);
    }
    releaseBoard(boardId);
};

// Handler for shuffle proposal
messageHandlers[MESSAGES.CLIENT_TO_SERVER.SHUFFLE_PROPOSAL.TYPE] = (ws, data, requestId) => {
    if ( is_invalid_SHUFFLE_PROPOSAL_message( data ) ) {
        debug.log(`[SERVER] dropped shuffle proposal from `, ws.clientId);
        return;
    }
    const boardId = data[MESSAGES.CLIENT_TO_SERVER.SHUFFLE_PROPOSAL.BOARD];
    if ( ws.boardId !== boardId ) {
        debug.log(`[SERVER] Client ${ws.clientId} not registered for board ${boardId}, dropping shuffle proposal`);
        return;
    }
    const password = data[MESSAGES.CLIENT_TO_SERVER.SHUFFLE_PROPOSAL.PASSWORD];
    const before = data[MESSAGES.CLIENT_TO_SERVER.SHUFFLE_PROPOSAL.BEFORE];
    const after = data[MESSAGES.CLIENT_TO_SERVER.SHUFFLE_PROPOSAL.AFTER];

    const board = useBoard( boardId );
    if ( !board ) {
        debug.log(`[SERVER] Cannot find board ${boardId}`);
        releaseBoard(boardId);
        return;
    }

    // Password check
    if ( !password || !passwdMatches(password, board.passwd) ) {
        debug.log(`[SERVER] Shuffle proposal declined: unauthorized`);
        // decline: send BOARD_INFO with current state
        const declineMessage = {
            type: MESSAGES.SERVER_TO_CLIENT.BOARD_INFO.TYPE,
            [MESSAGES.SERVER_TO_CLIENT.BOARD_INFO.BOARD]: boardId,
            [MESSAGES.SERVER_TO_CLIENT.BOARD_INFO.PAGES]: board.pageOrder,
            [MESSAGES.SERVER_TO_CLIENT.BOARD_INFO.REQUEST_ID]: requestId
        };
        ws.send(JSON.stringify(declineMessage));
        logSentMessage(declineMessage.type, declineMessage, requestId, ws.clientId);
        releaseBoard(boardId);
        return;
    }

    // Sync check: client's BEFORE must match current state
    if ( !isEqual( before, board.pageOrder ) ) {
        debug.log(`[SERVER] Shuffle proposal declined: out of sync`);
        // decline: send BOARD_INFO with current state
        const declineMessage = {
            type: MESSAGES.SERVER_TO_CLIENT.BOARD_INFO.TYPE,
            [MESSAGES.SERVER_TO_CLIENT.BOARD_INFO.BOARD]: boardId,
            [MESSAGES.SERVER_TO_CLIENT.BOARD_INFO.PAGES]: board.pageOrder,
            [MESSAGES.SERVER_TO_CLIENT.BOARD_INFO.REQUEST_ID]: requestId
        };
        ws.send(JSON.stringify(declineMessage));
        logSentMessage(declineMessage.type, declineMessage, requestId, ws.clientId);
        releaseBoard(boardId);
        return;
    }

    // Permutation check: AFTER must contain the same UUIDs
    if ( before.length !== after.length ) {
        debug.log(`[SERVER] Shuffle proposal declined: length mismatch`);
        const declineMessage = {
            type: MESSAGES.SERVER_TO_CLIENT.BOARD_INFO.TYPE,
            [MESSAGES.SERVER_TO_CLIENT.BOARD_INFO.BOARD]: boardId,
            [MESSAGES.SERVER_TO_CLIENT.BOARD_INFO.PAGES]: board.pageOrder,
            [MESSAGES.SERVER_TO_CLIENT.BOARD_INFO.REQUEST_ID]: requestId
        };
        ws.send(JSON.stringify(declineMessage));
        logSentMessage(declineMessage.type, declineMessage, requestId, ws.clientId);
        releaseBoard(boardId);
        return;
    }

    const beforeSet = new Set( before );
    const afterSet = new Set( after );
    if ( beforeSet.size !== afterSet.size || ![...beforeSet].every( id => afterSet.has( id ) ) ) {
        debug.log(`[SERVER] Shuffle proposal declined: not a valid permutation`);
        const declineMessage = {
            type: MESSAGES.SERVER_TO_CLIENT.BOARD_INFO.TYPE,
            [MESSAGES.SERVER_TO_CLIENT.BOARD_INFO.BOARD]: boardId,
            [MESSAGES.SERVER_TO_CLIENT.BOARD_INFO.PAGES]: board.pageOrder,
            [MESSAGES.SERVER_TO_CLIENT.BOARD_INFO.REQUEST_ID]: requestId
        };
        ws.send(JSON.stringify(declineMessage));
        logSentMessage(declineMessage.type, declineMessage, requestId, ws.clientId);
        releaseBoard(boardId);
        return;
    }

    // Accept: apply the permutation and persist
    debug.log(`[SERVER] Shuffle proposal accepted: reordering pages`);
    board.pageOrder = after;
    persistBoard( boardId );

    const acceptMessage = {
        type: MESSAGES.SERVER_TO_CLIENT.BOARD_INFO.TYPE,
        [MESSAGES.SERVER_TO_CLIENT.BOARD_INFO.BOARD]: boardId,
        [MESSAGES.SERVER_TO_CLIENT.BOARD_INFO.PAGES]: board.pageOrder,
        [MESSAGES.SERVER_TO_CLIENT.BOARD_INFO.REQUEST_ID]: requestId
    };

    releaseBoard(boardId);

    // Broadcast to all subscribers on this board (including proposer)
    broadcastMessageToBoard(acceptMessage, boardId);
    logSentMessage(acceptMessage.type, acceptMessage, requestId, ws.clientId);
};

// Handler for page registration
messageHandlers[MESSAGES.CLIENT_TO_SERVER.REGISTER_PAGE.TYPE] = (ws, data, requestId) => {
    if ( is_invalid_REGISTER_PAGE_message( data ) ) {
        debug.log(`[SERVER] dropped register page request from `, ws.clientId); 
        return;
    }
    const clientId = data[MESSAGES.CLIENT_TO_SERVER.REGISTER_PAGE.CLIENT_ID];
    let boardId =    data[MESSAGES.CLIENT_TO_SERVER.REGISTER_PAGE.BOARD];
    let pageId =     data[MESSAGES.CLIENT_TO_SERVER.REGISTER_PAGE.PAGE];
    let delta =      data[MESSAGES.CLIENT_TO_SERVER.REGISTER_PAGE.DELTA];
    if ( boardId && isUuid( boardId ) && pageId && isUuid( pageId ) ) {
        registerPage(ws, boardId, clientId, pageId, delta, requestId);
    } else {
        debug.error( `Client ${clientId} wants to register invalid page ${pageId}` );
    }
};

// Handler for page info
messageHandlers[MESSAGES.CLIENT_TO_SERVER.PAGE_INFO_REQUEST.TYPE] = (ws, data, requestId) => {
    if ( is_invalid_PAGE_INFO_REQUEST_message( data ) ) { 
        debug.log(`[SERVER] dropped page info request from `, ws.clientId); 
        return;
    }
    let boardId =    data[MESSAGES.CLIENT_TO_SERVER.PAGE_INFO_REQUEST.BOARD];
    let pageId =     data[MESSAGES.CLIENT_TO_SERVER.PAGE_INFO_REQUEST.PAGE];
    let delta =      data[MESSAGES.CLIENT_TO_SERVER.PAGE_INFO_REQUEST.DELTA];
    let do_switch =  data[MESSAGES.CLIENT_TO_SERVER.PAGE_INFO_REQUEST.REGISTER];
    if ( boardId && isUuid( boardId ) && pageId && isUuid( pageId ) ) {
        describePage(ws, boardId, pageId, delta, do_switch, requestId);
    } else {
        debug.error( `Client ${clientId} wants to register invalid page ${pageId}` );
    }
};

// Owner messages
// ==============
// Every message an owner sends because they have an account carries their login
// and credential, and each is checked on its own: the server keeps no login state.
// A check costs one scrypt; one check runs per connection at a time. The action
// runs once the check has succeeded, so it sees the board index as it is then.

function asOwner(ws, data, keys, requestId, act) {
    if ( ws.credentialCheckPending ) {
        rejectMessage(ws, 'a credential is already being checked', requestId);
        return;
    }
    ws.credentialCheckPending = true;
    // An exception in act is a bug and, as an unhandled rejection, ends the process.
    checkLogin(data[keys.LOGIN], data[keys.PASSWORD]).then((user) => {
        ws.credentialCheckPending = false;
        if ( !user ) {
            debug.log(`[SERVER] Client ${ws.clientId} sent a login and credential that do not match`);
            rejectMessage(ws, CREDENTIAL_NOT_ACCEPTED, requestId);
            return;
        }
        // the client may have left while the check ran: nothing to do for nobody
        if ( ws.readyState !== WebSocket.OPEN ) {
            return;
        }
        return act(user);
    });
}

// Handler for changing an owner's credential
messageHandlers[MESSAGES.CLIENT_TO_SERVER.CHANGE_CREDENTIAL.TYPE] = (ws, data, requestId) => {
    if ( is_invalid_CHANGE_CREDENTIAL_message( data ) ) {
        debug.log(`[SERVER] dropped change-credential request from `, ws.clientId);
        return;
    }
    const replacement = data[MESSAGES.CLIENT_TO_SERVER.CHANGE_CREDENTIAL.NEW_PASSWORD];
    asOwner(ws, data, MESSAGES.CLIENT_TO_SERVER.CHANGE_CREDENTIAL, requestId, async (user) => {
        const hash = await hashPasswordAsync(replacement);
        try {
            saveUsersWithHash(user.id, hash);
        } catch (error) {
            debug.error(`[SERVER] Cannot save the credential of user ${user.id}: ${error.message}`);
            rejectMessage(ws, CREDENTIAL_NOT_SAVED, requestId);
            return;
        }
        debug.log(`[SERVER] User ${user.id} changed their credential`);
        if (ws.readyState === WebSocket.OPEN) {
            const response = {
                type: MESSAGES.SERVER_TO_CLIENT.CREDENTIAL_CHANGED.TYPE,
                [MESSAGES.SERVER_TO_CLIENT.CREDENTIAL_CHANGED.REQUEST_ID]: requestId
            };
            ws.send(JSON.stringify(response));
            logSentMessage(response.type, response, requestId, ws.clientId);
        }
    });
};

// Handler for board creation
messageHandlers[MESSAGES.CLIENT_TO_SERVER.CREATE_BOARD.TYPE] = (ws, data, requestId) => {
    if ( is_invalid_CREATE_BOARD_message( data ) ) { 
        debug.log(`[SERVER] dropped create board request from `, ws.clientId); 
        return;
    }
    const path = normalizePath( data[MESSAGES.CLIENT_TO_SERVER.CREATE_BOARD.PATH] );
    const clientId = data[MESSAGES.CLIENT_TO_SERVER.CREATE_BOARD.CLIENT_ID];
    asOwner(ws, data, MESSAGES.CLIENT_TO_SERVER.CREATE_BOARD, requestId, (user) => {
        if ( path === null ) {
            rejectMessage(ws, PATH_INVALID, requestId);
            return;
        }
        if ( findPathConflict( [...pathsOf(user.id).keys(), path] ) ) {
            rejectMessage(ws, PATH_TAKEN, requestId);
            return;
        }
        createNewBoard(ws, clientId, user.id, path, requestId);
    });
};

function boardListMessage(owner, requestId) {
    const L = MESSAGES.SERVER_TO_CLIENT.BOARD_LIST;
    const boards = [...pathsOf(owner)].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([path, boardId]) => {
        const entry = boardIndex.get(boardId);
        return {
            [L.ENTRY_BOARD]: boardId,
            [L.ENTRY_PATH]: path,
            [L.ENTRY_PASSWORD]: entry.passwd,
            [L.ENTRY_CREATED_AT]: entry.createdAt
        };
    });
    return { type: L.TYPE, [L.BOARDS]: boards, [L.REQUEST_ID]: requestId };
}

function sendBoardList(ws, owner, requestId) {
    const message = boardListMessage(owner, requestId);
    ws.send(JSON.stringify(message));
    logSentMessage(message.type, message, requestId, ws.clientId);
}

// Handler for moving or renaming one board (owner only)
messageHandlers[MESSAGES.CLIENT_TO_SERVER.SET_PATH.TYPE] = (ws, data, requestId) => {
    if ( is_invalid_SET_PATH_message( data ) ) {
        debug.log(`[SERVER] dropped set-path request from `, ws.clientId);
        return;
    }
    const boardId = data[MESSAGES.CLIENT_TO_SERVER.SET_PATH.BOARD];
    const newPath = normalizePath( data[MESSAGES.CLIENT_TO_SERVER.SET_PATH.PATH] );
    asOwner(ws, data, MESSAGES.CLIENT_TO_SERVER.SET_PATH, requestId, (user) => {
        const entry = boardIndex.get(boardId);
        if ( !entry || entry.owner !== user.id ) {
            rejectMessage(ws, NOT_OWNER, requestId);
            return;
        }
        if ( newPath === null ) {
            rejectMessage(ws, PATH_INVALID, requestId);
            return;
        }
        if ( newPath !== entry.path ) {
            const others = [...pathsOf(user.id).keys()].filter(path => path !== entry.path);
            if ( findPathConflict( [...others, newPath] ) ) {
                rejectMessage(ws, PATH_TAKEN, requestId);
                return;
            }
            applyPathChanges(user.id, [{ boardId, oldPath: entry.path, newPath }]);
        }
        sendBoardList(ws, user.id, requestId);
    });
};

// Handler for moving or renaming a folder, i.e. every board below it (owner only)
messageHandlers[MESSAGES.CLIENT_TO_SERVER.RENAME_PREFIX.TYPE] = (ws, data, requestId) => {
    if ( is_invalid_RENAME_PREFIX_message( data ) ) {
        debug.log(`[SERVER] dropped rename-prefix request from `, ws.clientId);
        return;
    }
    const from = normalizePath( data[MESSAGES.CLIENT_TO_SERVER.RENAME_PREFIX.FROM] );
    const to = normalizePath( data[MESSAGES.CLIENT_TO_SERVER.RENAME_PREFIX.TO] );
    asOwner(ws, data, MESSAGES.CLIENT_TO_SERVER.RENAME_PREFIX, requestId, (user) => {
        if ( from === null || to === null ) {
            rejectMessage(ws, PATH_INVALID, requestId);
            return;
        }
        const paths = pathsOf(user.id);
        const changes = [];
        for (const [path, boardId] of paths) {
            if ( path.startsWith(from + '/') ) {
                changes.push({ boardId, oldPath: path, newPath: to + path.slice(from.length) });
            }
        }
        if ( changes.length === 0 ) {
            rejectMessage(ws, NO_SUCH_FOLDER, requestId);
            return;
        }
        if ( from !== to ) {
            // the new paths must be normalized paths of acceptable length themselves
            if ( changes.some(change => normalizePath(change.newPath) !== change.newPath) ) {
                rejectMessage(ws, PATH_INVALID, requestId);
                return;
            }
            const moved = new Set(changes.map(change => change.oldPath));
            const others = [...paths.keys()].filter(path => !moved.has(path));
            if ( findPathConflict( [...others, ...changes.map(change => change.newPath)] ) ) {
                rejectMessage(ws, PATH_TAKEN, requestId);
                return;
            }
            const ordered = writeOrder(changes);
            if ( ordered === null ) {
                rejectMessage(ws, RENAME_BLOCKED, requestId);
                return;
            }
            applyPathChanges(user.id, ordered);
        }
        sendBoardList(ws, user.id, requestId);
    });
};

// Handler for an owner's board list
messageHandlers[MESSAGES.CLIENT_TO_SERVER.LIST_BOARDS.TYPE] = (ws, data, requestId) => {
    if ( is_invalid_LIST_BOARDS_message( data ) ) {
        debug.log(`[SERVER] dropped list-boards request from `, ws.clientId);
        return;
    }
    asOwner(ws, data, MESSAGES.CLIENT_TO_SERVER.LIST_BOARDS, requestId, (user) => {
        sendBoardList(ws, user.id, requestId);
    });
};

messageHandlers[MESSAGES.CLIENT_TO_SERVER.FULL_PAGE_REQUEST.TYPE] = (ws, data, requestId) => {
    if ( is_invalid_FULL_PAGE_REQUEST_message( data ) ) { 
        debug.log(`[SERVER] dropped full page request from `, ws.clientId); 
        return;
    }
    debug.log( `[SERVER] handling full page request, requestId = ${requestId}, data = `, data )
    const boardId = data[MESSAGES.CLIENT_TO_SERVER.FULL_PAGE_REQUEST.BOARD];
    if ( ! boardId ) { return; }
    if ( ! isUuid( boardId ) ) { return; }
    const board = useBoard( boardId );
    if ( ! board ) {
        debug.log(`[SERVER] full page request for unknown board ${boardId}, dropped`);
        releaseBoard( boardId );
        return;
    }
    const pageId = data[MESSAGES.CLIENT_TO_SERVER.FULL_PAGE_REQUEST.PAGE];
    const delta = data[MESSAGES.CLIENT_TO_SERVER.FULL_PAGE_REQUEST.DELTA];
    debug.log( "[SERVER] handling full page request", `pageId = ${pageId}, delta = ${delta}`)
    if ( pageId != undefined && isUuid( pageId ) && delta != undefined ) {
        const resolvedPageId = findPage( board, pageId, delta );
        if ( resolvedPageId !== pageId && delta == 0 ) {
            debug.log( "handling full page request, page lost", `${resolvedPageId} vs. ${pageId}, delta = ${delta}`)
            const do_switch = data[MESSAGES.CLIENT_TO_SERVER.FULL_PAGE_REQUEST.REGISTER];
            sendPageLost( ws, board, pageId, resolvedPageId, do_switch, requestId );
        } else {
            debug.log( "handling full page request, full page", `${resolvedPageId} vs. ${pageId}, delta = ${delta}`)
            const do_switch = data[MESSAGES.CLIENT_TO_SERVER.FULL_PAGE_REQUEST.REGISTER];
            if ( do_switch ) {
                ws.pageId = resolvedPageId;
            }
            sendFullPage( ws, boardId, resolvedPageId, do_switch, requestId );
        }
    }
    releaseBoard( boardId );
};

function flag_and_fix_inconsistent_state( page, msg ) {
    // this is dead in production. the function is a debug tool.
    return;
    const current_visible = compileVisualState( page.history.slice( 0, page.present ) ).visible;
    const visible = page.state.visible;
    if ( 
        ! ( [...current_visible].every( (element) => visible.has(element) )
            &&
            [...visible].every( (element) => current_visible.has(element) ) ) ) {
        const rhs = serialize( visible );
        const lhs = serialize( current_visible );
        debug.log( msg, "visible set BAD",`time = ${page.present}, actual = ${lhs} vs predicted = ${rhs}`);
        page.state.visible = current_visible;
    }
}

function handleEditAction(page, action) {
    flag_and_fix_inconsistent_state( page, "edit" );
    if ( commitEdit( page.state, action ) ) {
        const future_size = page.history.length - page.present;
        page.history.splice(page.present, future_size);
        page.history.push(action);
        page.hashes.splice(page.present + 1, future_size);
        page.hashes.push(hashNext(page.hashes[page.present], action));
        page.present = page.history.length;
        // The chain must keep describing the history: one hash per action plus the
        // anchor. Asserted where the arrays are mutated, so a bug surfaces at its
        // origin instead of reaching the disk and being repaired on the next load.
        assert( page.hashes.length === page.history.length + 1 );
        flag_and_fix_inconsistent_state( page, "edit exit" );
        return true;
    }
    flag_and_fix_inconsistent_state( page, "edit 2nd exit" );
    return false;
}

function handleUndoAction(page, action) {
    flag_and_fix_inconsistent_state( page, "undo" );
    if (page.present > 0) {
        const currentAction = page.history[page.present - 1];
        if (currentAction[MOD_ACTIONS.UUID] === action[MOD_ACTIONS.UNDO.TARGET_ACTION]) {
            // The last accepted action was committed to this very state, so
            // reverting it can only fail if the state is inconsistent.
            const reverted = revertEdit( page.state, currentAction );
            assert( reverted );
            page.present -= 1;
            flag_and_fix_inconsistent_state( page, "undo exit" );
            return true;
        }
    }
    return false;
}

function handleRedoAction(page, action) {
    flag_and_fix_inconsistent_state( page, "redo" );
    if (page.present < page.history.length) {
        const nextAction = page.history[page.present];
        if (nextAction[MOD_ACTIONS.UUID] === action[MOD_ACTIONS.REDO.TARGET_ACTION]) {
            // The state is back where this action was accepted, so committing
            // it again can only fail if the state is inconsistent.
            const committed = commitEdit( page.state, nextAction );
            assert( committed );
            page.present += 1;
            flag_and_fix_inconsistent_state( page, "redo exit" );
            return true;
        }
    }
    return false;
}

function createDeclineMessage(boardId, pageId, targetActionId, reason = "") {
    return {
        type: MESSAGES.SERVER_TO_CLIENT.DECLINE.TYPE,
        [MESSAGES.SERVER_TO_CLIENT.DECLINE.PAGE]: pageId,
        [MESSAGES.SERVER_TO_CLIENT.DECLINE.ACTION_UUID]: targetActionId,
        [MESSAGES.SERVER_TO_CLIENT.DECLINE.REASON]: reason
    };
}

// Handler for modification actions
messageHandlers[MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.TYPE] = (ws, data, requestId) => {
    if ( is_invalid_MOD_ACTION_PROPOSALS_message( data ) ) { 
        debug.log(`[SERVER] dropped mod action proposal from '${ws.clientId}' data = `, redactSecrets(data));
        return;
    }
    const boardId = data[MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.BOARD];
    const password = data[MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.PASSWORD];
    const pageUuid = data[MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.PAGE];
    const action = data[MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.PAYLOAD];
    const beforeHash = data[MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.BEFORE_HASH];
    const clientId = ws.clientId;
    const actionId = action[MOD_ACTIONS.UUID];

    debug.log(`[SERVER]: actionId = ${actionId}`);

    const board = useBoard( boardId );
    if (!board) {
        releaseBoard( boardId );
        debug.log(`[SERVER]: Cannot find board ${boardId}`);
        return;
    }

    // debug.log(`password = ${password},  board.passwd = ${board.passwd}`);
    if ( !password || !passwdMatches(password, board.passwd) ) {
        const declineMessage = createDeclineMessage(boardId, pageUuid, actionId, "unauthorized");
        ws.send(JSON.stringify(declineMessage));
        logSentMessage(declineMessage.type, declineMessage, requestId, ws.clientId);
        releaseBoard(boardId);
        return;
    }

    // The target page must actually belong to this board. Otherwise:
    // - DRAW/ERASE/UNDO/REDO would create ghost pages via usePage(create=true)
    // - DELETE_PAGE with indexOf === -1 would splice(-1, 1) and remove the LAST page
    // - NEW_PAGE would insert at index 0 for a bogus anchor
    if ( !board.pageOrder.includes( pageUuid ) ) {
        const declineMessage = createDeclineMessage(boardId, pageUuid, actionId, "page not on board");
        ws.send(JSON.stringify(declineMessage));
        logSentMessage(declineMessage.type, declineMessage, requestId, ws.clientId);
        releaseBoard(boardId);
        return;
    }

    const page = usePage( pageUuid );
    assert( page ); // I1: pageUuid is on this board (checked above)

    let accept;
    let reason;
    const actionType = action.type;
    switch (actionType) {
    case MOD_ACTIONS.DRAW.TYPE:
        accept = handleEditAction(page, action);
        reason = "cannot apply action to current visual state";
        break;
    case MOD_ACTIONS.ERASE.TYPE:
        accept = handleEditAction(page, action);
        reason = "cannot apply action to current visual state";
        break;
    case MOD_ACTIONS.GROUP.TYPE:
        accept = handleEditAction(page, action);
        reason = "cannot apply action to current visual state";
        break;
    case MOD_ACTIONS.UNDO.TYPE:
        accept = handleUndoAction(page, action);
        reason = "can only undo the immediate past";
        break;
    case MOD_ACTIONS.REDO.TYPE:
        accept = handleRedoAction(page, action);
        reason = "can only redo the immediate future";
        break;
    case MOD_ACTIONS.NEW_PAGE.TYPE:
        releasePage(pageUuid);
        const newPageId = generateSecureUuid();
        const newPage = createPage(newPageId);
        releasePage(newPageId);
        debug.log(`[SERVER]: add new page ${newPageId} behind ${pageUuid}`);
        board.pageOrder.splice(board.pageOrder.indexOf(pageUuid) + 1, 0, newPageId);
        const message = boardInfo( boardId, board, requestId );
        releaseBoard( boardId );
        sendFullPage(ws, boardId, newPageId, true, requestId);
        sendPingToBoard( boardId );
        broadcastMessageToBoard( message, boardId );
        return;
    case MOD_ACTIONS.DELETE_PAGE.TYPE:
        releasePage(pageUuid);
        if (board.pageOrder.length > 1) {
            const index = board.pageOrder.indexOf(pageUuid);
            board.pageOrder.splice(index, 1);
            const newPageId = board.pageOrder[Math.min(index, board.pageOrder.length - 1)];
            deletionMap[pageUuid] = newPageId;
            const message = boardInfo( boardId, board, requestId );
            releaseBoard(boardId);
            sendPageInfo(ws, boardId, newPageId, true, requestId);
            sendPingToBoard( boardId );
            broadcastMessageToBoard( message, boardId );
        } else {
            const index = board.pageOrder.indexOf(pageUuid);                
            const newPageId = generateSecureUuid();
            deletionMap[pageUuid] = newPageId;
            const newPage = createPage(newPageId);
            releasePage( newPageId );
            board.pageOrder[ index ] = newPageId;
            const message = boardInfo( boardId, board, requestId );
            releaseBoard( boardId );
            sendFullPage( ws, boardId, newPageId, true, requestId );
            sendPingToBoard( boardId );
            broadcastMessageToBoard( message, boardId );
        }
        return;
    default:
        accept = false;
        reason = "unknown action type";
    }
    
    if (accept) {
        const pageHistory = page.history;
        const pagePresent = page.present;
        const pageHash = page.hashes[pagePresent];
        const pageNr = board.pageOrder.indexOf(pageUuid) + 1;
        const totalPages = board.pageOrder.length;
        const snapshots = get_page_snapshots(page)
        const acceptMessage = {
            type: MESSAGES.SERVER_TO_CLIENT.ACCEPT.TYPE,
            [MESSAGES.SERVER_TO_CLIENT.ACCEPT.PAGE]: pageUuid,
            [MESSAGES.SERVER_TO_CLIENT.ACCEPT.ACTION_INDEX]: page.present - 1,
            [MESSAGES.SERVER_TO_CLIENT.ACCEPT.ACTION_UUID]: actionId,
            [MESSAGES.SERVER_TO_CLIENT.ACCEPT.BEFORE_HASH]: page.hashes[page.present - 1],
            [MESSAGES.SERVER_TO_CLIENT.ACCEPT.AFTER_HASH]: page.hashes[page.present],
            [MESSAGES.SERVER_TO_CLIENT.ACCEPT.PAGE_NR]: board.pageOrder.indexOf(pageUuid) + 1,
            [MESSAGES.SERVER_TO_CLIENT.ACCEPT.TOTAL_PAGES]: board.pageOrder.length
        };
        ws.send(JSON.stringify(acceptMessage));
        logSentMessage(acceptMessage.type, acceptMessage, requestId, ws.clientId);
        
        // Start just before the latest change: a new or redone action is the first of
        // the sequence, an undone one stays in it as part of the redo tail. Starting
        // earlier would send every new stroke a second time with the next one.
        const replayActions = [];
        const past = Math.max( 0, pagePresent - 1 );
        for (let time = past; time < page.history.length; ++time) {
            replayActions.push(page.history[time]);
        }
        const replayMessage = {
            type: MESSAGES.SERVER_TO_CLIENT.REPLAY.TYPE,
            [MESSAGES.SERVER_TO_CLIENT.REPLAY.PAGE]: pageUuid,
            [MESSAGES.SERVER_TO_CLIENT.REPLAY.BEFORE_HASH]: page.hashes[past],
            [MESSAGES.SERVER_TO_CLIENT.REPLAY.AFTER_HASH]: page.hashes[ page.history.length ],
            [MESSAGES.SERVER_TO_CLIENT.REPLAY.PRESENT]: page.present,
            [MESSAGES.SERVER_TO_CLIENT.REPLAY.CURRENT_HASH]: page.hashes[page.present],
            [MESSAGES.SERVER_TO_CLIENT.REPLAY.PAGE_NR]: pageNr,
            [MESSAGES.SERVER_TO_CLIENT.REPLAY.TOTAL_PAGES]: totalPages,
            [MESSAGES.SERVER_TO_CLIENT.REPLAY.REQUEST_ID]: actionId,
            [MESSAGES.SERVER_TO_CLIENT.REPLAY.SWITCH]: false
        };
        // const infoMessage = {
        //     type: MESSAGES.SERVER_TO_CLIENT.PAGE_INFO.TYPE,
        //     [MESSAGES.SERVER_TO_CLIENT.PAGE_INFO.PAGE]: pageUuid,
        //     [MESSAGES.SERVER_TO_CLIENT.PAGE_INFO.HASH]: pageHash,
        //     [MESSAGES.SERVER_TO_CLIENT.PAGE_INFO.SNAPSHOTS]: snapshots,
        //     [MESSAGES.SERVER_TO_CLIENT.PAGE_INFO.PAGE_NR]: pageNr,
        //     [MESSAGES.SERVER_TO_CLIENT.PAGE_INFO.TOTAL_PAGES]: totalPages,
        //     [MESSAGES.SERVER_TO_CLIENT.PAGE_INFO.SWITCH]: false, 
        //     [MESSAGES.SERVER_TO_CLIENT.PAGE_INFO.REQUEST_ID]: requestId
        // };
 
        broadcastTextToBoard(messageWithActions(replayMessage, MESSAGES.SERVER_TO_CLIENT.REPLAY.SEQUENCE, replayActions), boardId, ws);
    } else {
        const declineMessage = createDeclineMessage(boardId, pageUuid, actionId, reason);
        ws.send(JSON.stringify(declineMessage));
        logSentMessage(declineMessage.type, declineMessage, requestId, ws.clientId);
    }
    
    releaseBoard(boardId);
    releasePage(pageUuid);
};

messageHandlers[MESSAGES.CLIENT_TO_SERVER.REPLAY_REQUEST.TYPE] = (ws, data, requestId) => {
    if ( is_invalid_REPLAY_REQUEST_message( data ) ) { 
        debug.log(`[SERVER] dropped replay request from '${ws.clientId}' data = `, data); 
        return;
    }
    const boardId = data[MESSAGES.CLIENT_TO_SERVER.REPLAY_REQUEST.BOARD];
    const pageUuid = data[MESSAGES.CLIENT_TO_SERVER.REPLAY_REQUEST.PAGE];
    const present = data[MESSAGES.CLIENT_TO_SERVER.REPLAY_REQUEST.PRESENT];
    const presentHash = data[MESSAGES.CLIENT_TO_SERVER.REPLAY_REQUEST.PRESENT_HASH];
    const do_register = data[MESSAGES.CLIENT_TO_SERVER.REPLAY_REQUEST.REGISTER];
    
    const board = useBoard(boardId);
    if ( ! board ) {
        debug.log(`[SERVER] replay request for unknown board ${boardId}, dropped`);
        releaseBoard( boardId );
        return;
    }
    const pageId = existingPage(pageUuid, board);

    if ( do_register ) {
        ws.pageId = pageId;
    }

    if (pageId !== pageUuid) {
        debug.log(`[SERVER] Hash ${pageUuid} has been replaced by ${pageId}.`);
        sendPageLost( ws, board, pageUuid, pageId, do_register, requestId )
        releaseBoard(boardId);
        return;
    }
    
    const page = usePage(pageId);
    assert( page ); // I1: existingPage returns an entry of pageOrder
    if (page.hashes[present] !== presentHash) {
        debug.log(`[SERVER] Hash ${pageId} changed at time ${present}, sending page info`);
        sendPageInfo( ws, boardId, pageId, do_register, requestId );
        releasePage(pageId);
        releaseBoard(boardId);
        return;
    }

    const replayActions = [];
    for (let time = present; time < page.history.length; ++time) {
        replayActions.push(page.history[time]);
    }
    const replayMessage = {
        type: MESSAGES.SERVER_TO_CLIENT.REPLAY.TYPE,
        [MESSAGES.SERVER_TO_CLIENT.REPLAY.PAGE]: pageUuid,
        [MESSAGES.SERVER_TO_CLIENT.REPLAY.BEFORE_HASH]: presentHash,
        [MESSAGES.SERVER_TO_CLIENT.REPLAY.AFTER_HASH]: page.hashes[page.present],
        [MESSAGES.SERVER_TO_CLIENT.REPLAY.PRESENT]: page.present,
        [MESSAGES.SERVER_TO_CLIENT.REPLAY.CURRENT_HASH]: page.hashes[page.present],
        [MESSAGES.SERVER_TO_CLIENT.REPLAY.PAGE_NR]: board.pageOrder.indexOf(pageId) + 1,
        [MESSAGES.SERVER_TO_CLIENT.REPLAY.TOTAL_PAGES]: board.pageOrder.length,
        [MESSAGES.SERVER_TO_CLIENT.REPLAY.REQUEST_ID]: requestId,
        [MESSAGES.SERVER_TO_CLIENT.REPLAY.SWITCH]: do_register
    };

    releasePage(pageId);
    releaseBoard(boardId);
    ws.send(messageWithActions(replayMessage, MESSAGES.SERVER_TO_CLIENT.REPLAY.SEQUENCE, replayActions));
    logSentMessage(replayMessage.type, replayMessage, requestId, ws.clientId);
};

// Parsing and dispatch are the only steps that see unchecked client input, so
// only their failures are caught: they reject the message. Every handler
// validates its message before using it, so an exception escaping a handler
// means a bug or damaged data. It is deliberately not caught and ends the process.
// The requestId, if given, lets the client match the refusal to its request.
function rejectMessage(ws, reason, requestId) {
    debug.error('[SERVER] Rejected message:', reason);
    if (ws && ws.readyState === WebSocket.OPEN) {
        const errorMessage = {
            type: "error",
            message: reason,
        };
        if (requestId !== undefined) {
            errorMessage.requestId = requestId;
        }
        ws.send(JSON.stringify(errorMessage));
    }
}

function routeMessage(ws, message) {
    let data;
    try {
        data = JSON.parse( message );
    } catch (e) {
        rejectMessage(ws, e.message);
        return;
    }
    if ( ! data ) {
        debug.error('[SERVER] Could not deserialize message: ', message);
        return;
    }
    const requestId = data.requestId || data['action-uuid'] || 'N/A';
    const message_type = data['type'] || 'unknown';

    debug.log(`[CLIENT > SERVER] Received message of type '${message_type}' with requestId '${requestId}' from client ${ws.clientId} on board '${ws.boardId}', data = `, redactSecrets(data) );

    // own properties only: inherited ones (toString, hasOwnProperty, ...) are not handlers
    if ( ! Object.hasOwn( messageHandlers, message_type ) ) {
        rejectMessage(ws, `Unhandled message type: ${data.type}`);
        return;
    }
    messageHandlers[message_type](ws, data, requestId);
}

wss.on('connection', (ws, req) => {
    debug.log(`[SERVER] New WebSocket connection established`);
    
    if (!pingTimer) {
        pingTimer = setInterval( () => {
            sendPing();
        }, pingInterval );
    }

    if (!boardTimer) {
        boardTimer = setInterval( () => {
            sendBoardInfo();
        }, boardInterval );
    }

    ws.on('message', message => routeMessage(ws, message));

    // ws reports frames that violate the protocol (bad opcode, invalid UTF-8,
    // oversized payload, ...) as an 'error' event and then closes the connection
    // itself. That is malformed client input: log it and let the connection go.
    // Without a listener, Node throws the event and the process ends.
    ws.on('error', (error) => {
        debug.error(`[SERVER] Closing connection of client ${ws.clientId} on malformed input: ${error.message}`);
    });
    
    ws.on('close', () => {
        debug.log(`[SERVER] Client disconnected from board: ${ws.boardId || 'unknown'}`);
        
        // Clean up client reference if client ID was stored
        if (ws.clientId && clients[ws.clientId] === ws) {
            delete clients[ws.clientId];
        }
    });
});


function periodicallyPersist () {
    persistAllBoards();
    persistAllPages();
    persistDeletionMap();
}

const intervalPersist = setInterval( periodicallyPersist, 10000 );


// Function to handle the shutdown logic
function shutdown(signal) {
  debug.log(`Received ${signal}. Server is shutting down. Persisting state...`);
  clearInterval( intervalPersist );
  persistAllBoards();
  persistAllPages();
  persistDeletionMap();
  httpServer.close(() => {
    debug.log('Server connections closed. Exiting process.');
    process.exit(0);
  });
}

// Listen for the SIGTERM signal
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
