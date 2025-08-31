const WebSocket = require('ws');
const fs = require('fs');
const http = require('http');
const path = require('path');
const url = require('url');
const assert = require('assert');

// sha256
const crypto = require('crypto');

function sha256 (inputString ) {
  return crypto.createHash( 'sha256' ).update( inputString ).digest( 'hex' );
}


const { hashAny, hashNext, generateUuid, serialize, deserialize,
        createEmptyVisualState, applyModAction, applyActionSequence, compileVisualState , 
        MESSAGES, MOD_ACTIONS, STROKE, POINT } = require('./shared');

// Data storage configuration
const DATA_DIR = './data';

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    console.log(`[SERVER] Created data directory: ${DATA_DIR}`);
}

// Path helpers
const getPasswdFilePath = () => path.join(DATA_DIR, 'passwd.json');
const getRemovalLogPath = () => path.join(DATA_DIR, 'to_be_removed.json');
const getFilePath = (uuid,ext) => path.join(DATA_DIR, `${uuid}.${ext}`);

// Server state structures
const credentials = [];
const deletionMap = {};
const clients = {}; // Map client IDs to WebSocket instances
const pingInterval = 5000;
let pingTimer;

function initializeGlobals () {
    const filePath = getPasswdFilePath();
    if ( fs.existsSync( filePath ) ) {
        const itemText = fs.readFileSync( filePath, 'utf8' );
        const parsed = JSON.parse( itemText );
        Object.assign( credentials, parsed );
        console.log(`[SERVER] Loaded ${credentials.length} passwords`);
    }
    const removalLogPath = getRemovalLogPath();
    if ( fs.existsSync( removalLogPath ) ) {
        const itemText = fs.readFileSync( removalLogPath, 'utf8' );
        const parsedMap = JSON.parse( itemText );
        Object.assign( deletionMap, parsedMap );
        console.log(`[SERVER] Loaded ${Object.keys(deletionMap).length} deletion mappings`);
    }
}

function persistDeletionMap () {
    const removalLogPath = getRemovalLogPath();
    fs.writeFileSync( removalLogPath, JSON.stringify( deletionMap, null, 2 ), 'utf8' );
}

initializeGlobals();


// helper functions for persistent storage and caching
// ===================================================

function loadItem ( itemId, ext ) {
    const filePath = getFilePath( itemId, ext );
    if ( fs.existsSync( filePath ) ) {
        const fileText = fs.readFileSync( filePath, 'utf8' );
        if ( fileText ) {
            const item = deserialize( fileText );
            if ( item ) { return item; }
        }
    }
    console.log(`[SERVER] Error loading ${ext} from disk: ${itemId}`);
    return null;
}

function saveItem ( itemId, item, ext ) {
    const filePath = getFilePath( itemId, ext );
    const fileText = serialize( item );
    fs.writeFileSync( filePath, fileText, 'utf8' );
}


const loadBoard = ( boardId ) => loadItem( boardId, 'board' );
const loadPage = ( pageId ) => loadItem( pageId, 'page' );
const saveBoard = ( boardId, board ) => saveItem( boardId, board, 'board' );
const savePage = ( pageId, page ) => saveItem( pageId, page, 'page' );


function createBoard ( boardId ) {
    console.log(`[SERVER] Create a standard board.`);
    const pageId = generateUuid();
    const board = {
        pageOrder: [ pageId ]
    };
    saveBoard( boardId, board );
    return board;
}

function createPage ( pageId ) {
    console.log(`[SERVER] Create an empty page.`);
    const page = { 
        history: [], // array of edit-ops
        present: 0, // int
        state: { visible: Set() },
        hashes: [ hashAny( pageId ) ]
    };
    savePage( pageId, page );
    return ( page );
}

function loadOrCreateBoard ( boardId ) {
    let board = loadBoard( boardId );
    if ( board ) { return board; }
    return createBoard( boardId );
}

function loadOrCreatePage ( pageId ) {
    let page = loadPage( pageId );
    if ( page ) { return page; }
    return createPage( pageId );
}


