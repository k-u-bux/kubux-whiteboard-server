const WebSocket = require('ws');
const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const url = require('url');
const assert = require('assert');

// sha256
const crypto = require('crypto');

function sha256(inputString) {
  return crypto.createHash('sha256').update(inputString).digest('hex');
}


const { 
  PORT,
  recent_snapshots,
  hashAny, 
  hashNext, 
  generateUuid, 
  generatePasswd,
  serialize, 
  deserialize,
  createEmptyVisualState, 
  compileVisualState,
  commitEdit, 
  commitGroup, 
  MESSAGES, 
  MOD_ACTIONS, 
  ELEMENT, 
  POINT 
} = require('./shared');

// Data storage configuration
const DATA_DIR = './data';

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    debug.log(`[SERVER] Created data directory: ${DATA_DIR}`);
}

// Logs storage configuration
const LOGS_DIR = './logs';

// Path helpers
const getPasswdFilePath = () => path.join(DATA_DIR, 'passwd.json');
const getRemovalLogPath = () => path.join(DATA_DIR, 'to_be_removed.json');
const getFilePath = (uuid,ext) => path.join(DATA_DIR, `${uuid}.${ext}`);

const getDebugLogPath = () => path.join(LOGS_DIR, 'debug.log');
const debugOutput = fs.createWriteStream(getDebugLogPath, { flags: 'a' });
const debug = new Console({ stdout: debugOutput, stderr: debugOutput });

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

function loadItem(itemId, ext) {
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

function saveItem(itemId, item, ext) {
    const filePath = getFilePath(itemId, ext);
    const fileText = serialize(item);
    fs.writeFileSync(filePath, fileText, 'utf8');
}


const loadBoard = (boardId) => loadItem(boardId, 'board');
const loadPage = (pageId) => loadItem(pageId, 'page');
const saveBoard = (boardId, board) => saveItem(boardId, board, 'board');
const savePage = (pageId, page) => saveItem(pageId, page, 'page');


function createBoard(boardId) {
    debug.log(`[SERVER] Create a standard board.`);
    const pageId = generateUuid();
    const password = generatePasswd();
    const board = {
        passwd: password,
        pageOrder: [pageId]
    };
    saveBoard(boardId, board);
    return board;
}

function createPage(pageId) {
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

const serverOptions = {
    key: fs.readFileSync(getFilePath("server", "key")),
    cert: fs.readFileSync(getFilePath("server", "cert"))
};

// debug.log(`key = ${serverOptions.key}, cert = ${serverOptions.cert}`);

// const httpServer = https.createServer( serverOptions, (req, res) => {
const httpServer = http.createServer( (req, res) => {
    // always serve just index.html
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
                
                // Replace the script tag with the actual content
                const modifiedData = data.replace(
                    '<script src="shared.js"></script>',
                    `<script>\n// Begin shared.js content\n${jsData}\n// End shared.js content\n</script>`
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

httpServer.listen(PORT, () => {
    debug.log(`[SERVER] HTTP server is running on port ${PORT}`);
    debug.log(`WebSocket-Server is running on wss://0.0.0.0:${PORT}/ws`);
});


function logSentMessage(type, payload, requestId = 'N/A') {
    debug.log(`[SERVER > CLIENT] Sending message of type '${type}' in response to '${requestId}' with payload:`, payload);
}

function broadcastMessageToBoard(message, boardId, excludeWs = null) {
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN && client.boardId === boardId && client !== excludeWs) {
            client.send(serialize(message));
        }
    });
}

function sendFullPage(ws, boardId, requestedPageId, requestId) {
    const board = useBoard(boardId);
    assert(board);
    const pageId = existingPage(requestedPageId, board);
    
    ws.boardId = boardId;
    ws.pageId = pageId;
    
    const page = usePage(pageId);

    const pageHistory = page.history;
    const pagePresent = page.present;
    const pageHash = page.hashes[pagePresent];
    const pageNr = board.pageOrder.indexOf(pageId) + 1;
    const totalPages = board.pageOrder.length;
    
    const message = {
        type: MESSAGES.SERVER_TO_CLIENT.FULL_PAGE.TYPE,
        [MESSAGES.SERVER_TO_CLIENT.FULL_PAGE.UUID]: pageId,
        [MESSAGES.SERVER_TO_CLIENT.FULL_PAGE.HISTORY]: pageHistory,
        [MESSAGES.SERVER_TO_CLIENT.FULL_PAGE.PRESENT]: pagePresent,
        [MESSAGES.SERVER_TO_CLIENT.FULL_PAGE.HASH]: pageHash,
        [MESSAGES.SERVER_TO_CLIENT.FULL_PAGE.PAGE_NR]: pageNr,
        [MESSAGES.SERVER_TO_CLIENT.FULL_PAGE.TOTAL_PAGES]: totalPages
    };

    releasePage(pageId);
    releaseBoard(boardId);
    ws.send(serialize(message));
    logSentMessage(message.type, message, requestId);
}

function sendPing() {
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN && client.boardId && client.pageId) {
            const board = useBoard(client.boardId);
            assert(board);
            const pageId = existingPage(client.pageId, board);
            client.pageId = pageId;
            const page = usePage(pageId);
            assert(page);
            assert(board.pageOrder.includes(pageId));

            const pageNr = board.pageOrder.indexOf(pageId) + 1;
            const totalPages = board.pageOrder.length;
            const pageHash = page.hashes[page.present];

            const snapshot_indices = recent_snapshots( page.history.length );
            const snapshots = snapshot_indices.map( index => page.hashes[ index ] );

            const message = {
                type: MESSAGES.SERVER_TO_CLIENT.PING.TYPE,
                [MESSAGES.SERVER_TO_CLIENT.PING.UUID]: pageId,
                [MESSAGES.SERVER_TO_CLIENT.PING.HASH]: pageHash,
                [MESSAGES.SERVER_TO_CLIENT.PING.PAGE_NR]: pageNr,
                [MESSAGES.SERVER_TO_CLIENT.PING.TOTAL_PAGES]: totalPages,
                [MESSAGES.SERVER_TO_CLIENT.PING.SNAPSHOTS]: snapshots
            };
            releasePage(pageId);
            releaseBoard(client.boardId);

            client.send(serialize(message));
            logSentMessage(message.type, message, 'N/A');
        }
    });
}


