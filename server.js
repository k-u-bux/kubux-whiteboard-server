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

// const debug = new Console({ stdout: debugNull, stderr: debugTee });
// const debug = new Console({ stdout: debugOutput, stderr: debugTee });
const debug = new Console({ stdout: debugTee, stderr: debugTee });


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

/**
 * Verify a password against a stored hash
 * 
 * @param {string} password - The password to verify
 * @param {string} storedHash - The stored hash in format salt:hash
 * @returns {boolean} True if password matches
 */
function verifyPassword(password, storedHash) {
  try {
    const [saltHex, hashHex] = storedHash.split(':');
    if (!saltHex || !hashHex) {
      debug.error('[SERVER] Invalid hash format - expected salt:hash format');
      return false;
    }
    
    const salt = Buffer.from(saltHex, 'hex');
    const storedHashBuffer = Buffer.from(hashHex, 'hex');
    
    // Compute hash with same parameters
    const computedHash = crypto.scryptSync(password, salt, 64, {
      N: 16384,
      r: 8,
      p: 1
    });
    
    // Use timing-safe comparison to prevent timing attacks
    return crypto.timingSafeEqual(storedHashBuffer, computedHash);
  } catch (error) {
    debug.error('[SERVER] Error verifying password:', error.message);
    return false;
  }
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
    serialize, 
    deserialize,
    createEmptyVisualState, 
    compileVisualState,
    commitEdit, 
    revertEdit,
    commitGroup, 
    MESSAGES, 
    MOD_ACTIONS, 
    ELEMENT, 
    POINT,
    is_invalid_REGISTER_BOARD_message,
    is_invalid_REGISTER_PAGE_message,
    is_invalid_PAGE_INFO_REQUEST_message,
    is_invalid_CREATE_BOARD_message,
    is_invalid_FULL_PAGE_REQUESTS_message,
    is_invalid_REPLAY_REQUESTS_message,
    is_invalid_MOD_ACTION_PROPOSALS_message
} = require('./shared');


// Data storage configuration
const DATA_DIR = './data';

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    debug.log(`[SERVER] Created data directory: ${DATA_DIR}`);
}

// Path helpers
const getPasswdFilePath = () => path.join(CONF_DIR, 'passwd.json');
const getRemovalLogPath = () => path.join(DATA_DIR, 'to_be_removed.json');
const getFilePath = (uuid,ext) => path.join(DATA_DIR, `${uuid}.${ext}`);


// Server state structures
const credentials = [];
const deletionMap = {};
const clients = {}; // Map client IDs to WebSocket instances
const pingInterval = 5000;
let pingTimer;

function initializeGlobals() {
    const filePath = getPasswdFilePath();
    if (fs.existsSync(filePath)) {
        const itemText = fs.readFileSync(filePath, 'utf8');
        const parsed = JSON.parse(itemText);
        Object.assign(credentials, parsed);
        debug.log(`[SERVER] Loaded ${credentials.length} passwords`);
    }
    const removalLogPath = getRemovalLogPath();
    if (fs.existsSync(removalLogPath)) {
        const itemText = fs.readFileSync(removalLogPath, 'utf8');
        const parsedMap = JSON.parse(itemText);
        Object.assign(deletionMap, parsedMap);
        debug.log(`[SERVER] Loaded ${Object.keys(deletionMap).length} deletion mappings`);
    }
}

function persistDeletionMap() {
    const removalLogPath = getRemovalLogPath();
    fs.writeFileSync(removalLogPath, JSON.stringify(deletionMap, null, 2), 'utf8');
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
    fs.writeFileSync(filePath, fileText, 'utf8');
}


const loadBoard = (boardId) => loadItem(boardId, 'board', isUuid);
const loadPage = (pageId) => loadItem(pageId, 'page', isUuid);
const saveBoard = (boardId, board) => saveItem(boardId, board, 'board', isUuid);
const savePage = (pageId, page) => saveItem(pageId, page, 'page', isUuid);