// page cache
pageCache = new Map();
pageCacheMax = 10;
evictablePages = new Set();

function usePage( pageId ) {
    if ( ! pageCache.has( pageId ) ) {
        pageCache.set( pageId, loadOrCreatePage( pageId ) );
    }
    if ( evictablePages.has( pageId ) ) {
        evictablePages.delete( pageId );
    }
    return pageCache.get( pageId );
}

function persistPage( pageId ) {
    savePage( pageId, usePage( pageId ) );
}

function persistAllPages( pageId ) {
    for ( [ uuid, page ] of pageCache ) {
        savePage( uuid, page );
    }
}

function releasePage( pageId ) {
    if ( evictablePages.has( pageId ) ) {
        evictablePages.delete( pageId );
    }
    evictablePages.add( pageId )
    for ( const Id of structuralClone( evictablePages ) ) {
        if ( pageCache.size > pageCacheMax ) {
            persistPage( pageId );
            pageCache.delete( pageId );
        }
    }
}

// board cache
const boardCache = new Map();
const boardCacheMax = 10;
const evictableBoards = new Set();

function useBoard( boardId ) {
    if ( evictableBoards.has( boardId ) ) {
        evictableBoards.delete( boardId );
    }
    if ( boardCache.has( boardId ) {
        return boardCache.get( boardId );
    }
    board = loadBoard( boardId );
    if ( board ) {
        boardCache.set( boardId, board );
    }
    return board;
}

function persistBoard( boardId ) {
    saveBoard( boardId, useBoard( boardId ) );
}

function persistAllBoards() {
    for ( const [ uuid, board ] of boardCache ) {
        saveBoard( uuid, board );
    }
}

function releaseBoard( boardId ) {
    if ( evictableBoards.has( boardId ) ) {
        evictableBoards.delete( boardId );
    }
    evictableBoards.add( boardId )
    for ( const Id of [ ...evictableBoards ] ) {
        if ( boardCache.size > boardCacheMax ) {
            persistBoard( Id );
            boardCache.delete( Id );
            evictableBoards.delete( Id );
        }
    }
}


// page manipulation
// =================

function getPage ( boardId, pageId ) {
    const board = getBoard( boardId );
    assert( board.pageOrder.includes( pageId ) );
    return usePage( pageId );
}

function insertPage ( boardId, pageId, where ) {
    const board = getBoard( boardId );
    assert( 0 <= where && where <= board.pageOrder.length );
    assert( ! board.pageOrder.includes( pageId ) );
    board.pageOrder.splice( where, 0, pageId );
}


function existingPage ( pageId, board ) {
    if ( board.pageOrder.includes( pageId ) ) {
        return pageId;
    }
    
    let currentId = pageId;
    let replacementId = deletionMap[ currentId ];
    let N = 0;
    while ( replacementId ) {
        ++ N;
        currentId = replacementId;
        replacementId = deletionMap[ currentId ];
        // incomplete check and stupid heuristic check  against circularity
        assert( ! ( replacementId === pageId ) );
        assert( N < 100000 );
    }
    
    // Verify the final replacement actually exists
    if ( board.pageOrder.includes( currentId ) ) {
        return currentId;
    }
    
    // Fallback: if we still don't have a valid page, return the first page of the board
    assert( board.pageOrder.length > 0);
    return board.pageOrder[0];
}


// internet
// ========

const serverOptions = {
    key: fs.readFileSync( getFilePath( "server", "key" ) ),
    cert: fs.readFileSync( getFilePath( "server", "cert" ) )
};

const httpsServer = https.createServer(serverOptions);

const wss = new WebSocket.Server({
    server: httpsServer,
    path: '/ws',
    perMessageDeflate: {
        zlibDeflateOptions: { level: 6 },
        zlibInflateOptions: { chunkSize: 16 * 1024 },
        serverNoContextTakeover: false,
        clientNoContextTakeover: false,
        threshold: 512
    }
});

httpsServer.listen(3001, () => {
    console.log('WebSocket-Server läuft auf wss://localhost:3001/ws');
});


const httpServer = http.createServer( ( req, res ) => {
    // always serve just index.html
    // rationale: allowing the client to request files opens the attack surface
    // consequence: index.html will be a self contained file
    const filePath = path.join( __dirname, 'index.html' );
    const contentType = 'text/html';
    fs.readFile( filePath, ( err, data ) => {
        if ( err ) {
            if ( err.code === 'ENOENT' ) {
                res.writeHead( 404, { 'Content-Type': 'text/html' } );
                res.end( '<h1>404 Not Found</h1><p>The requested URL was not found on this server.</p>' );
            } else {
                res.writeHead( 500 );
                res.end( 'Sorry, check with the site admin for the error: ' + err.code + ' ..\n' );
            }
            return;
        }
        res.writeHead(200, { 'Content-Type': contentType });
        res.end(data);
    } );
} );


httpServer.listen( 8080, '0.0.0.0', () => {
    console.log('[SERVER] HTTP server is running on port 8080');
} );


function logSentMessage ( type, payload, requestId = 'N/A' ) {
    console.log( `[SERVER > CLIENT] Sending message of type '${type}' in response to '${requestId}' with payload:`, payload );
}

function broadcastMessageToBoard ( message, boardId, excludeWs = null ) {
    wss.clients.forEach( client => {
        if ( client.readyState === WebSocket.OPEN && client.boardId === boardId && client !== excludeWs ) {
            client.send( serialize( message ) );
        }
    });
}

function sendFullPage( ws, boardId, reqestedPageId, requestId ) {
    const board = useBoard( boardId );
    assert( board );
    const pageId = existingPage( requestedPageId, boardId );
    
    ws.boardId = boardId;
    ws.pageId = pageId;
    
    const page = usePage( pageId );

    const pageHistory = page.history;
    const pagePresent = page.present;
    const pageHash = page.hashes[ pagePresent ];
    const pageNr = board.pageOrder.indexOf( pageId ) + 1;
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

    releasePage( pageId );
    releaseBoard( boardId );
    ws.send( serialize(message) );
    logSentMessage( message.type, message, requestId );
}

function sendPing() {
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN && client.boardId && client.pageId) {
            const board = useBoard( client.boardId )
            assert( board );
            const pageId = existingPage( client.pageId, board );
            client.pageId = pageId;
            const page = usePage( pageId );
            assert( page );
            assert( board.pageOrder.includes( pageId ) );

            const pageNr = board.pageOrder.indexOf( pageId ) + 1;
            const totalPages = board.pageOrder.length;
            const pageHash = page.hashes[ pageNr ];

            const message = {
                type: MESSAGES.SERVER_TO_CLIENT.PING.TYPE,
                [MESSAGES.SERVER_TO_CLIENT.PING.UUID]: pageId,
                [MESSAGES.SERVER_TO_CLIENT.PING.HASH]: pageHash,
                [MESSAGES.SERVER_TO_CLIENT.PING.PAGE_NR]: pageNr,
                [MESSAGES.SERVER_TO_CLIENT.PING.TOTAL_PAGES]: totalPages
            };
            releasePage( pageId );
            releaseBoard( client.boardId );

            client.send( serialize (message) );
            logSentMessage(message.type, message, 'N/A');
        }
    });
}