// Message handlers
const messageHandlers = {};


function createNewBoard(ws, clientId, requestId) {
    const boardId = generateUuid();
    const board = createBoard(boardId);
    if (board) {
        ws.boardId = boardId; // Store boardId in WebSocket client
        ws.clientId = clientId; // Store client ID for tracking
        ws.pageId = board.pageOrder[0]; // Default to first page
        
        if (clientId) {
            clients[clientId] = ws;
        }
        
        debug.log(`[SERVER] Client ${clientId} registered with board: ${boardId}`);
        
        const creationResponse = {
            type: MESSAGES.SERVER_TO_CLIENT.BOARD_CREATED.TYPE,
            [MESSAGES.SERVER_TO_CLIENT.BOARD_CREATED.BOARD_ID]: boardId,
            [MESSAGES.SERVER_TO_CLIENT.BOARD_CREATED.PASSWORD]: board.passwd,
            [MESSAGES.SERVER_TO_CLIENT.BOARD_CREATED.FIRST_PAGE_ID]: ws.pageId,
            [MESSAGES.SERVER_TO_CLIENT.BOARD_CREATED.REQUEST_ID]: requestId
        };
        ws.send(serialize(creationResponse));
        logSentMessage( MESSAGES.SERVER_TO_CLIENT.BOARD_CREATED.TYPE, creationResponse, requestId );
        releaseBoard(boardId);
        sendFullPage(ws, boardId, ws.pageId, requestId);
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
        
        const registrationResponse = {
            type: MESSAGES.SERVER_TO_CLIENT.BOARD_REGISTERED.TYPE,
            [MESSAGES.SERVER_TO_CLIENT.BOARD_REGISTERED.BOARD_ID]: boardId,
            [MESSAGES.SERVER_TO_CLIENT.BOARD_REGISTERED.FIRST_PAGE_ID]: ws.pageId,
            [MESSAGES.SERVER_TO_CLIENT.BOARD_REGISTERED.TOTAL_PAGES]: board.pageOrder.length,
            [MESSAGES.SERVER_TO_CLIENT.BOARD_REGISTERED.REQUEST_ID]: requestId
        };
        ws.send(serialize(registrationResponse));
        releaseBoard(boardId);
        sendFullPage(ws, boardId, ws.pageId, requestId);
    }
}