function createBoard(boardId) {
    if ( ! isUuid( boardId ) ) { 
        debug.log( `refuse to create a board with ID ${boardId}.` );
        return null; 
    }
    debug.log(`[SERVER] Create a standard board.`);
    const pageId = generateSecureUuid();
    const password = generatePasswd();
    const board = {
        passwd: password,
        pageOrder: [pageId]
    };
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

function loadOrCreateBoard(boardId) {
    let board = loadBoard(boardId);
    if (board) { return board; }
    return createBoard(boardId);
}

function loadOrCreatePage(pageId) {
    let page = loadPage(pageId);
    if (page) { return page; }
    return createPage(pageId);
}


// page cache
const pageCache = new Map();
const pageCacheMax = 10;
const evictablePages = new Set();

function usePage(pageId) {
    if (!pageCache.has(pageId)) {
        pageCache.set(pageId, loadOrCreatePage(pageId));
    }
    if (evictablePages.has(pageId)) {
        evictablePages.delete(pageId);
    }
    return pageCache.get(pageId);
}

function persistPage(pageId) {
    savePage(pageId, usePage(pageId));
}

function persistAllPages() {
    for (const [uuid, page] of pageCache) {
        savePage(uuid, page);
    }
}

function releasePage(pageId) {
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
    const board = loadOrCreateBoard(boardId);
    if (board) {
        boardCache.set(boardId, board);
    }
    return board;
}

function persistBoard(boardId) {
    saveBoard(boardId, useBoard(boardId));
}

function persistAllBoards() {
    for (const [uuid, board] of boardCache) {
        saveBoard(uuid, board);
    }
}

function releaseBoard(boardId) {
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
    
    let currentId = pageId;
    let replacementId = deletionMap[currentId];
    let N = 0;
    while (replacementId) {
        ++N;
        currentId = replacementId;
        replacementId = deletionMap[currentId];
        // incomplete check and stupid heuristic check against circularity
        assert(!(replacementId === pageId));
        assert(N < 100000);
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
    const allowedKeys = ['board', 'passwd', 'credential'];

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
    perMessageDeflate: {
        zlibDeflateOptions: { level: 6 },
        zlibInflateOptions: { chunkSize: 16 * 1024 },
        serverNoContextTakeover: false,
        clientNoContextTakeover: false,
        threshold: 512
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


function logSentMessage(type, payload, requestId = 'N/A', clientId = 'unknown' ) {
    debug.log(`[SERVER > CLIENT] Sending message of type '${type}' to '${clientId}' in response to '${requestId}' with payload:`, payload);
}

function broadcastMessageToBoard(message, boardId, excludeWs = null) {
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN && client.boardId === boardId && client !== excludeWs) {
            client.send(serialize(message));
        }
    });
}

function broadcastMessageToPage(message, pageId, excludeWs = null) {
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN && client.pageId === pageId && client !== excludeWs) {
            client.send(serialize(message));
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
    if ( ! board ) { return; }

    const pageId = existingPage(requestedPageId, board);
    if ( pageId != requestedPageId ) {
    }
    const page = usePage(pageId);
    if (page) {

        const pageHistory = page.history;
        const pagePresent = page.present;
        const pageHash = page.hashes[pagePresent];
        const pageNr = board.pageOrder.indexOf(pageId) + 1;
        const totalPages = board.pageOrder.length;
        
        const message = {
            type: MESSAGES.SERVER_TO_CLIENT.FULL_PAGE.TYPE,
            [MESSAGES.SERVER_TO_CLIENT.FULL_PAGE.PAGE]: pageId,
            [MESSAGES.SERVER_TO_CLIENT.FULL_PAGE.HISTORY]: pageHistory,
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
        ws.send(serialize(message));
        logSentMessage(message.type, message, requestId, ws.clientId);
    }
    releaseBoard(boardId);
}

function sendPageInfo(ws, boardId, requestedPageId, do_switch, requestId) {
    const board = useBoard(boardId);
    if ( ! board ) { return; }
    const pageId = existingPage(requestedPageId, board);
    const page = usePage(pageId);
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
    if ( do_switch ) {
        ws.pageId = pageId;
    }
    releaseBoard(boardId);
    ws.send(serialize(message));
    logSentMessage(message.type, message, requestId, ws.clientId);
}

function sendPageLost(ws, boardId, requestedPageId, foundPageId, do_switch, requestId) {
    const board = useBoard(boardId);
    if ( ! board ) { return; }
    const pageId = existingPage(requestedPageId, board);
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
    releaseBoard(boardId);
    ws.send(serialize(message));
    logSentMessage(message.type, message, requestId, ws.clientId);
}


function ping_client_with_page ( client, pageId, board ) {
    assert(board);
    client.pageId = pageId;
    const page = usePage(pageId);
    assert(page);
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
    
    client.send(serialize(message));
    logSentMessage(message.type, message, 'N/A', client.clientId);
}

function ping_client( client ) {
    const board = useBoard(client.boardId);
    assert(board);
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


// Message handlers
const messageHandlers = {};


function createNewBoard(ws, clientId, requestId) {
    const boardId = generateSecureUuid();
    const board = createBoard(boardId);
    ws.boardId = boardId;
    if (board) {
        ws.boardId = boardId; // Store boardId in WebSocket client
        ws.clientId = clientId; // Store client ID for tracking
        ws.pageId = board.pageOrder[0]; // Default to first page
        
        if (clientId) {
            clients[clientId] = ws;
        }
        
        debug.log(`[SERVER] Client ${clientId} registered with board: ${boardId}`);
        
        const response = {
            type: MESSAGES.SERVER_TO_CLIENT.BOARD_CREATED.TYPE,
            [MESSAGES.SERVER_TO_CLIENT.BOARD_CREATED.BOARD]: boardId,
            [MESSAGES.SERVER_TO_CLIENT.BOARD_CREATED.PASSWORD]: board.passwd,
            [MESSAGES.SERVER_TO_CLIENT.BOARD_CREATED.FIRST_PAGE_ID]: ws.pageId,
            [MESSAGES.SERVER_TO_CLIENT.BOARD_CREATED.REQUEST_ID]: requestId
        };
        ws.send(serialize(response));
        logSentMessage( MESSAGES.SERVER_TO_CLIENT.BOARD_CREATED.TYPE, response, requestId, clientId );
        releaseBoard(boardId);
        sendFullPage(ws, boardId, ws.pageId, true, requestId);
    }
}

function registerBoard(ws, boardId, clientId, requestId) {
    const board = useBoard(boardId);
    if (board) {
        ws.boardId = boardId; // Store boardId in WebSocket client
        ws.clientId = clientId; // Store client ID for tracking
        ws.pageId = board.pageOrder[0]; // Default to first page
        
        if (clientId) {
            clients[clientId] = ws;
        }
        
        debug.log(`[SERVER] Client ${clientId} registered with board: ${boardId}`);
        
        const response = {
            type: MESSAGES.SERVER_TO_CLIENT.BOARD_REGISTERED.TYPE,
            [MESSAGES.SERVER_TO_CLIENT.BOARD_REGISTERED.BOARD]: boardId,
            [MESSAGES.SERVER_TO_CLIENT.BOARD_REGISTERED.FIRST_PAGE]: ws.pageId,
            [MESSAGES.SERVER_TO_CLIENT.BOARD_REGISTERED.LAST_PAGE]: board.pageOrder[ board.pageOrder.length - 1 ],
            [MESSAGES.SERVER_TO_CLIENT.BOARD_REGISTERED.TOTAL_PAGES]: board.pageOrder.length,
            [MESSAGES.SERVER_TO_CLIENT.BOARD_REGISTERED.REQUEST_ID]: requestId
        };
        ws.send(serialize(response));
        releaseBoard(boardId);
    }
}

function findPage ( board, pageId, delta ) {
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
            [MESSAGES.SERVER_TO_CLIENT.PAGE_INFO.REGISTER]: do_switch,           
            [MESSAGES.SERVER_TO_CLIENT.PAGE_INFO.REQUEST_ID]: requestId
        };
        if ( do_switch ) {
            ws.pageId = pageId;
        }
        ws.send(serialize(response));
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
        ws.clientId = clientId; // Store client ID for tracking
        if (clientId) {
            clients[clientId] = ws;
        }
        
        debug.log(`[SERVER] Client ${clientId} registered with page: ${resolvedPageId} on board ${boardId}`);
        
        const page = usePage(resolvedPageId);
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
            ws.send(serialize(response));
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
    ws.boardId = boardId;
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
    ws.boardId = boardId;
    let pageId =     data[MESSAGES.CLIENT_TO_SERVER.PAGE_INFO_REQUEST.PAGE];
    let delta =      data[MESSAGES.CLIENT_TO_SERVER.PAGE_INFO_REQUEST.DELTA];
    let do_switch =  data[MESSAGES.CLIENT_TO_SERVER.PAGE_INFO_REQUEST.REGISTER];
    if ( boardId && isUuid( boardId ) && pageId && isUuid( pageId ) ) {
        describePage(ws, boardId, pageId, delta, do_switch, requestId);
    } else {
        debug.error( `Client ${clientId} wants to register invalid page ${pageId}` );
    }
};

// Handler for board creation
messageHandlers[MESSAGES.CLIENT_TO_SERVER.CREATE_BOARD.TYPE] = (ws, data, requestId) => {
    if ( is_invalid_CREATE_BOARD_message( data ) ) { 
        debug.log(`[SERVER] dropped create board request from `, ws.clientId); 
        return;
    }
    const clientId = data[MESSAGES.CLIENT_TO_SERVER.CREATE_BOARD.CLIENT_ID];
    let password = data[MESSAGES.CLIENT_TO_SERVER.CREATE_BOARD.PASSWORD];
    
    // Check credentials using scrypt
    let isAuthorized = false;
    
    for (const storedHash of credentials) {
        if (verifyPassword(password, storedHash)) {
            isAuthorized = true;
            debug.log(`[SERVER] Client ${clientId} authenticated successfully`);
            break;
        }
    }
    
    if (!isAuthorized) {
        debug.log(`[SERVER] Client ${clientId} failed authentication`);
        return;
    }
    
    debug.log(`[SERVER] Client ${clientId} is allowed to create boards`);
    createNewBoard(ws, clientId, requestId);
};

messageHandlers[MESSAGES.CLIENT_TO_SERVER.FULL_PAGE_REQUESTS.TYPE] = (ws, data, requestId) => {
    if ( is_invalid_FULL_PAGE_REQUESTS_message( data ) ) { 
        debug.log(`[SERVER] dropped full page request from `, ws.clientId); 
        return;
    }
    debug.log( `[SERVER] handling full page request, requestId = ${requestId}, data = `, data )
    const boardId = data[MESSAGES.CLIENT_TO_SERVER.FULL_PAGE_REQUESTS.BOARD];
    ws.boardId = boardId;
    if ( ! boardId ) { return; }
    if ( ! isUuid( boardId ) ) { return; }
    const board = useBoard( boardId );
    assert(board);
    const pageId = data[MESSAGES.CLIENT_TO_SERVER.FULL_PAGE_REQUESTS.PAGE];
    const delta = data[MESSAGES.CLIENT_TO_SERVER.FULL_PAGE_REQUESTS.DELTA];
    debug.log( "[SERVER] handling full page request", `pageId = ${pageId}, delta = ${delta}`)
    if ( pageId != undefined && isUuid( pageId ) && delta != undefined ) {
        resolvedPageId = findPage( board, pageId, delta );
        if ( resolvedPageId !== pageId && delta == 0 ) {
            debug.log( "handling full page request, page lost", `${resolvedPageId} vs. ${pageId}, delta = ${delta}`)
            sendPageLost( ws, boardId, pageId, resolvedPageId, requestId );
        } else {
            debug.log( "handling full page request, full page", `${resolvedPageId} vs. ${pageId}, delta = ${delta}`)
            const do_switch = data[MESSAGES.CLIENT_TO_SERVER.FULL_PAGE_REQUESTS.REGISTER];
            if ( do_switch ) {
                ws.pageId = resolvedPageId;
            }
            sendFullPage( ws, boardId, resolvedPageId, do_switch, requestId );
        }
    }
    releaseBoard( boardId );
};

function flag_and_fix_inconsistent_state( page, msg ) {
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
            if ( ! revertEdit( page.state, currentAction ) ) {
                debug.log( `BAD: cannot undo action ${currentAction[MOD_ACTIONS.UUID]}` );
                debug.log( `currentAction = ${serialize( currentAction )}` );
            }
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
            if ( ! commitEdit( page.state, nextAction ) ) {
                debug.log( `BAD: cannot redo action ${nextAction[MOD_ACTIONS.UUID]}` );
            }
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

function sendDeclineMessage(context, reason, requestId) {
    const declineMessage = createDeclineMessage(
        context.boardId,
        context.pageUuid,
        context.actionUuid,
        reason
    );
    context.ws.send(serialize(declineMessage));
    logSentMessage(declineMessage.type, declineMessage, requestId, context.ws.clientId);
}

// Handler for modification actions
messageHandlers[MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.TYPE] = (ws, data, requestId) => {
    if ( is_invalid_MOD_ACTION_PROPOSALS_message( data ) ) { 
        debug.log(`[SERVER] dropped mod action proposal from '${ws.clientId}' data = `, data); 
        return;
    }
    try {
        const boardId = data[MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.BOARD];
        ws.boardId = boardId;
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
        if ( !password || password != board.passwd ) {
            const declineMessage = createDeclineMessage(boardId, pageUuid, actionId, "unauthorized");
            ws.send(serialize(declineMessage));
            logSentMessage(declineMessage.type, declineMessage, requestId, ws.clientId);
            releaseBoard(boardId);
            return;
        }

        const page = usePage( pageUuid );
        if (!page) {
            releasePage( pageUuid );
            debug.log(`[SERVER]: Cannot find page ${pageUuid}`);
            return;
        }

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
            releaseBoard(boardId);
            sendFullPage(ws, boardId, newPageId, true, requestId);
            sendPingToBoard( boardId );
            return;
        case MOD_ACTIONS.DELETE_PAGE.TYPE:
            releasePage(pageUuid);
            if (board.pageOrder.length > 1) {
                const index = board.pageOrder.indexOf(pageUuid);
                board.pageOrder.splice(index, 1);
                const newPageId = board.pageOrder[Math.min(index, board.pageOrder.length - 1)];
                deletionMap[pageUuid] = newPageId;
                releaseBoard(boardId);
                sendPageInfo(ws, boardId, newPageId, true, requestId);
                sendPingToBoard( boardId );
            } else {
                const index = board.pageOrder.indexOf(pageUuid);                
                const newPageId = generateSecureUuid();
                deletionMap[pageUuid] = newPageId;
                const newPage = createPage(newPageId);
                releasePage( newPageId );
                board.pageOrder[ index ] = newPageId;
                releaseBoard( boardId );
                sendFullPage( ws, boardId, newPageId, true, requestId );
                sendPingToBoard( boardId );
            }
            return;
        default:
            accept = false;
            reason = "unknown action type";
        }
        
        if (accept) {
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
            ws.send(serialize(acceptMessage));
            logSentMessage(acceptMessage.type, acceptMessage, requestId, ws.clientId);
            
            // Broadcast to other clients
            const pageNr = board.pageOrder.indexOf(pageUuid) + 1;
            const totalPages = board.pageOrder.length;
            const pageHash = page.hashes[page.present];
            const snapshots = get_page_snapshots(page);            
            const pingMessage = {
                type: MESSAGES.SERVER_TO_CLIENT.PING.TYPE,
                [MESSAGES.SERVER_TO_CLIENT.PING.PAGE]: pageUUid,
                [MESSAGES.SERVER_TO_CLIENT.PING.HASH]: pageHash,
                [MESSAGES.SERVER_TO_CLIENT.PING.PAGE_NR]: pageNr,
                [MESSAGES.SERVER_TO_CLIENT.PING.TOTAL_PAGES]: totalPages,
                [MESSAGES.SERVER_TO_CLIENT.PING.SNAPSHOTS]: snapshots
            };
            broadcastMessageToPage(pingMessage, pageId, ws);
        } else {
            const declineMessage = createDeclineMessage(boardId, pageUuid, actionId, reason);
            ws.send(serialize(declineMessage));
            logSentMessage(declineMessage.type, declineMessage, requestId, ws.clientId);
        }
        
        releaseBoard(boardId);
        releasePage(pageUuid);
        
    } catch (error) {
        debug.error(`[SERVER] Error processing mod action: ${error.message}`, error);
        // Send a decline message with the error
        if (ws && data) {
            const errorContext = {
                boardId: data[MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.BOARD],
                pageUuid: data[MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.PAGE],
                actionUuid: data[MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.PAYLOAD]?.[MOD_ACTIONS.UUID],
                ws
            };
            sendDeclineMessage(errorContext, `Server error: ${error.message}`, requestId);
        }
    }
};

messageHandlers[MESSAGES.CLIENT_TO_SERVER.REPLAY_REQUESTS.TYPE] = (ws, data, requestId) => {
    if ( is_invalid_REPLAY_REQUESTS_message( data ) ) { 
        debug.log(`[SERVER] dropped replay request from '${ws.clientId}' data = `, data); 
        return;
    }
    const boardId = data[MESSAGES.CLIENT_TO_SERVER.REPLAY_REQUESTS.BOARD];
    ws.boardId = boardId;
    const pageUuid = data[MESSAGES.CLIENT_TO_SERVER.REPLAY_REQUESTS.PAGE];
    const present = data[MESSAGES.CLIENT_TO_SERVER.REPLAY_REQUESTS.PRESENT];
    const presentHash = data[MESSAGES.CLIENT_TO_SERVER.REPLAY_REQUESTS.PRESENT_HASH];
    const do_register = data[MESSAGES.CLIENT_TO_SERVER.REPLAY_REQUESTS.REGISTER];
    
    const board = useBoard(boardId);
    const pageId = existingPage(pageUuid, board);

    if ( do_register ) {
        ws.pageId = pageUuid;
    }

    if (pageId !== pageUuid) {
        debug.log(`[SERVER] Hash ${pageUuid} has been replaced by ${pageId}.`);
        sendPageLost( ws, boardId, pageUuid, pageId, do_register, requestId )
        releaseBoard(boardId);
        return;
    }
    
    const page = usePage(pageId);
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
        [MESSAGES.SERVER_TO_CLIENT.REPLAY.SEQUENCE]: replayActions,
        [MESSAGES.SERVER_TO_CLIENT.REPLAY.PRESENT]: page.present,
        [MESSAGES.SERVER_TO_CLIENT.REPLAY.CURRENT_HASH]: page.hashes[page.present],
        [MESSAGES.SERVER_TO_CLIENT.REPLAY.PAGE_NR]: board.pageOrder.indexOf(pageId) + 1,
        [MESSAGES.SERVER_TO_CLIENT.REPLAY.TOTAL_PAGES]: board.pageOrder.length,
        [MESSAGES.SERVER_TO_CLIENT.REPLAY.REQUEST_ID]: requestId,
        [MESSAGES.SERVER_TO_CLIENT.REPLAY.SWITCH]: do_register
    };

    releasePage(pageId);
    releaseBoard(boardId);
    ws.send(serialize(replayMessage));
    logSentMessage(replayMessage.type, replayMessage, requestId, ws.clientId);
};

function routeMessage(ws, message) {
    try {
        const data = deserialize( message );
        if ( data ) {
            const requestId = data.requestId || data['action-uuid'] || 'N/A';
            const message_type = data['type'] || 'unknown';

            debug.log(`[CLIENT > SERVER] Received message of type '${message_type}' with requestId '${requestId}' from client ${ws.clientId} on board '${ws.boardId}', data = `, data );
        
            const handler = messageHandlers[message_type];
            if ( handler ) {
                handler(ws, data, requestId);
            } else {
                throw new Error(`Unhandled message type: ${data.type}`);
            }
        } else {
            debug.error('[SERVER] Could not deserialize message: ', message);
        }
    } catch (e) {
        debug.error('[SERVER] Error processing message:', e);
        // Send an error message to the client if possible
        if (ws && ws.readyState === WebSocket.OPEN) {
            const errorMessage = {
                type: "error",
                message: e.message,
            };
            ws.send(serialize(errorMessage));
        }
    }
}

wss.on('connection', (ws, req) => {
    debug.log(`[SERVER] New WebSocket connection established`);
    
    if (!pingTimer) {
        pingTimer = setInterval(() => {
            sendPing();
        }, pingInterval);
    }

    ws.on('message', message => routeMessage(ws, message));
    
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
}

const intervalPersist = setInterval( periodicallyPersist, 10000 );


// Function to handle the shutdown logic
function shutdown(signal) {
  debug.log(`Received ${signal}. Server is shutting down. Persisting state...`);
  clearInterval( intervalPersist );
  persistAllBoards();
  persistAllPages();
  httpServer.close(() => {
    debug.log('Server connections closed. Exiting process.');
    process.exit(0);
  });
}

// Listen for the SIGTERM signal
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