// Message handlers
const messageHandlers = {};


function registerBoard ( ws, boardId, requestId ) {
    const board = useBoard( boardId );
    if ( board ) {
        ws.boardId = boardId; // Store boardId in WebSocket client
        ws.clientId = clientId; // Store client ID for tracking
        ws.pageId = board.pageOrder[0]; // Default to first page
        
        if (clientId) {
            clients[clientId] = ws;
        }
        
        console.log(`[SERVER] Client ${clientId} registered with board: ${boardId}`);
        
        const registrationResponse = {
            type: MESSAGES.SERVER_TO_CLIENT.BOARD_REGISTERED.TYPE,
            [MESSAGES.SERVER_TO_CLIENT.BOARD_REGISTERED.BOARD_ID]: boardId,
            [MESSAGES.SERVER_TO_CLIENT.BOARD_REGISTERED.FIRST_PAGE_ID]: ws.pageId,
            [MESSAGES.SERVER_TO_CLIENT.BOARD_REGISTERED.TOTAL_PAGES]: board.pageOrder.length,
            [MESSAGES.SERVER_TO_CLIENT.BOARD_REGISTERED.REQUEST_ID]: requestId
        };
        ws.send( serialize( registrationResponse ) );
        releaseBoard( boardId );
        sendFullPage( ws, boardId, ws.pageId, requestId );
    }
}