// Handler for board registration
messageHandlers[MESSAGES.CLIENT_TO_SERVER.REGISTER_BOARD.TYPE] = (ws, data, requestId) => {
    const clientId = data[MESSAGES.CLIENT_TO_SERVER.REGISTER_BOARD.CLIENT_ID];
    let boardId = data[MESSAGES.CLIENT_TO_SERVER.REGISTER_BOARD.BOARD_ID];
    if (boardId) {
        registerBoard(ws, boardId, clientId, requestId);
    }
};

// Handler for board creation
messageHandlers[MESSAGES.CLIENT_TO_SERVER.CREATE_BOARD.TYPE] = (ws, data, requestId) => {
    const clientId = data[MESSAGES.CLIENT_TO_SERVER.CREATE_BOARD.CLIENT_ID];
    let password = data[MESSAGES.CLIENT_TO_SERVER.CREATE_BOARD.PASSWORD];
    if (!credentials.includes(sha256(password))) {
        debug.log(`[SERVER] Client ${clientId} has tried to create a board: passwd = ${password}, sha256 = ${sha256(password)}`);
        return;
    }
    debug.log(`[SERVER] Client ${clientId} is allowed to create boards`);
    createNewBoard(ws, clientId, requestId);
};

messageHandlers[MESSAGES.CLIENT_TO_SERVER.FULL_PAGE_REQUESTS.TYPE] = (ws, data, requestId) => {
    const boardId = data.boardId || ws.boardId;
    const board = useBoard(boardId);
    assert(board);

    let pageId;
    if (data[MESSAGES.CLIENT_TO_SERVER.FULL_PAGE_REQUESTS.PAGE_NUMBER]) {
        const pageNumber = data[MESSAGES.CLIENT_TO_SERVER.FULL_PAGE_REQUESTS.PAGE_NUMBER];
        if (pageNumber < 1 || pageNumber > board.pageOrder.length) {
            throw new Error(`Invalid page number: ${pageNumber}`);
        }
        pageId = board.pageOrder[pageNumber - 1];
    } else if (data[MESSAGES.CLIENT_TO_SERVER.FULL_PAGE_REQUESTS.PAGE_ID] && 
               data[MESSAGES.CLIENT_TO_SERVER.FULL_PAGE_REQUESTS.DELTA] !== undefined) {
        pageId = existingPage(data[MESSAGES.CLIENT_TO_SERVER.FULL_PAGE_REQUESTS.PAGE_ID], board);
        const index = board.pageOrder.indexOf(pageId);
        if (index === -1) {
            throw new Error(`Page not found in board: ${pageId}`);
        }
        
        const delta = data[MESSAGES.CLIENT_TO_SERVER.FULL_PAGE_REQUESTS.DELTA];
        let newIndex = index + delta;
        if ( newIndex < 0 ) { newIndex = 0; }
        if ( newIndex >= board.pageOrder.length ) { newIndex = board.pageOrder.length - 1; }
        pageId = board.pageOrder[newIndex];
    }
    
    if (!pageId) {
        throw new Error('No valid page ID could be determined from request');
    }
    
    ws.pageId = pageId;
    sendFullPage(ws, boardId, pageId, requestId);
};

function handleEditAction(page, action) {
    const current_visible = compileVisualState( page.history.slice( 0, page.present ) ).visible;
    // const rhs = serialize( page.state.visible );
    // const lhs = serialize( current_visible );
    // if ( lhs != rhs ) {
    //     debug.log("visible set BAD",`time = ${page.present}, actual = ${lhs} vs predicted = ${rhs}`);
    //     process.exit( 1 );
    // } else {
    //     debug.log("visible set OK","!");
    // }
    page.state.visible = current_visible;
    if ( commitEdit( page.state, action ) ) {
        const future_size = page.history.length - page.present;
        page.history.splice(page.present, future_size);
        page.history.push(action);
        page.hashes.splice(page.present + 1, future_size);
        page.hashes.push(hashNext(page.hashes[page.present], action));
        page.present = page.history.length;
        return true;
    }
    return false;
}