// Handler for board registration
messageHandlers[MESSAGES.CLIENT_TO_SERVER.REGISTER_BOARD.TYPE] = (ws, data, requestId) => {
    const clientId = data[MESSAGES.CLIENT_TO_SERVER.REGISTER_BOARD.CLIENT_ID];
    let boardId = data[MESSAGES.CLIENT_TO_SERVER.REGISTER_BOARD.BOARD_ID];
    if ( boardId ) {
        registerBoard( ws, boardId, reqestId );
    }
};

// Handler for board creation
messageHandlers[MESSAGES.CLIENT_TO_SERVER.CREATE_BOARD.TYPE] = (ws, data, requestId) => {
    const clientId = data[MESSAGES.CLIENT_TO_SERVER.REGISTER_BOARD.CLIENT_ID];
    let password = data[MESSAGES.CLIENT_TO_SERVER.REGISTER_BOARD.PASSWD];
    if ( ! credentials.includes( sha256( password ) ) ) {
        console.log(`[SERVER] Client ${clientId} has tried to create a board: passwd = ${password}, sha256 = ${sha256( password )}`);
        return;
    }
    console.log(`[SERVER] Client ${clientId} is allowed to create boards`);
    boardId = generateUuid();
    registerBoard( ws, boardId, reqestId );
};

messageHandlers[MESSAGES.CLIENT_TO_SERVER.FULL_PAGE_REQUESTS.TYPE] = (ws, data, requestId) => {
    const boardId = data.boardId || ws.boardId;
    const board = useBoard( boardId );
    assert( board );

    let pageId;
    if (data[MESSAGES.CLIENT_TO_SERVER.FULL_PAGE_REQUESTS.PAGE_NUMBER]) {
        const pageNumber = data[MESSAGES.CLIENT_TO_SERVER.FULL_PAGE_REQUESTS.PAGE_NUMBER];
        if (pageNumber < 1 || pageNumber > board.pageOrder.length) {
            throw new Error(`Invalid page number: ${pageNumber}`);
        }
        pageId = board.pageOrder[pageNumber - 1];
    } else if (data[MESSAGES.CLIENT_TO_SERVER.FULL_PAGE_REQUESTS.PAGE_ID] && 
               data[MESSAGES.CLIENT_TO_SERVER.FULL_PAGE_REQUESTS.DELTA] !== undefined) {
        pageId = existingPage(data[MESSAGES.CLIENT_TO_SERVER.FULL_PAGE_REQUESTS.PAGE_ID], boardId);
        const index = board.pageOrder.indexOf(pageId);
        if (index === -1) {
            throw new Error(`Page not found in board: ${pageId}`);
        }
        
        const delta = data[MESSAGES.CLIENT_TO_SERVER.FULL_PAGE_REQUESTS.DELTA];
        const newIndex = index + delta;
        if (newIndex < 0 || newIndex >= board.pageOrder.length) {
            throw new Error(`Invalid page navigation delta: ${delta}, current index: ${index}`);
        }
        
        pageId = board.pageOrder[ newIndex ];
    }
    
    if (!pageId) {
        throw new Error('No valid page ID could be determined from request');
    }
    
    ws.pageId = pageId;
    sendFullPage(ws, boardId, pageId, requestId);
};