function handleUndoAction(page, action) {
    if (page.present > 0) {
        const currentAction = page.history[page.present - 1];
        if (currentAction[MOD_ACTIONS.UUID] === action[MOD_ACTIONS.UNDO.TARGET_ACTION]) {
            page.present -= 1;
            return true;
        }
    }
    return false;
}

function handleRedoAction(page, action) {
    if (page.present < page.history.length) {
        const nextAction = page.history[page.present];
        if (nextAction[MOD_ACTIONS.UUID] === action[MOD_ACTIONS.REDO.TARGET_ACTION]) {
            page.present += 1;
            return true;
        }
    }
    return false;
}

function createDeclineMessage(boardId, pageId, targetActionId, reason = "") {
    return {
        type: MESSAGES.SERVER_TO_CLIENT.DECLINE.TYPE,
        boardId: boardId,
        [MESSAGES.SERVER_TO_CLIENT.DECLINE.UUID]: pageId,
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
    logSentMessage(declineMessage.type, declineMessage, requestId);
}

// Handler for modification actions
messageHandlers[MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.TYPE] = (ws, data, requestId) => {
    try {
        const boardId = data.boardId || ws.boardId;
        const password = data[MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.PASSWORD];
        const pageUuid = data[MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.PAGE_UUID];
        const action = data[MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.PAYLOAD];
        const beforeHash = data[MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.BEFORE_HASH];
        const clientId = ws.clientId;
        const actionId = action[MOD_ACTIONS.UUID];

        const board = useBoard(boardId);
        // debug.log(`password = ${password},  board.passwd = ${board.passwd}`);
        if ( !password || password != board.passwd ) {
            const declineMessage = createDeclineMessage(boardId, pageUuid, actionId, "unauthorized");
            ws.send(serialize(declineMessage));
            logSentMessage(declineMessage.type, declineMessage, requestId);
            releaseBoard(boardId);
            return;
        }

        const page = usePage(pageUuid);
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
            const newPageId = generateUuid();
            const newPage = createPage(newPageId);
            releasePage(newPageId);
            board.pageOrder.splice(board.pageOrder.indexOf(pageUuid) + 1, 0, newPageId);
            releaseBoard(boardId);
            sendFullPage(ws, boardId, newPageId, requestId);
            return;
        case MOD_ACTIONS.DELETE_PAGE.TYPE:
            releasePage(pageUuid);
            if (board.pageOrder.length > 1) {
                const index = board.pageOrder.indexOf(pageUuid);
                board.pageOrder.splice(index, 1);
                const newPageId = board.pageOrder[Math.min(index, board.pageOrder.length - 1)];
                releaseBoard(boardId);
                sendFullPage(ws, boardId, newPageId, requestId);
                return;
            }
            releaseBoard(boardId);
            accept = false;
            reason = "cannot delete last page of a board";
            break;
        default:
            accept = false;
            reason = "unknown action type";
        }
        
        if (accept) {
            const acceptMessage = {
                type: MESSAGES.SERVER_TO_CLIENT.ACCEPT.TYPE,
                [MESSAGES.SERVER_TO_CLIENT.ACCEPT.UUID]: pageUuid,
                [MESSAGES.SERVER_TO_CLIENT.ACCEPT.ACTION_UUID]: actionId,
                [MESSAGES.SERVER_TO_CLIENT.ACCEPT.BEFORE_HASH]: beforeHash,
                [MESSAGES.SERVER_TO_CLIENT.ACCEPT.AFTER_HASH]: page.hashes[page.present],
                [MESSAGES.SERVER_TO_CLIENT.ACCEPT.CURRENT_PAGE_NR]: board.pageOrder.indexOf(pageUuid) + 1,
                [MESSAGES.SERVER_TO_CLIENT.ACCEPT.CURRENT_TOTAL_PAGES]: board.pageOrder.length
            };
            ws.send(serialize(acceptMessage));
            logSentMessage(acceptMessage.type, acceptMessage, requestId);
            
            // Broadcast to other clients
            broadcastMessageToBoard(acceptMessage, boardId, ws);
        } else {
            const declineMessage = createDeclineMessage(boardId, pageUuid, actionId, reason);
            ws.send(serialize(declineMessage));
            logSentMessage(declineMessage.type, declineMessage, requestId);
        }
        
        releaseBoard(boardId);
        releasePage(pageUuid);
        
    } catch (error) {
        console.error(`[SERVER] Error processing mod action: ${error.message}`, error);
        // Send a decline message with the error
        if (ws && data) {
            const errorContext = {
                boardId: data.boardId || ws.boardId,
                pageUuid: data[MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.PAGE_UUID],
                actionUuid: data[MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.PAYLOAD]?.[MOD_ACTIONS.UUID],
                ws
            };
            sendDeclineMessage(errorContext, `Server error: ${error.message}`, requestId);
        }
    }
};

messageHandlers[MESSAGES.CLIENT_TO_SERVER.REPLAY_REQUESTS.TYPE] = (ws, data, requestId) => {
    const boardId = data.boardId || ws.boardId;
    const pageUuid = data[MESSAGES.CLIENT_TO_SERVER.REPLAY_REQUESTS.PAGE_UUID];
    const present = data[MESSAGES.CLIENT_TO_SERVER.REPLAY_REQUESTS.PRESENT];
    const presentHash = data[MESSAGES.CLIENT_TO_SERVER.REPLAY_REQUESTS.PRESENT_HASH];
    
    const board = useBoard(boardId);
    const pageId = existingPage(pageUuid, board);
    if (pageId !== pageUuid) {
        debug.log(`[SERVER] Hash ${pageUuid} has been replaced, sending full page`);
        sendFullPage(ws, boardId, pageId, requestId);
        releaseBoard(boardId);
        return;
    }
    
    const page = usePage(pageId);
    if (page.hashes[present] !== presentHash) {
        debug.log(`[SERVER] Hash ${pageId} changed at time ${present}, sending full page`);
        sendFullPage(ws, boardId, pageId, requestId);
        releaseBoard(boardId);
        releasePage(pageId);
        return;
    }

    const replayActions = [];
    for (let time = present; time < page.history.length; ++time) {
        replayActions.push(page.history[time]);
    }
    const replayMessage = {
        type: MESSAGES.SERVER_TO_CLIENT.REPLAY.TYPE,
        boardId: boardId,
        [MESSAGES.SERVER_TO_CLIENT.REPLAY.UUID]: pageUuid,
        [MESSAGES.SERVER_TO_CLIENT.REPLAY.BEFORE_HASH]: presentHash,
        [MESSAGES.SERVER_TO_CLIENT.REPLAY.AFTER_HASH]: page.hashes[page.present],
        [MESSAGES.SERVER_TO_CLIENT.REPLAY.SEQUENCE]: replayActions,
        [MESSAGES.SERVER_TO_CLIENT.REPLAY.PRESENT]: page.present,
        [MESSAGES.SERVER_TO_CLIENT.REPLAY.CURRENT_HASH]: page.hashes[page.present],
        [MESSAGES.SERVER_TO_CLIENT.REPLAY.PAGE_NR]: board.pageOrder.indexOf(pageId) + 1,
        [MESSAGES.SERVER_TO_CLIENT.REPLAY.TOTAL_PAGES]: board.pageOrder.length
    };

    releasePage(pageId);
    releaseBoard(boardId);
    ws.send(serialize(replayMessage));
    logSentMessage(replayMessage.type, replayMessage, requestId);
};

function routeMessage(ws, message) {
    try {
        const data = deserialize(message);
        const requestId = data.requestId || data['action-uuid'] || 'N/A';
        
        // Extract boardId from message or use stored one
        const boardId = data.boardId || ws.boardId;
        
        // If the message includes a boardId, update the WebSocket client
        if (data.boardId && data.boardId !== ws.boardId) {
            ws.boardId = data.boardId;
        }
        
        debug.log(`[CLIENT > SERVER] Received message of type '${data.type}' with requestId '${requestId}' from client ${ws.clientId} on board '${boardId}':`, serialize( data ) );
        
        const handler = messageHandlers[data.type];
        if (handler) {
            handler(ws, data, requestId);
        } else {
            throw new Error(`Unhandled message type: ${data.type}`);
        }
    } catch (e) {
        console.error('[SERVER] Error processing message:', e);
        // Send an error message to the client if possible
        if (ws && ws.readyState === WebSocket.OPEN) {
            const errorMessage = {
                type: "error",
                message: e.message,
                stack: e.stack
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
  server.close(() => {
    debug.log('Server connections closed. Exiting process.');
    process.exit(0);
  });
}

// Listen for the SIGTERM signal
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