function handleEditAction ( page, action ) {
    if ( commitEdit( page.state, action ) ) {
        future_size = page.history.length - page.present;
        page.history.splice( page.present, future_size );
        page.history.push( action );
        page.hashes.splice( page.present + 1, future_size );
        page.hashes.push( hashNext( page.hashes[ page.present ], action ) );
        page.present = page.history.length;
        return true;
    }
    return false;
}

function handleUndoAction ( page, action ) {
    if ( page.present > 0 ) {
        const currentAction = page.history[ page.present - 1 ];
        if ( currentAction[MOD_ACTIONS.UUID] == action[MOD_ACTIONS.UNDO.TARGET_ACTION] ) {
            page.present -= 1;
            return true;
        }
    }
    return false;
}

function handleRedoAction ( page, action ) {
    if ( page.present < page.history.length ) {
        const nextAction = page.history[ page.present ];
        if ( nextAction[MOD_ACTIONS.UUID] == action[MOD_ACTIONS.UNDO.TARGET_ACTION] ) {
            page.present += 1;
            return true;
        }
    }
    return false;
}

function createDeclineMessage ( boardId, pageId, targetActionId, reason = "") {
    return {
        type: MESSAGES.SERVER_TO_CLIENT.DECLINE_MESSAGE.TYPE,
        boardId: boardId,
        [MESSAGES.SERVER_TO_CLIENT.DECLINE_MESSAGE.UUID]: pageId,
        [MESSAGES.SERVER_TO_CLIENT.DECLINE_MESSAGE.ACTION_UUID]: targetActionId,
        [MESSAGES.SERVER_TO_CLIENT.DECLINE_MESSAGE.REASON]: reason
    };
}


// Handler for modification actions
messageHandlers[MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.TYPE] = (ws, data, requestId) => {
    try {
        const boardId = data.boardId || ws.boardId;
        const pageUuid = data[MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.PAGE_UUID];
        const action = data[MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.PAYLOAD];
        const beforeHash = data[MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.BEFORE_HASH];
        const clientId = ws.clientId;
        const actionId = action[MOD_ACTIONS.UUID];

        const board = useBoard( boardId );
        const page = usePage( pageUuid );
        let accept;
        let reason;
        const actionType = action.type;
        switch ( actionType ) {
        case MOD_ACTIONS.DRAW.TYPE:
            accept = handleEditAction( page, action );
            reason = "cannot apply action to current visual state";
            break;
        case MOD_ACTIONS.ERASE.TYPE:
            accept = handleEditAction( page, action );
            reason = "cannot apply action to current visual state";
            break;
        case MOD_ACTIONS.GROUP.TYPE:
            accept = handleEditAction( page, action );
            reason = "cannot apply action to current visual state";
            break;
        case MOD_ACTIONS.UNDO.TYPE:
            accept = handleUndoAction( page, action, 0, -1 );
            reason = "can only undo the immediate past";
            break;
        case MOD_ACTIONS.REDO.TYPE:
            accept = handleRedoAction( page, action, 1, 1 );
            reason = "can only redo the immediate future";
            break;
        case MOD_ACTIONS.NEW_PAGE.TYPE:
            releasePage( pageUuid );
            const newPageId = generateUuid();
            const newPage = usePage( newPageId );
            releasePage( newPage );
            board.pageOrder.splice( board.pageOrder.indexOf( pageUuid ) + 1, 0, newPageId );
            releaseBoard( boardId );
            sendFullPage( ws, boardId, newPageId, reqestId );
            return;
        case MOD_ACTIONS.DELETE_PAGE.TYPE:
            releasePage( pageUuid );
            if ( board.pageOrder.length > 1 ) {
                const index = board.pageOrder.indexOf( pageUuid );
                board.pageOrder.splice( index, 1 );
                const newPageId = board.pageOrder[ index ];
                releaseBoard( boardId );
                sendFullPage( ws, boardId, newPageId, reqestId );
                return;
            }
            releaseBoard( boardId );
            accept = false;
            reason = "cannnot delete last page of a board";
            break
        default:
            accept = false;
        }
        if ( accept ) {
        } else {
            const declineMessage = createDeclineMessage( boardId, pageUuid, actionId, reason );
            ws.send( serialize( declineMessage ) );
            logSentMessage( declineMessage.type, declineMessage, reqestId );
        }
        releaseBoard( boardId );
        releasePage( pageUuid );
    } catch (error) {
        console.error(`[SERVER] Error processing mod action: ${error.message}`, error);
        // Send a decline message with the error
        if (ws && data) {
            const errorContext = {
                boardId: data.boardId || ws.boardId,
                pageUuid: data[MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.PAGE_UUID],
                actionUuid: data[MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.ACTION_UUID],
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
    
    const board = useBoard( boardId );
    const pageId = existingPage( pageUuid, board );
    if ( pageId != pageUuid ) {
        console.log(`[SERVER] Hash ${pageUuid} has been replaced, sending full page`);
        sendFullPage(ws, boardId, pageId, requestId);
        releaseBoard( boardId );
        return;
    }
    
    const page = usePage( pageId );
    if ( page.hashes[ present ] != presentHash ) {
        console.log(`[SERVER] Hash ${pageId} changed at time ${present}, sending full page`);
        sendFullPage(ws, boardId, pageId, requestId);
        releaseBoard( boardId );
        releasePage( pageId );
        return;
    }

    const replayActions = [];
    for ( let time = present; present < page.present; ++ present ) {
        replayActions.push( page.history[ present ] );
    }
    const replayMessage = {
        type: MESSAGES.SERVER_TO_CLIENT.REPLAY_MESSAGE.TYPE,
        boardId: boardId,
        [MESSAGES.SERVER_TO_CLIENT.REPLAY_MESSAGE.PAGE_UUID]: pageUuid,
        [MESSAGES.SERVER_TO_CLIENT.REPLAY_MESSAGE.BEFORE_HASH]: presentHash,
        [MESSAGES.SERVER_TO_CLIENT.REPLAY_MESSAGE.AFTER_HASH]: page.hashes[ page.present ],
        [MESSAGES.SERVER_TO_CLIENT.REPLAY_MESSAGE.SEQUENCE]: replayActions,
        [MESSAGES.SERVER_TO_CLIENT.REPLAY_MESSAGE.CURRENT_PAGE_NR]: board.pageOrder.indexOf(pageId) + 1,
        [MESSAGES.SERVER_TO_CLIENT.REPLAY_MESSAGE.CURRENT_TOTAL_PAGES]: board.pageOrder.length
    };

    releassePage( pageId );
    releaseBoard( boardId );
    ws.send( serialize( replayMessage ) );
    logSentMessage(replayMessage.type, replayMessage, requestId);
};

function routeMessage(ws, message) {
    try {
        const data = JSON.parse(message);
        const requestId = data.requestId || data['action-uuid'] || 'N/A';
        
        // Extract boardId from message or use stored one
        const boardId = data.boardId || ws.boardId;
        
        // If the message includes a boardId, update the WebSocket client
        if (data.boardId && data.boardId !== ws.boardId) {
            ws.boardId = data.boardId;
        }
        
        console.log(`[CLIENT > SERVER] Received message of type '${data.type}' with requestId '${requestId}' from client on board '${boardId}':`, data);
        
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
            ws.send(JSON.stringify(errorMessage));
        }
    }
}

wss.on('connection', (ws, req) => {
    console.log(`[SERVER] New WebSocket connection established`);
    
    if (!pingTimer) {
        pingTimer = setInterval(() => {
            sendPing();
        }, pingInterval);
    }

    ws.on('message', message => routeMessage(ws, message));
    
    ws.on('close', () => {
        console.log(`[SERVER] Client disconnected from board: ${ws.boardId || 'unknown'}`);
        
        // Clean up client reference if client ID was stored
        if (ws.clientId && clients[ws.clientId] === ws) {
            delete clients[ws.clientId];
        }
    });
});

process.on('SIGINT', () => {
    console.log('[SERVER] Shutting down gracefully...');
    // Make sure all data is persisted before exit
    saveBoardMetadata();
    process.exit(0);
});
