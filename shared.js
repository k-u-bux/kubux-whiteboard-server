// PORT

const PORT=5236;
// const PORT=80;


// spaced snapshots

function power_of_two ( n ) {
  let result = 1;
  while (n > 0 && (n & 1) === 0) {
    n /= 2;
    result *= 2;
  }
  return result;
}

function recent_snapshots ( n ) {
  if ( n <= 0 ) { return []; }
  if ( n == 1 ) { return [ 0 ]; }
  n = n - 1;
  let result = [];
  let powers = [];
  for (let j = 1; j < n; j *= 2) {
    powers.push( j );
  }
  while ( powers.length > 0 ) {
    let next = n - powers[ 0 ];
    let m = power_of_two( n );
    const where = powers.indexOf( m );
    if ( where !== -1 ) {
      result.push( n );
      powers.splice( where, 1 );
    }
    n = next;
  }
  result.push( 0 );
  return result.reverse();
}


// uuid
const NULL_UUID = '00000000-0000-4000-8000-000000000000';

function generateUuid() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
        const r = Math.random() * 16 | 0;
        const v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

function isUuid(str) {
  const regex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return regex.test(str);
}

// serialization / deserialization
const serialize = (data) => {
    const replacer = (key, value) => {
        if (typeof value === 'bigint') {
            return { __type: 'BigInt', value: value.toString() };
        }
        if (value instanceof Set) {
            return { __type: 'Set', value: [...value] };
        }
        if (value instanceof Map) {
            return { __type: 'Map', value: Array.from(value.entries()) };
        }
        return value;
    };
    return JSON.stringify(data, replacer, 2);
};

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


// hash stringify-ables
//
// 128 bit from four 32-bit lanes (the cyrb128 construction). Each character
// costs a few Math.imul on small integers, with no allocation, where BigInt
// arithmetic allocated per character. Math.imul, ^ and >>> are exactly
// specified, so browser and Node produce identical hashes. Not cryptographic:
// the hashes only detect diverging copies of a page, the server is authoritative.
//
// Changing this function invalidates every stored hash chain; the server
// detects that on load and rebuilds them (see "Hash chain provenance").
function hashAny(data) {
    const dataString = serialize( data );
    let h1 = 1779033703, h2 = 3144134277, h3 = 1013904242, h4 = 2773480762;
    for (let i = 0; i < dataString.length; i++) {
        const k = dataString.charCodeAt(i);
        h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
        h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
        h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
        h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
    }
    h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
    h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
    h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
    h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
    h1 ^= (h2 ^ h3 ^ h4);
    h2 ^= h1;
    h3 ^= h1;
    h4 ^= h1;
    return [h1, h2, h3, h4].map(h => (h >>> 0).toString(16).padStart(8, '0')).join(''); // 32 hex digits
}

// chain hashing
function hashNext(previousHash, newData) {
    const combinedData = [previousHash, newData];
    return hashAny(combinedData);
}


// value equality
function isEqual(obj1, obj2) {
    // Same reference or primitive equality
    if (obj1 === obj2) return true;
    
    // If either is null or not an object, they can't be equal
    if (obj1 === null || obj2 === null || 
        typeof obj1 !== 'object' || typeof obj2 !== 'object') {
        return false;
    }
    
    // Special case: Date objects
    if (obj1 instanceof Date && obj2 instanceof Date) {
        return obj1.getTime() === obj2.getTime();
    }
    
    // Special case: RegExp objects
    if (obj1 instanceof RegExp && obj2 instanceof RegExp) {
        return obj1.toString() === obj2.toString();
    }
    
    // Different constructor means different types
    if (obj1.constructor !== obj2.constructor) return false;
    
    // Arrays: check length and elements
    if (Array.isArray(obj1)) {
        if (obj1.length !== obj2.length) return false;
        return obj1.every((item, index) => isEqual(item, obj2[index]));
    }
    
    // Regular objects: check keys and values
    const keys1 = Object.keys(obj1);
    const keys2 = Object.keys(obj2);
    
    if (keys1.length !== keys2.length) return false;
    
    return keys1.every(key => 
        keys2.includes(key) && isEqual(obj1[key], obj2[key])
    );
}

// For negation, just use the ! operator with the function
function isNotEqual(obj1, obj2) {
    return !isEqual(obj1, obj2);
}


// Schemas
// =======

const MOD_ACTIONS = {
    UUID: 'uuid',
    TYPE: 'type',
    // edit ops (creating the time line)
    DRAW: {
        TYPE: 'draw',
        STROKE: 'stroke'
    },
    ERASE: {
        TYPE: 'erase',
        TARGET_ACTION: 'targetActionUuid'
    },
    GROUP: {
        TYPE: 'group',
        ACTIONS: 'actions' // array of _edit_ops_ !!!
    },
    // moving the present (can refer to edit ops)
    UNDO: {
        TYPE: 'undo',
        TARGET_ACTION: 'targetActionUuid'
    },
    REDO: {
        TYPE: 'redo',
        TARGET_ACTION: 'targetActionUuid'
    },
    // board ops
    NEW_PAGE: {
        TYPE: 'new page'
    },
    DELETE_PAGE: {
        TYPE: 'delete page'
    }
};

const MESSAGES = {
    CLIENT_TO_SERVER: {
        REGISTER_BOARD: {
            TYPE: 'register-board',
            BOARD: 'board-uuid',
            PAGE: 'page-uuid', // optional: the page the client returns to
            CLIENT_ID: 'clientId',
            REQUEST_ID: 'requestId'
        },
        BOARD_INFO_REQUEST: {
            TYPE: 'board-info-request',
            BOARD: 'board-uuid',
            REGISTER: 'register',
            REQUEST_ID: 'requestId'
        },
        REGISTER_PAGE: {
            TYPE: 'register-page',
            BOARD: 'board-uuid',
            PAGE: 'page-uuid',
            DELTA: 'delta',
            CLIENT_ID: 'clientId',
            REQUEST_ID: 'requestId'
        },
        PAGE_INFO_REQUEST: {
            TYPE: 'page-info-request',
            BOARD: 'board-uuid',
            PAGE: 'page-uuid',
            DELTA: 'delta',
            REGISTER: 'register',
            REQUEST_ID: 'requestId'
        },
        // Owner messages: each carries the owner's login and credential and is
        // checked on its own; the server keeps no login state.
        CHANGE_CREDENTIAL: {
            TYPE: 'change-credential',
            LOGIN: 'login',
            PASSWORD: 'passwd',         // the current credential
            NEW_PASSWORD: 'new-passwd',
            REQUEST_ID: 'requestId'
        },
        CREATE_BOARD: {
            TYPE: 'create-board',
            LOGIN: 'login',
            PASSWORD: 'passwd',
            PATH: 'path',
            CLIENT_ID: 'clientId',
            REQUEST_ID: 'requestId'
        },
        LIST_BOARDS: {
            TYPE: 'list-boards',
            LOGIN: 'login',
            PASSWORD: 'passwd',
            REQUEST_ID: 'requestId'
        },
        SET_PATH: {
            TYPE: 'set-path',
            LOGIN: 'login',
            PASSWORD: 'passwd',
            BOARD: 'board-uuid',
            PATH: 'path',
            REQUEST_ID: 'requestId'
        },
        RENAME_PREFIX: {
            TYPE: 'rename-prefix',
            LOGIN: 'login',
            PASSWORD: 'passwd',
            FROM: 'from', // a folder: every board below it moves
            TO: 'to',
            REQUEST_ID: 'requestId'
        },
        FULL_PAGE_REQUEST: {
            TYPE: 'fullPage-requests',
            BOARD: 'board-uuid',
            PAGE: 'page-uuid',
            DELTA: 'delta',
            REGISTER: 'register',
            REQUEST_ID: 'requestId'
        },
        SHUFFLE_PROPOSAL: {
            TYPE: 'shuffle-proposal',
            BOARD: 'board-uuid',
            PASSWORD: 'passwd',
            BEFORE: 'before',
            AFTER: 'after',
            REQUEST_ID: 'requestId'
        },
        MOD_ACTION_PROPOSALS: {
            TYPE: 'mod-action-proposals',
            PASSWORD: 'passwd',
            BOARD: 'board-uuid',
            PAGE: 'page-uuid',
            PAYLOAD: 'payload',
            BEFORE_HASH: 'before-hash'
        },
        REPLAY_REQUEST: {
            TYPE: 'replay-requests',
            BOARD: 'board-uuid',
            PAGE: 'page-uuid',
            PRESENT: 'present',
            PRESENT_HASH: 'present-hash',
            REGISTER: 'register',
            REQUEST_ID: 'requestId'
        }
    },
    SERVER_TO_CLIENT: {
        CREDENTIAL_CHANGED: {
            TYPE: 'credential-changed',
            REQUEST_ID: 'requestId'
        },
        BOARD_LIST: {
            TYPE: 'board-list',
            BOARDS: 'boards', // list of entries, sorted by path
            ENTRY_BOARD: 'board-uuid',
            ENTRY_PATH: 'path',
            ENTRY_PASSWORD: 'passwd',
            ENTRY_CREATED_AT: 'createdAt',
            REQUEST_ID: 'requestId'
        },
        BOARD_CREATED: {
            TYPE: 'board-created',
            BOARD: 'board-uuid',
            PASSWORD: 'passwd',
            FIRST_PAGE: 'first-page-uuid',
            REQUEST_ID: 'requestId'
        },
        BOARD_REGISTERED: {
            TYPE: 'board-registered',
            BOARD: 'board-uuid',
            FIRST_PAGE: 'first-page-uuid',
            LAST_PAGE: 'last-page-uuid',
            TOTAL_PAGES: 'totalPages',
            REQUEST_ID: 'requestId'
        },
        BOARD_INFO: {
            TYPE: 'board-info',
            BOARD: 'board-uuid',
            PAGES: 'pages',
            REQUEST_ID: 'requestId'
        },
        PAGE_REGISTERED: {
            TYPE: 'page-registered',
            PAGE: 'page-uuid',
            HASH: 'hash',
            SNAPSHOTS: 'snapshots',
            PAGE_NR: 'pageNr',
            TOTAL_PAGES: 'totalPages',
            REQUEST_ID: 'requestId'
        },
        PAGE_INFO: {
            TYPE: 'page-info',
            PAGE: 'page-uuid',
            HASH: 'hash',
            SNAPSHOTS: 'snapshots',
            PAGE_NR: 'pageNr',
            TOTAL_PAGES: 'totalPages',
            SWITCH: 'do-move',
            REQUEST_ID: 'requestId'
        },
        PAGE_LOST: {
            TYPE: 'page-lost',
            LOST: 'lost-uuid',
            PAGE: 'page-uuid',
            PAGE_NR: 'pageNr',
            TOTAL_PAGES: 'totalPages',
            SWITCH: 'do-move',
            REQUEST_ID: 'requestId'
        },
        FULL_PAGE: {
            TYPE: 'fullPage',
            PAGE: 'page-uuid',
            HISTORY: 'history',
            PRESENT: 'present',
            HASH: 'hash',
            PAGE_NR: 'pageNr',
            TOTAL_PAGES: 'totalPages',
            REQUEST_ID: 'requestId',
            SWITCH: 'do-move'
        },
        ACCEPT: {
            TYPE: 'accept',
            PAGE: 'page-uuid',
            ACTION_INDEX : 'action-index',
            ACTION_UUID: 'action-uuid',
            BEFORE_HASH: 'before-hash',
            AFTER_HASH: 'after-hash',
            PAGE_NR: 'pageNr',
            TOTAL_PAGES: 'totalPages'
        },
        DECLINE: {
            TYPE: 'decline',
            PAGE: 'page-uuid',
            ACTION_UUID: 'action-uuid',
            REASON: 'reason'
        },
        REPLAY: {
            TYPE: 'replay',
            PAGE: 'page-uuid',
            BEFORE_HASH: 'beforeHash',
            AFTER_HASH: 'afterHash',
            SEQUENCE: 'edits',
            PRESENT: 'present',
            CURRENT_HASH: 'currentHash',
            PAGE_NR: 'pageNr',
            TOTAL_PAGES: 'totalPages',
            REQUEST_ID: 'requestId',
            SWITCH: 'do-move'
        },
        PING: {
            TYPE: 'ping',
            PAGE: 'page-uuid',
            HASH: 'hash',
            PAGE_NR: 'pageNr',
            TOTAL_PAGES: 'totalPages',
            SNAPSHOTS: 'snapshots'
        }
    }
};

// Reasons in the server's 'error' message
const CREDENTIAL_NOT_ACCEPTED = 'credential not accepted';           // login or credential check failed
const CREDENTIAL_NOT_SAVED = 'credential could not be saved';        // the user file could not be written
const PATH_INVALID = 'invalid path';                                 // no name left after normalizing, or too long
const PATH_TAKEN = 'path taken';                                     // exists, or a board would lie inside another
const NOT_OWNER = 'not your board';                                  // unknown board, or owned by someone else
const NO_SUCH_BOARD = 'no such board';                               // register-board: the board does not exist
const NO_SUCH_FOLDER = 'no such folder';                             // no board lies below the folder to rename
const RENAME_BLOCKED = 'rename cannot be written safely';            // no write order keeps the disk consistent

// Board paths
// ===========
// A board's path names it for its owner, like a file path: segments separated by '/'.
// Folders are not stored: boards whose paths share a prefix appear in the same folder.
// Per owner, a path appears only once, and a path is either a board or a folder,
// never both (no board lies inside another board's path).

const MAX_PATH_LENGTH = 256;

// A path is taken as it is typed, never cleaned up: a path not in normal form is
// refused. Normal form: names separated by '/', no empty name (so no '//' and no '/'
// at either end), no name with a space at its start or end, at most MAX_PATH_LENGTH
// characters, no control characters.
const PATH_FORM = {
    EMPTY: 'empty',
    EMPTY_NAME: 'empty name',
    SPACE: 'space at the start or end of a name',
    TOO_LONG: 'too long',
    CONTROL: 'control character'
};

// Why the path is not in normal form (one of PATH_FORM), or null if it is
function pathFormProblem(path) {
    if (typeof path !== 'string' || path.length === 0) return PATH_FORM.EMPTY;
    if (path.length > MAX_PATH_LENGTH) return PATH_FORM.TOO_LONG;
    if (/[\u0000-\u001f\u007f]/.test(path)) return PATH_FORM.CONTROL;
    const names = path.split('/');
    if (names.some(name => name.length === 0)) return PATH_FORM.EMPTY_NAME;
    if (names.some(name => name.trim() !== name)) return PATH_FORM.SPACE;
    return null;
}

// The first violation of the path rules among one owner's paths, or null
function findPathConflict(paths) {
    const seen = new Set();
    for (const path of paths) {
        if (seen.has(path)) return `path ${path} appears twice`;
        seen.add(path);
    }
    for (const path of seen) {
        const segments = path.split('/');
        for (let i = 1; i < segments.length; i++) {
            const prefix = segments.slice(0, i).join('/');
            if (seen.has(prefix)) return `board ${path} lies inside board ${prefix}`;
        }
    }
    return null;
}

// The path rules for one owner's changes, as the server applies them before it
// changes anything, and as the client checks a path while it is typed. paths: the
// owner's board paths; the new path as given. Each gives the reason the server
// refuses the change with (PATH_INVALID, PATH_TAKEN, NO_SUCH_FOLDER), or none.

// A new board at path: the reason it is refused, or null
function newBoardProblem(paths, path) {
    if (pathFormProblem(path)) return PATH_INVALID;
    return findPathConflict([...paths, path]) ? PATH_TAKEN : null;
}

// The board at oldPath moved to path: the reason it is refused, or null
function boardMoveProblem(paths, oldPath, path) {
    if (pathFormProblem(path)) return PATH_INVALID;
    if (path === oldPath) return null;
    return findPathConflict([...paths.filter(other => other !== oldPath), path]) ? PATH_TAKEN : null;
}

// The folder from, with every board below it, moved to to:
// { moves: [[oldPath, newPath], ...] } (none if it stays where it is), or { problem }
function folderMove(paths, from, to) {
    if (pathFormProblem(from) || pathFormProblem(to)) return { problem: PATH_INVALID };
    const moves = paths.filter(path => path.startsWith(from + '/')).map(path => [path, to + path.slice(from.length)]);
    if (moves.length === 0) return { problem: NO_SUCH_FOLDER };
    if (from === to) return { moves: [] };
    // the new paths must be in normal form themselves (not too long)
    if (moves.some(([, newPath]) => pathFormProblem(newPath))) return { problem: PATH_INVALID };
    const moved = new Set(moves.map(([oldPath]) => oldPath));
    const others = paths.filter(path => !moved.has(path));
    if (findPathConflict([...others, ...moves.map(([, newPath]) => newPath)])) return { problem: PATH_TAKEN };
    return { moves };
}

const DRAWABLE = {
    TYPE: {
        STROKE: 'stroke',
        FILL: 'fill'
    },
    PATH: {
        OPEN_PIECEWISE_LINEAR: 'opl',
        CLOSED_PIECEWISE_LINEAR: 'cpl',
        OPEN_BEZIER_CURVE: 'obz',
        CLOSED_BEZIER_CURVE: 'cbz'
    }
};

const POINT = {
    X: 0,
    Y: 1,
    PRESSURE: 2,
    TIMESTAMP: 3
};

const ELEMENT = {
    TYPE: 0,         // DRAWABLE.TYPE
    PATH: 1,         // DRAWABLE.PATH
    POINTS: 2,       // Array of points
    COLOR: 3,        // Color string
    WIDTH: 4,        // Stroke width
    TRANSFORM: 5,    // Affine transformation (at the moment, always the identity)
    OPACITY: 6,      // Opacity (0-1)
    CAP_STYLE: 7,    // Cap style constant
    JOIN_STYLE: 8,   // Join style constant
    DASH_PATTERN: 9, // Dash pattern array
    SENSITIVITY: 10, // Pressure sensitivity
    LAYER: 11,       // Layer number
    PEN_TYPE: 12     // pen type (may influcence the visual representation) at the moment: PEN_TYPES.MARKER
};

const PEN_TYPES = {
    MARKER: 0,
    PENCIL: 1,
    HIGHLIGHTER: 2,
    BRUSH: 3
};

const CAP_STYLES = {
    ROUND: 0,
    BUTT: 1,
    SQUARE: 2
};

const JOIN_STYLES = {
    ROUND: 0,
    BEVEL: 1,
    MITER: 2
};

// Map numeric constants back to CSS string values
const PEN_TYPE_STRINGS = ["marker", "pencil", "highlighter", "brush"];
const CAP_STYLE_STRINGS = ["round", "butt", "square"];
const JOIN_STYLE_STRINGS = ["round", "bevel", "miter"];


// some validation routines
// ========================

// Maximum nesting depth for GROUP actions to prevent stack overflow
const MAX_GROUP_DEPTH = 10;

// The client offers layers 0..7
const LAYER_COUNT = 8;

// Longest dash pattern accepted (the client's longest has 4 entries)
const MAX_DASH_PATTERN_LENGTH = 16;

function is_finite_number(value) {
    return typeof value === 'number' && Number.isFinite(value);
}

function is_finite_number_list(list) {
    return Array.isArray(list) && list.every(is_finite_number);
}

// A stroke is the compact array indexed by ELEMENT. Every slot holds a number,
// a short string, or a list of numbers (points: a list of such lists), so the
// check walks a fixed depth, one pass over the points, and stops at the first
// slot of the wrong shape: arbitrarily nested input is rejected right there.
function is_invalid_stroke(stroke) {
    if (!Array.isArray(stroke) || stroke.length !== Object.keys(ELEMENT).length) return true;

    if (!Object.values(DRAWABLE.TYPE).includes(stroke[ELEMENT.TYPE])) return true;
    if (!Object.values(DRAWABLE.PATH).includes(stroke[ELEMENT.PATH])) return true;

    // points are [x, y, pressure] or [x, y, pressure, timestamp]; moving and
    // pasting drop the timestamp
    const points = stroke[ELEMENT.POINTS];
    if (!Array.isArray(points) || points.length === 0) return true;
    for (const point of points) {
        if (!is_finite_number_list(point) || point.length < 3 || point.length > 4) return true;
    }

    // the client only offers named swatches and #RRGGBB cells
    const color = stroke[ELEMENT.COLOR];
    if (typeof color !== 'string' || !/^(#[0-9a-fA-F]{3}|#[0-9a-fA-F]{6}|[a-z]{1,20})$/.test(color)) return true;

    const width = stroke[ELEMENT.WIDTH];
    if (!is_finite_number(width) || width <= 0) return true;

    const transform = stroke[ELEMENT.TRANSFORM];
    if (!is_finite_number_list(transform) || transform.length !== 6) return true;

    const opacity = stroke[ELEMENT.OPACITY];
    if (!is_finite_number(opacity) || opacity < 0 || opacity > 1) return true;

    if (!Object.values(CAP_STYLES).includes(stroke[ELEMENT.CAP_STYLE])) return true;
    if (!Object.values(JOIN_STYLES).includes(stroke[ELEMENT.JOIN_STYLE])) return true;

    const dashPattern = stroke[ELEMENT.DASH_PATTERN];
    if (!is_finite_number_list(dashPattern) || dashPattern.length > MAX_DASH_PATTERN_LENGTH) return true;
    if (dashPattern.some(length => length < 0)) return true;

    if (!is_finite_number(stroke[ELEMENT.SENSITIVITY])) return true;

    const layer = stroke[ELEMENT.LAYER];
    if (!Number.isInteger(layer) || layer < 0 || layer >= LAYER_COUNT) return true;

    if (!Object.values(PEN_TYPES).includes(stroke[ELEMENT.PEN_TYPE])) return true;

    return false;
}

// Helper for validating action payloads
// depth is used internally to limit GROUP nesting
function is_invalid_action_payload(action, depth = 0) {
    if (!action || typeof action !== 'object') return true;
    if (!action[MOD_ACTIONS.UUID] || typeof action[MOD_ACTIONS.UUID] !== 'string') return true;
    if (!action[MOD_ACTIONS.TYPE] || typeof action[MOD_ACTIONS.TYPE] !== 'string') return true;
    
    const validTypes = [
        MOD_ACTIONS.DRAW.TYPE,
        MOD_ACTIONS.ERASE.TYPE,
        MOD_ACTIONS.GROUP.TYPE,
        MOD_ACTIONS.UNDO.TYPE,
        MOD_ACTIONS.REDO.TYPE,
        MOD_ACTIONS.NEW_PAGE.TYPE,
        MOD_ACTIONS.DELETE_PAGE.TYPE
    ];
    
    if (!validTypes.includes(action[MOD_ACTIONS.TYPE])) return true;
    
    // Type-specific validation
    switch (action[MOD_ACTIONS.TYPE]) {
        case MOD_ACTIONS.DRAW.TYPE:
            if (is_invalid_stroke(action[MOD_ACTIONS.DRAW.STROKE])) return true;
            break;
        case MOD_ACTIONS.ERASE.TYPE:
            if (!action[MOD_ACTIONS.ERASE.TARGET_ACTION] || typeof action[MOD_ACTIONS.ERASE.TARGET_ACTION] !== 'string') return true;
            break;
        case MOD_ACTIONS.GROUP.TYPE:
            if (!Array.isArray(action[MOD_ACTIONS.GROUP.ACTIONS])) return true;
            // Prevent excessive nesting which could cause stack overflow
            if (depth >= MAX_GROUP_DEPTH) return true;
            // Sub-actions must be edit ops only (DRAW, ERASE, GROUP) — these are
            // the only types commitEdit handles. UNDO/REDO/NEW_PAGE/DELETE_PAGE
            // are not valid inside a GROUP and would hit assert(false) in commitEdit.
            const validSubTypes = [
                MOD_ACTIONS.DRAW.TYPE,
                MOD_ACTIONS.ERASE.TYPE,
                MOD_ACTIONS.GROUP.TYPE
            ];
            for (const subAction of action[MOD_ACTIONS.GROUP.ACTIONS]) {
                if (is_invalid_action_payload(subAction, depth + 1)) return true;
                if (!validSubTypes.includes(subAction[MOD_ACTIONS.TYPE])) return true;
            }
            break;
        case MOD_ACTIONS.UNDO.TYPE:
            if (!action[MOD_ACTIONS.UNDO.TARGET_ACTION] || typeof action[MOD_ACTIONS.UNDO.TARGET_ACTION] !== 'string') return true;
            break;
        case MOD_ACTIONS.REDO.TYPE:
            if (!action[MOD_ACTIONS.REDO.TARGET_ACTION] || typeof action[MOD_ACTIONS.REDO.TARGET_ACTION] !== 'string') return true;
            break;
    }
    
    return false;
}

function is_invalid_REGISTER_BOARD_message(data) {
    if (!data || typeof data !== 'object') return true;
    
    const boardId = data[MESSAGES.CLIENT_TO_SERVER.REGISTER_BOARD.BOARD];
    if (!boardId || !isUuid(boardId)) return true;
    
    const pageId = data[MESSAGES.CLIENT_TO_SERVER.REGISTER_BOARD.PAGE];
    if (pageId !== undefined && (typeof pageId !== 'string' || !isUuid(pageId))) return true;
    
    const clientId = data[MESSAGES.CLIENT_TO_SERVER.REGISTER_BOARD.CLIENT_ID];
    if (clientId !== undefined && (typeof clientId !== 'string' || !isUuid(clientId))) return true;
    
    return false;
}

function is_invalid_REGISTER_PAGE_message(data) {
    if (!data || typeof data !== 'object') return true;
    
    const boardId = data[MESSAGES.CLIENT_TO_SERVER.REGISTER_PAGE.BOARD];
    if (!boardId || !isUuid(boardId)) return true;
    
    const pageId = data[MESSAGES.CLIENT_TO_SERVER.REGISTER_PAGE.PAGE];
    if (!pageId || !isUuid(pageId)) return true;
    
    const delta = data[MESSAGES.CLIENT_TO_SERVER.REGISTER_PAGE.DELTA];
    if (delta !== undefined && (typeof delta !== 'number' || !Number.isInteger(delta))) return true;
    
    const clientId = data[MESSAGES.CLIENT_TO_SERVER.REGISTER_PAGE.CLIENT_ID];
    if (clientId !== undefined && (typeof clientId !== 'string' || !isUuid(clientId))) return true;
    
    return false;
}

function is_invalid_PAGE_INFO_REQUEST_message(data) {
    if (!data || typeof data !== 'object') return true;
    
    const boardId = data[MESSAGES.CLIENT_TO_SERVER.PAGE_INFO_REQUEST.BOARD];
    if (!boardId || !isUuid(boardId)) return true;
    
    const pageId = data[MESSAGES.CLIENT_TO_SERVER.PAGE_INFO_REQUEST.PAGE];
    if (!pageId || !isUuid(pageId)) return true;
    
    const requestId = data[MESSAGES.CLIENT_TO_SERVER.PAGE_INFO_REQUEST.REQUEST_ID];
    if (!requestId || !isUuid(requestId)) return true;
    
    const delta = data[MESSAGES.CLIENT_TO_SERVER.PAGE_INFO_REQUEST.DELTA];
    if (delta !== undefined && (typeof delta !== 'number' || !Number.isInteger(delta))) return true;
    
    const register = data[MESSAGES.CLIENT_TO_SERVER.PAGE_INFO_REQUEST.REGISTER];
    if (register !== undefined && typeof register !== 'boolean') return true;
    
    return false;
}

// Longest login and credential accepted
const MAX_LOGIN_LENGTH = 64;
const MAX_CREDENTIAL_LENGTH = 1024;

function is_invalid_login_text(text) {
    return !text || typeof text !== 'string' || text.length > MAX_LOGIN_LENGTH;
}

function is_invalid_credential_text(text) {
    return !text || typeof text !== 'string' || text.length > MAX_CREDENTIAL_LENGTH;
}

// Login, credential and request id of an owner message (keys from its MESSAGES entry)
function is_invalid_owner_fields(data, keys) {
    if (is_invalid_login_text(data[keys.LOGIN])) return true;
    if (is_invalid_credential_text(data[keys.PASSWORD])) return true;
    const requestId = data[keys.REQUEST_ID];
    return !requestId || !isUuid(requestId);
}

// A raw path from a client: checked for type and size only, so that the server can
// answer a path that normalizes to nothing with PATH_INVALID instead of dropping it.
function is_invalid_raw_path(raw) {
    return typeof raw !== 'string' || raw.length > 4 * MAX_PATH_LENGTH;
}

function is_invalid_CHANGE_CREDENTIAL_message(data) {
    if (!data || typeof data !== 'object') return true;

    if (is_invalid_owner_fields(data, MESSAGES.CLIENT_TO_SERVER.CHANGE_CREDENTIAL)) return true;
    if (is_invalid_credential_text(data[MESSAGES.CLIENT_TO_SERVER.CHANGE_CREDENTIAL.NEW_PASSWORD])) return true;

    return false;
}

function is_invalid_CREATE_BOARD_message(data) {
    if (!data || typeof data !== 'object') return true;
    
    if (is_invalid_owner_fields(data, MESSAGES.CLIENT_TO_SERVER.CREATE_BOARD)) return true;
    if (is_invalid_raw_path(data[MESSAGES.CLIENT_TO_SERVER.CREATE_BOARD.PATH])) return true;

    const clientId = data[MESSAGES.CLIENT_TO_SERVER.CREATE_BOARD.CLIENT_ID];
    if (clientId !== undefined && (typeof clientId !== 'string' || !isUuid(clientId))) return true;
    
    return false;
}

function is_invalid_LIST_BOARDS_message(data) {
    if (!data || typeof data !== 'object') return true;

    if (is_invalid_owner_fields(data, MESSAGES.CLIENT_TO_SERVER.LIST_BOARDS)) return true;

    return false;
}

function is_invalid_SET_PATH_message(data) {
    if (!data || typeof data !== 'object') return true;

    if (is_invalid_owner_fields(data, MESSAGES.CLIENT_TO_SERVER.SET_PATH)) return true;

    const boardId = data[MESSAGES.CLIENT_TO_SERVER.SET_PATH.BOARD];
    if (!boardId || !isUuid(boardId)) return true;

    if (is_invalid_raw_path(data[MESSAGES.CLIENT_TO_SERVER.SET_PATH.PATH])) return true;

    return false;
}

function is_invalid_RENAME_PREFIX_message(data) {
    if (!data || typeof data !== 'object') return true;

    if (is_invalid_owner_fields(data, MESSAGES.CLIENT_TO_SERVER.RENAME_PREFIX)) return true;
    if (is_invalid_raw_path(data[MESSAGES.CLIENT_TO_SERVER.RENAME_PREFIX.FROM])) return true;
    if (is_invalid_raw_path(data[MESSAGES.CLIENT_TO_SERVER.RENAME_PREFIX.TO])) return true;

    return false;
}

function is_invalid_FULL_PAGE_REQUEST_message(data) {
    if (!data || typeof data !== 'object') return true;
    
    // boardId can come from data or ws.boardId (checked in handler)
    const boardId = data[MESSAGES.CLIENT_TO_SERVER.FULL_PAGE_REQUEST.BOARD];
    if (!boardId || !isUuid(boardId)) return true;
    
    const pageId = data[MESSAGES.CLIENT_TO_SERVER.FULL_PAGE_REQUEST.PAGE];
    if (!pageId || !isUuid(pageId)) return true;
    
    const requestId = data[MESSAGES.CLIENT_TO_SERVER.FULL_PAGE_REQUEST.REQUEST_ID];
    if (!requestId || !isUuid(requestId)) return true;
    
    const delta = data[MESSAGES.CLIENT_TO_SERVER.FULL_PAGE_REQUEST.DELTA];
    if (delta === undefined || typeof delta !== 'number' || !Number.isInteger(delta)) return true;
    
    const register = data[MESSAGES.CLIENT_TO_SERVER.FULL_PAGE_REQUEST.REGISTER];
    if (register === undefined || typeof register !== 'boolean') return true;
    
    return false;
}

function is_invalid_MOD_ACTION_PROPOSALS_message(data) {
    if (!data || typeof data !== 'object') return true;
    
    const boardId = data[MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.BOARD];
    if (!boardId || !isUuid(boardId)) return true;
    
    const password = data[MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.PASSWORD];
    if (!password || typeof password !== 'string') return true;
    
    const pageUuid = data[MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.PAGE];
    if (!pageUuid || !isUuid(pageUuid)) return true;
    
    const action = data[MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.PAYLOAD];
    if (is_invalid_action_payload(action)) return true;
    
    const beforeHash = data[MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.BEFORE_HASH];
    if (beforeHash !== undefined && typeof beforeHash !== 'string') return true;
    
    return false;
}

function is_invalid_REPLAY_REQUEST_message(data) {
    if (!data || typeof data !== 'object') return true;
    
    // boardId can come from data or ws.boardId (checked in handler)
    const boardId =  data[MESSAGES.CLIENT_TO_SERVER.REPLAY_REQUEST.BOARD];
    if (!boardId || !isUuid(boardId)) return true;
    
    const pageUuid = data[MESSAGES.CLIENT_TO_SERVER.REPLAY_REQUEST.PAGE];
    if (!pageUuid || !isUuid(pageUuid)) return true;
    
    const requestId = data[MESSAGES.CLIENT_TO_SERVER.REPLAY_REQUEST.REQUEST_ID];
    if (!requestId || !isUuid(requestId)) return true;
    
    const present = data[MESSAGES.CLIENT_TO_SERVER.REPLAY_REQUEST.PRESENT];
    if (present === undefined || typeof present !== 'number' || !Number.isInteger(present) || present < 0) return true;
    
    const presentHash = data[MESSAGES.CLIENT_TO_SERVER.REPLAY_REQUEST.PRESENT_HASH];
    if (!presentHash || typeof presentHash !== 'string') return true;
    
    const register = data[MESSAGES.CLIENT_TO_SERVER.REPLAY_REQUEST.REGISTER];
    if (register === undefined || typeof register !== 'boolean') return true;
    
    return false;
}

function is_invalid_BOARD_INFO_REQUEST_message(data) {
    if (!data || typeof data !== 'object') return true;

    const boardId = data[MESSAGES.CLIENT_TO_SERVER.BOARD_INFO_REQUEST.BOARD];
    if (!boardId || !isUuid(boardId)) return true;

    const requestId = data[MESSAGES.CLIENT_TO_SERVER.BOARD_INFO_REQUEST.REQUEST_ID];
    if (!requestId || !isUuid(requestId)) return true;

    const register = data[MESSAGES.CLIENT_TO_SERVER.BOARD_INFO_REQUEST.REGISTER];
    if (register !== undefined && typeof register !== 'boolean') return true;

    return false;
}

function is_invalid_SHUFFLE_PROPOSAL_message(data) {
    if (!data || typeof data !== 'object') return true;

    const password = data[MESSAGES.CLIENT_TO_SERVER.SHUFFLE_PROPOSAL.PASSWORD];
    if (!password || typeof password !== 'string') return true;

    const boardId = data[MESSAGES.CLIENT_TO_SERVER.SHUFFLE_PROPOSAL.BOARD];
    if (!boardId || !isUuid(boardId)) return true;

    const requestId = data[MESSAGES.CLIENT_TO_SERVER.SHUFFLE_PROPOSAL.REQUEST_ID];
    if (!requestId || !isUuid(requestId)) return true;

    const before = data[MESSAGES.CLIENT_TO_SERVER.SHUFFLE_PROPOSAL.BEFORE];
    if (!Array.isArray(before) || before.length < 1) return true;
    if (!before.every(id => isUuid(id))) return true;

    const after = data[MESSAGES.CLIENT_TO_SERVER.SHUFFLE_PROPOSAL.AFTER];
    if (!Array.isArray(after) || after.length < 1) return true;
    if (!after.every(id => isUuid(id))) return true;

    return false;
}


// Affine transformations
// ======================
// [a, b, c, d, e, f]
// Represents the matrix:
// [a c e]
// [b d f]
// [0 0 1]

const TRANSFORM = {
    A: 0, // scale x
    B: 1, // skew y
    C: 2, // skew x
    D: 3, // scale y
    E: 4, // translate x
    F: 5  // translate y
};

// Create an identity transform
function createIdentityTransform () {
    return [1, 0, 0, 1, 0, 0];
}

// Apply transform to a point
function applyTransformToPoint ( transform, x, y ) {
    return {
        x: transform[TRANSFORM.A] * x + transform[TRANSFORM.C] * y + transform[TRANSFORM.E],
        y: transform[TRANSFORM.B] * x + transform[TRANSFORM.D] * y + transform[TRANSFORM.F]
    };
}

function compose ( t1, t2 ) {
    const { x: a, y: b } = applyTransformToPoint( t2, 0, 0 );
    const { x: c, y: d } = applyTransformToPoint( t2, 1, 0 );
    const { x: e, y: f } = applyTransformToPoint( t2, 0, 1 );
    const { x: A, y: B } = applyTransformToPoint( t1, a, b );
    const { x: C, y: D } = applyTransformToPoint( t1, c, d );
    const { x: E, y: F } = applyTransformToPoint( t1, e, f );
    return [
        C - A,
        D - B,
        E - A,
        F - B,
        A,
        B
    ]
}


// Default stroke styles (using compact array format)
const STROKE_STYLES = {
    CHALK: [
        "stroke",             // type
        "opl",                // path
        [],                   // points
        "#000000",            // color
        2.0,                  // width
        createIdentityTransform(), // transform
        1.0,                  // opacity
        CAP_STYLES.BUTT,     // capStyle
        JOIN_STYLES.ROUND,    // joinStyle
        [],                   // dashPattern
        0,                    // pressureSensitivity
        1,                    // layer
        PEN_TYPES.MARKER      // penType
    ],
    PEN: [
        "stroke",             // type
        "opl",                // path
        [],                   // points
        "#000000",            // color
        2.0,                  // width
        createIdentityTransform(), // transform
        1.0,                  // opacity
        CAP_STYLES.ROUND,      // capStyle
        JOIN_STYLES.BEVEL,    // joinStyle
        [5],                  // dashPattern
        1.0,                  // pressureSensitivity
        1,                    // layer
        PEN_TYPES.MARKER      // penType
    ],
    HIGHLIGHTER: [
        "stroke",             // type
        "opl",                // path
        [],                   // points
        "#000000",            // color
        24,                   // width
        createIdentityTransform(), // transform
        0.3,                  // opacity
        CAP_STYLES.SQUARE,    // capStyle
        JOIN_STYLES.ROUND,    // joinStyle
        [],                   // dashPattern
        0,                    // pressureSensitivity
        1,                    // layer
        PEN_TYPES.MARKER      // penType
    ]
};

function createStroke ( styleTemplate ) {
    return structuredClone( styleTemplate );
}

function createPoint ( x, y, pressure = 0.5, timestamp = Date.now() ) {
    return [ x, y, pressure, timestamp ];
    // return [ x, y, pressure ];
}

function addPointToStroke ( stroke, point ) {
    assert( Array.isArray( stroke[ELEMENT.POINTS] ) )
    stroke[ELEMENT.POINTS].push( point );
    return stroke;
}

function applyTransformToPath( transform, path ) {
    let result = [];
    for (const point of path) {
        let xy = applyTransformToPoint( transform, point[ POINT.X ], point[ POINT.Y ] );
        result.push( [ xy.x, xy.y, point[ POINT.PRESSURE ], point[ POINT.TIMESTAMP ] ] );
        // result.push( [ xy.x, xy.y, point[ POINT.PRESSURE ] ] );
    }
    return result;
}


function bbox ( path ) {
    if ( path.length > 0 ) {
        const P = path[0];
        let xmin = P[ POINT.X ];
        let xmax = xmin;
        let ymin = P[ POINT.Y ];
        let ymax = ymin;
        for ( const point of path ) {
            xmin = Math.min( xmin, point[ POINT.X ] );
            xmax = Math.max( xmax, point[ POINT.X ] );
            ymin = Math.min( ymin, point[ POINT.Y ] );
            ymax = Math.max( ymax, point[ POINT.Y ] );
        }
        return [ xmin, ymin, xmax, ymax ];
    } else {
        return [];
    }
}

// visual state and actions to state compiler
// ==========================================

const VISUAL_STATE = {
    ELEMENT: 'element', // map edit_uuid -> element
    VISIBLE: 'visible' // set of uuids of visible elements
};

function createEmptyVisualState () {
    return {
        element: new Map(),  // map uuid -> drawable
        visible: new Set()   // set of uuid
    };
}

function compileVisualState ( actions ) {
    let state = createEmptyVisualState();
    if ( commitGroup( state, actions ) ) {
        return state;
    }
    return null;
}


function getRenderableElements ( visualState ) {
    const result = [];
    for (const [uuid, element] of visualState.element) {
        if ( visualState.visible.has( uuid ) ) {
            result.push( element );
        }
    }
    return result;
}

function render_all_visible_elements ( visualState, render ) {
    for ( const [ uuid, element ] of visualState.element ) {
        if ( visualState.visible.has( uuid ) ) {
            render( element );
        }
    }
};


function applyTransform ( element, transform ) {
    let result = { ... element };
    result.transform = compose( transform, result[ ELEMENT.TRANSFORM ] );
    return Object.freeze( result );
}

function addElement ( visualState, uuid, element ) {
    // on the server side, the drawables do not exist
    if ( visualState.element ) {
        visualState.element.set( uuid, element );
    }
}

function showElement ( visualState, uuid ) {
    if ( visualState.visible.has( uuid ) ) {
        return false;
    }
    visualState.visible.add( uuid );
    return ( true );
}

function hideElement ( visualState, uuid ) {
    if ( ! visualState.visible.has( uuid ) ) {
        console.log("element not visible:", serialize( uuid ) );
        return false;
    }
    visualState.visible.delete( uuid );
    return true;
}


function commitEdit( visualState, action ) {
    const type = action.type;
    const uuid = action.uuid;
    switch ( type ) {
    case MOD_ACTIONS.DRAW.TYPE:
        return commitDraw( visualState, action[MOD_ACTIONS.DRAW.STROKE], uuid );
    case MOD_ACTIONS.ERASE.TYPE:
        return commitErase( visualState, action[MOD_ACTIONS.ERASE.TARGET_ACTION], uuid );
    case MOD_ACTIONS.GROUP.TYPE:
        return commitGroup( visualState, action[MOD_ACTIONS.GROUP.ACTIONS], uuid );
    }
    assert( false );
}

function commitDraw ( visualState, stroke, uuid ) {
    addElement( visualState, uuid, stroke );
    return showElement( visualState, uuid );
}

function commitErase ( visualState, target, uuid ) {
    return hideElement( visualState, target );
}

function commitGroup ( visualState, actions, uuid = "" ) {
    const previousState = structuredClone( visualState );
    let flag = true;
    for ( const edit of actions ) {
        flag = flag & commitEdit( visualState, edit );
        if (!flag) {
            Object.assign( visualState, previousState );
            return false;
        }
    }
    return true;
}

function revertEdit ( visualState, action ) {
    const type = action[MOD_ACTIONS.TYPE];
    const uuid = action[MOD_ACTIONS.UUID];
    switch ( type ) {
    case MOD_ACTIONS.DRAW.TYPE:
        return revertDraw( visualState, action[MOD_ACTIONS.DRAW.STROKE], uuid );
    case MOD_ACTIONS.ERASE.TYPE:
        return revertErase( visualState, action[MOD_ACTIONS.ERASE.TARGET_ACTION], uuid );
    case MOD_ACTIONS.GROUP.TYPE:
        return revertGroup( visualState, action[MOD_ACTIONS.GROUP.ACTIONS], uuid );
    }
}

function revertDraw ( visualState, stroke, uuid ) {
    return hideElement( visualState, uuid );
}

function revertErase ( visualState, target, uuid ) {
    return showElement( visualState, target );
}

function revertGroup ( visualState, actions, uuid ) {
    const previouslyVisible = structuredClone( visualState.visible );
    let flag = true;
    for ( let index = actions.length - 1; index >= 0; -- index ){
        const edit = actions[ index ];
        flag = flag & revertEdit( visualState, edit, edit.uuid );
        if ( ! flag ) {
            visualState.visible = previouslyVisible;
            return false;
        }
    }
    return true;
}


// Geometry
// ========

// Helper function to determine if two elements intersect
// used, e.g., by erase

function distSquare ( p, q ) {
    const dx = p[ POINT.X ] - q[ POINT.X ];
    const dy = p[ POINT.Y ] - q[ POINT.Y ]; 
    return dx * dx + dy * dy;
}

function interpolate ( p, q, t ) {
    const x = ( 1 - t ) * p[ POINT.X ] + t * q[ POINT.X ];
    const y = ( 1 - t ) * p[ POINT.Y ] + t * q[ POINT.Y ];
    return [ x, y ];
}

// Helper function to add a grid cell and its neighbors to the locations set
function addGridCell ( locations, x_bar, y_bar, eps, delta ) {
    const radius = Math.ceil(eps / delta);
    for (let dx = -radius; dx <= radius; dx++) {
        for (let dy = -radius; dy <= radius; dy++) {
            if (dx*dx + dy*dy <= radius*radius) {
                // Use string representation since we'll use Set.prototype.isDisjointFrom
                locations.add(`${x_bar + dx},${y_bar + dy}`);
            }
        }
    }
}

function tracePath ( path, eps, delta ) {
    const locations = new Set();
    
    // Handle the individual points first
    for (let i = 0; i < path.length; i++) {
        const x = path[i][POINT.X];
        const y = path[i][POINT.Y];
        
        // Calculate grid cell and add to locations
        const x_bar = Math.floor(x / delta);
        const y_bar = Math.floor(y / delta);
        
        // Add current cell and neighbors to account for the epsilon radius
        addGridCell(locations, x_bar, y_bar, eps, delta);
    }
    
    // Now handle the line segments between points
    for (let i = 0; i < path.length - 1; i++) {
        const p1 = path[i];
        const p2 = path[i + 1];
        
        // Calculate the squared distance between points
        const segmentLengthSquared = distSquare(p1, p2);
        
        // If points are far enough apart, we need to interpolate
        if (segmentLengthSquared > delta * delta) {
            // Calculate number of interpolation steps based on segment length
            const steps = Math.ceil(Math.sqrt(segmentLengthSquared) / (delta * 0.5));
            
            for (let step = 1; step < steps; step++) {
                // Interpolate a point along the segment
                const t = step / steps;
                const interpolatedPoint = interpolate(p1, p2, t);
                
                // Add the grid cell for this interpolated point
                const x_bar = Math.floor(interpolatedPoint[0] / delta);
                const y_bar = Math.floor(interpolatedPoint[1] / delta);
                
                addGridCell(locations, x_bar, y_bar, eps, delta);
            }
        }
    }
    return locations;
}

function pathsIntersect (path1, path2, eps, delta ) {
    const trace1 = tracePath(path1, eps, delta);
    const trace2 = tracePath(path2, eps, delta);
    return !trace1.isDisjointFrom(trace2);
}

// Helper to find elements that intersect with a given element
function findIntersectingElements ( visualState, needle, eps, delta ) {
    let result = [];
    const true_needle = applyTransformToPath( needle[ELEMENT.TRANSFORM], needle[ELEMENT.POINTS] );
    
    for ( const [uuid, hay] of visualState.element ) {
        const true_hay = applyTransformToPath( hay[ELEMENT.TRANSFORM], hay[ELEMENT.POINTS] );
        if (visualState.visible.has( uuid ) && 
            pathsIntersect( true_hay, true_needle, eps, delta) ) {
            result.push( uuid );
        }
    }
    return result;
}


// =====================================================================
// PDF rendering
// =====================================================================

/**
 * Maps RGB values [0-255] to PDF decimal color components [0-1].
 * @param {string} style - CSS color string (e.g., 'rgb(255, 0, 0)', '#ff0000', or 'red').
 * @param {boolean} isStroke - True for stroke color (RG), false for fill (rg).
 * @returns {string} PDF color operator and values (e.g., '1 0 0 RG').
 */
function toPDFColor(style, isStroke) {
    let r = 0, g = 0, b = 0;
    
    // Handle rgb() format
    const rgbMatch = String(style).match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
    if (rgbMatch) {
        r = parseInt(rgbMatch[1]) / 255;
        g = parseInt(rgbMatch[2]) / 255;
        b = parseInt(rgbMatch[3]) / 255;
    }
    // Handle hex format (#RRGGBB or #RGB)
    else if (String(style).startsWith('#')) {
        let hex = style.slice(1);
        // Expand shorthand (#RGB -> #RRGGBB)
        if (hex.length === 3) {
            hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
        }
        r = parseInt(hex.substr(0, 2), 16) / 255;
        g = parseInt(hex.substr(2, 2), 16) / 255;
        b = parseInt(hex.substr(4, 2), 16) / 255;
    }
    // Handle named colors (basic set)
    else {
        const namedColors = {
            'black': [0, 0, 0], 'white': [255, 255, 255],
            'red': [255, 0, 0], 'green': [0, 128, 0], 'blue': [0, 0, 255],
            'yellow': [255, 255, 0], 'cyan': [0, 255, 255], 'magenta': [255, 0, 255],
            'gray': [128, 128, 128], 'grey': [128, 128, 128]
        };
        const rgb = namedColors[String(style).toLowerCase()] || [0, 0, 0];
        r = rgb[0] / 255;
        g = rgb[1] / 255;
        b = rgb[2] / 255;
    }
    
    const operator = isStroke ? 'RG' : 'rg';
    return `${r.toFixed(4)} ${g.toFixed(4)} ${b.toFixed(4)} ${operator}`;
}


// PDFContext2D: The Canvas Subset Interface
// -----------------------------------------

/**
 * A context object that translates a subset of Canvas 2D methods
 * into PDF content stream commands, scoped to a specific page size.
 * @param {object} pageContent - The page object to append commands to.
 * @param {number} pageHeight - The height of the page for Y-axis inversion.
 * @param {object} builder - The PDFBuilder instance for resource management (alpha).
 */
function PDFContext2D(pageContent, pageHeight, builder) {
    const internalState = {
        height: pageHeight,
        _fillStyle: 'rgb(0, 0, 0)',
        _strokeStyle: 'rgb(0, 0, 0)',
        _lineWidth: 1,
        _globalAlpha: 1.0, // New property for opacity
        lineDash: [],
        path: [],
        transform: [1, 0, 0, 1, 0, 0]
    };

    const stateStack = [];

    const addCommand = (cmd) => pageContent.commands.push(cmd);
    const addPathCommand = (cmd) => internalState.path.push(cmd);
    const invertY = (y) => internalState.height - y;

    // Coordinates and lengths are in points (1/72 inch): 0.01 pt is invisible and
    // the short form roughly halves the content stream. Matrix factors scale
    // everything after them, so they keep 6 decimals. Fixed decimals also avoid
    // exponent notation (1e-7), which PDF does not understand.
    const num = (v) => +(+v).toFixed(2);
    const factor = (v) => +(+v).toFixed(6);

    // Initial commands to set defaults in the PDF content stream
    addCommand(`${num(internalState._lineWidth)} w`);
    addCommand(`[] 0 d`);

    const context = {
        // --- Properties (using accessors for command emission) ---
        set fillStyle(value) {
            internalState._fillStyle = value;
            addCommand(toPDFColor(value, false));
        },
        get fillStyle() { return internalState._fillStyle; },

        set strokeStyle(value) {
            internalState._strokeStyle = value;
            addCommand(toPDFColor(value, true));
        },
        get strokeStyle() { return internalState._strokeStyle; },

        set lineWidth(value) {
            internalState._lineWidth = value;
            addCommand(`${num(value)} w`);
        },
        get lineWidth() { return internalState._lineWidth; },
        
        set lineCap(value) {
            // Convert CSS string values to PDF codes: 0=butt, 1=round, 2=square
            const capMap = { 'butt': 0, 'round': 1, 'square': 2 };
            const capCode = capMap[value] !== undefined ? capMap[value] : 0;
            addCommand(`${capCode} J`);
        },
        
        set lineJoin(value) {
            // Convert CSS string values to PDF codes: 0=miter, 1=round, 2=bevel
            const joinMap = { 'miter': 0, 'round': 1, 'bevel': 2 };
            const joinCode = joinMap[value] !== undefined ? joinMap[value] : 0;
            addCommand(`${joinCode} j`);
        },
        
        set miterLimit(value) {
            addCommand(`${num(value)} M`);
        },
        
        set globalAlpha(value) {
            const alpha = Math.max(0, Math.min(1, value));
            if (internalState._globalAlpha === alpha) return;

            internalState._globalAlpha = alpha;
            
            // Get or create the PDF resource ID for this alpha value
            const resourceID = builder.getAlphaResourceID(alpha);
            
            // Emit the graphics state operator (gs)
            addCommand(`${resourceID} gs`);
        },
        get globalAlpha() { return internalState._globalAlpha; },
        
        // --- State Management ---
        save() {
            addCommand('q');
            stateStack.push({ 
                ...internalState, 
                transform: [...internalState.transform],
                _globalAlpha: internalState._globalAlpha
            });
        },
        restore() {
            addCommand('Q');
            if (stateStack.length > 0) {
                const restoredState = stateStack.pop();
                // Restore JS-side state
                Object.assign(internalState, restoredState);

                // Re-emit commands for properties that might have been changed/restored
                addCommand(toPDFColor(internalState._fillStyle, false));
                addCommand(toPDFColor(internalState._strokeStyle, true));
                addCommand(`${num(internalState._lineWidth)} w`);
                
                const resourceID = builder.getAlphaResourceID(internalState._globalAlpha);
                addCommand(`${resourceID} gs`);

                const pattern = internalState.lineDash.map(num).join(' ');
                addCommand(`[${pattern}] 0 d`);
            }
        },

        // --- Path Commands ---
        beginPath() { internalState.path = []; },
        moveTo(x, y) { addPathCommand(`${num(x)} ${num(invertY(y))} m`); },
        lineTo(x, y) { addPathCommand(`${num(x)} ${num(invertY(y))} l`); },
        closePath() { addPathCommand('h'); },
        arc(x, y, radius, startAngle, endAngle, counterclockwise = false) {
            // Fails hard if unimplemented
            throw new Error("PDFContext2D Error: arc() requires complex Bézier curve calculation and is not implemented.");
        },

        // --- Drawing Commands ---
        stroke() {
            if (internalState.path.length > 0) {
                addCommand(internalState.path.join('\n'));
                addCommand('S');
                internalState.path = [];
            }
        },
        fill() {
            if (internalState.path.length > 0) {
                addCommand(internalState.path.join('\n'));
                addCommand('f');
                internalState.path = [];
            }
        },

        // --- Text ---
        // One line in Helvetica (font /F1 of PDFBuilder), filled with fillStyle;
        // (x, y) is the left end of the baseline. Unlike canvas, the size is an
        // argument, as there is no font property. Helvetica is one of the standard
        // fonts every PDF viewer has, so nothing is embedded. It covers WinAnsi
        // only: other characters become '?'.
        fillText(text, x, y, size = 12) {
            const escaped = String(text)
                .replace(/[^\x20-\x7e\xa0-\xff]/g, '?')
                .replace(/[\\()]/g, (c) => '\\' + c);
            addCommand(`BT /F1 ${num(size)} Tf ${num(x)} ${num(invertY(y))} Td (${escaped}) Tj ET`);
        },

        // --- Path Construction / clipping ---
        rect(x, y, w, h) {
            addCommand(`${num(x)} ${num(invertY(y + h))} ${num(w)} ${num(h)} re`);
        },
        clip() {
            addCommand('W n');
        },

        // --- Shape Shortcuts ---
        fillRect(x, y, w, h) {
            // PDF's 're' operator uses bottom-left as origin
            addCommand(`${num(x)} ${num(invertY(y + h))} ${num(w)} ${num(h)} re`);
            addCommand('f');
        },
        strokeRect(x, y, w, h) {
            addCommand(`${num(x)} ${num(invertY(y + h))} ${num(w)} ${num(h)} re`);
            addCommand('S');
        },
        clearRect(x, y, w, h) {
            this.save();
            this.fillStyle = 'rgb(255, 255, 255)'; // White fill
            this.globalAlpha = 1.0; // Ensure clearing is fully opaque
            this.fillRect(x, y, w, h);
            this.restore();
        },

        // --- Transforms ---
        translate(x, y) {
            // The negative Y compensates for the initial CTM inversion
            addCommand(`1 0 0 1 ${num(x)} ${num(-y)} cm`);
        },
        transform(a, b, c, d, e, f) {
            // Multiply current matrix by the transformation matrix
            // addCommand(`${a} ${-b} ${-c} ${d} ${e} ${-f} cm`);
            addCommand(`${factor(a)} ${factor(-b)} ${factor(-c)} ${factor(d)} ${num(e + c*internalState.height)} ${num(internalState.height*(1-d) - f)} cm`);
        },

        // --- Line Style ---
        setLineDash(segments) {
            internalState.lineDash = segments;
            const pattern = segments.map(num).join(' ');
            addCommand(`[${pattern}] 0 d`);
        }
    };
    
    return context;
}



// PDFBuilder: The Document Manager and Complete Serializer
// --------------------------------------------------------

// Node.js conditional imports
let fs;
if (typeof process !== 'undefined' && process.versions && process.versions.node) {
    try {
        fs = require('fs');
    } catch (e) {
        // This is fine if the user runs the file in the browser (where 'require' is not defined)
        // or if running in a restrictive sandbox.
    }
}

// Minimal zlib encoder for FlateDecode streams
// --------------------------------------------
// A single final deflate block with the fixed Huffman code (RFC 1951, 3.2.6),
// greedy LZ77 matching through hash chains over the 32 KiB window, framed as a
// zlib stream (RFC 1950: 2-byte header, Adler-32 trailer). Only the encoder is
// needed: decoding is the PDF viewer's job.

const DEFLATE_LENGTH_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const DEFLATE_LENGTH_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DEFLATE_DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DEFLATE_DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];

/**
 * @param {Uint8Array} data - The bytes to compress.
 * @returns {Uint8Array} A zlib stream (what PDF's /FlateDecode expects).
 */
function zlibDeflate(data) {
    const out = [0x78, 0x01]; // zlib header: deflate, 32 KiB window, no dictionary

    // deflate fills each byte starting at its least significant bit
    let bitBuffer = 0;
    let bitCount = 0;
    const putBits = (value, count) => {
        bitBuffer |= value << bitCount;
        bitCount += count;
        while (bitCount >= 8) {
            out.push(bitBuffer & 0xff);
            bitBuffer >>>= 8;
            bitCount -= 8;
        }
    };
    // Huffman codes are sent most significant bit first
    const putCode = (code, length) => {
        let reversed = 0;
        for (let i = 0; i < length; i++) {
            reversed = (reversed << 1) | ((code >>> i) & 1);
        }
        putBits(reversed, length);
    };
    // the fixed literal/length code
    const putSymbol = (symbol) => {
        if (symbol < 144)      { putCode(0x30 + symbol, 8); }
        else if (symbol < 256) { putCode(0x190 + symbol - 144, 9); }
        else if (symbol < 280) { putCode(symbol - 256, 7); }
        else                   { putCode(0xc0 + symbol - 280, 8); }
    };
    const putMatch = (length, distance) => {
        let i = DEFLATE_LENGTH_BASE.length - 1;
        while (DEFLATE_LENGTH_BASE[i] > length) { i--; }
        putSymbol(257 + i);
        putBits(length - DEFLATE_LENGTH_BASE[i], DEFLATE_LENGTH_EXTRA[i]);
        let j = DEFLATE_DIST_BASE.length - 1;
        while (DEFLATE_DIST_BASE[j] > distance) { j--; }
        putCode(j, 5); // fixed distance codes are plain 5-bit numbers
        putBits(distance - DEFLATE_DIST_BASE[j], DEFLATE_DIST_EXTRA[j]);
    };

    putBits(1, 1); // BFINAL: this is the only block
    putBits(1, 2); // BTYPE 01: fixed Huffman code

    // head[hash] is the latest position with that hash, prev[] chains to older ones
    const WINDOW = 32768, MIN_MATCH = 3, MAX_MATCH = 258, MAX_CHAIN = 64, HASH_SIZE = 1 << 15;
    const head = new Int32Array(HASH_SIZE).fill(-1);
    const prev = new Int32Array(WINDOW).fill(-1);
    const hashAt = (p) => ((data[p] << 10) ^ (data[p + 1] << 5) ^ data[p + 2]) & (HASH_SIZE - 1);
    const insert = (p) => {
        if (p + MIN_MATCH <= data.length) {
            const h = hashAt(p);
            prev[p & (WINDOW - 1)] = head[h];
            head[h] = p;
        }
    };

    let pos = 0;
    while (pos < data.length) {
        let bestLength = 0;
        let bestDistance = 0;
        if (pos + MIN_MATCH <= data.length) {
            const limit = Math.min(MAX_MATCH, data.length - pos);
            let candidate = head[hashAt(pos)];
            // every candidate lies before pos; a recycled prev slot can only waste a step
            for (let chain = MAX_CHAIN; candidate >= 0 && pos - candidate <= WINDOW && chain > 0; chain--) {
                let length = 0;
                while (length < limit && data[candidate + length] === data[pos + length]) { length++; }
                if (length > bestLength) {
                    bestLength = length;
                    bestDistance = pos - candidate;
                    if (length === limit) { break; }
                }
                candidate = prev[candidate & (WINDOW - 1)];
            }
        }
        if (bestLength >= MIN_MATCH) {
            putMatch(bestLength, bestDistance);
            for (const end = pos + bestLength; pos < end; pos++) { insert(pos); }
        } else {
            putSymbol(data[pos]);
            insert(pos);
            pos++;
        }
    }
    putSymbol(256); // end of block
    if (bitCount > 0) { out.push(bitBuffer & 0xff); }

    // Adler-32 of the uncompressed data, most significant byte first
    let a = 1;
    let b = 0;
    for (let i = 0; i < data.length; i++) {
        a = (a + data[i]) % 65521;
        b = (b + a) % 65521;
    }
    out.push(b >>> 8, b & 0xff, a >>> 8, a & 0xff);
    return Uint8Array.from(out);
}

function PDFBuilder() {
    const pages = [];
    const alphaResources = new Map();
    let alphaCounter = 1;

    // Stores byte offsets for the xref table
    const objectOffsets = [];

    function getAlphaResourceID(alpha) {
        const alphaStr = alpha.toFixed(4); 
        if (!alphaResources.has(alphaStr)) {
            const resourceID = `/GS${alphaCounter++}`;
            alphaResources.set(alphaStr, resourceID);
        }
        return alphaResources.get(alphaStr);
    }

    function new_page(width, height) {
        const pageContent = { commands: [], width: width, height: height };
        pages.push(pageContent);
        
        const context = PDFContext2D(pageContent, height, this); 
        
        return context;
    }

    /**
     * Helper to perform the full PDF serialization structure (Objects, XREF, Trailer).
     * @returns {string} The complete PDF byte stream content.
     */
    function _serialize_pdf_content() {
        if (pages.length === 0) {
            throw new Error("Cannot generate PDF: Document contains no pages.");
        }

        let pdfContent = `%PDF-1.4\n%äüöß\n`;
        let objCount = 1;
        objectOffsets.length = 0; // Clear offsets for new serialization

        // Helper to add an object and record its offset
        const addObject = (content) => {
            const objID = objCount++;
            objectOffsets.push(pdfContent.length); // Record byte offset
            pdfContent += `${objID} 0 obj\n${content}\nendobj\n`;
            return objID;
        };

        const contentStreamIDs = [];
        const pageObjIDs = [];

        // --- 1. Content Streams (compressed) ---
        for (const page of pages) {
            const contentStream = page.commands.join('\n');
            // Content streams are bytes. Every character in them is below 256 (fillText
            // maps all others to '?') and stands for one byte, as the WinAnsi font expects.
            const raw = new Uint8Array(contentStream.length);
            for (let i = 0; i < contentStream.length; i++) {
                raw[i] = contentStream.charCodeAt(i);
            }
            const bytes = zlibDeflate(raw);

            // Convert binary data to Latin-1 string for PDF
            let binaryString = '';
            for (let i = 0; i < bytes.length; i++) {
                binaryString += String.fromCharCode(bytes[i]);
            }

            const streamContent = `<< /Length ${binaryString.length} /Filter /FlateDecode >>\nstream\n${binaryString}\nendstream`;
            contentStreamIDs.push(addObject(streamContent));
        }

        // --- 2. ExtGState Objects (Alpha Definitions) ---
        const extGStateObjects = [];
        for (const [alphaStr, resourceID] of alphaResources.entries()) {
            const alpha = parseFloat(alphaStr).toFixed(4);
            const extGStateContent = `<< /Type /ExtGState /ca ${alpha} /CA ${alpha} >>`;
            const objID = addObject(extGStateContent);
            extGStateObjects.push({ resourceID, objID });
        }
        
        // --- 3. Resource Dictionary (Shared) ---
        let extGStateDict = '';
        extGStateObjects.forEach(res => {
            extGStateDict += `  ${res.resourceID} ${res.objID} 0 R\n`;
        });
        // fillText's font, as its own object: some tools mishandle inline font dictionaries
        const fontObjID = addObject(`<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>`);
        const resourcesDict = `<< /ExtGState <<\n${extGStateDict}>>\n/Font << /F1 ${fontObjID} 0 R >>\n>>`;
        const resourceObjID = addObject(resourcesDict);

        // --- 4. Page Dictionaries ---
        // Predict the Pages Root ID (it will be the next object)
        const pagesRootID = objCount + pages.length;
        let pagesKids = '';
        for (let i = 0; i < pages.length; i++) {
            const pageDict = `<<\n  /Type /Page\n  /Parent ${pagesRootID} 0 R\n  /MediaBox [0 0 ${pages[i].width} ${pages[i].height}]\n  /Contents ${contentStreamIDs[i]} 0 R\n  /Resources ${resourceObjID} 0 R\n>>`;
            const pageObjID = addObject(pageDict);
            pagesKids += `${pageObjID} 0 R `;
            pageObjIDs.push(pageObjID);
        }
        
        // --- 5. Pages Root Dictionary ---
        const pagesRootDict = `<<\n  /Type /Pages\n  /Kids [${pagesKids}]\n  /Count ${pages.length}\n>>`;
        const actualPagesRootID = addObject(pagesRootDict);

        // --- 6. Catalog Root Dictionary (The document entry point) ---
        const catalogID = addObject(`<<\n  /Type /Catalog\n  /Pages ${actualPagesRootID} 0 R\n>>`);
        
        
        // --- 7. Cross-Reference Table (XREF) ---
        const xrefStart = pdfContent.length;
        let xrefTable = `xref\n0 ${objCount}\n0000000000 65535 f \n`; // 0th object is always free
        
        // Object IDs 1 through objCount-1
        for (let i = 0; i < objectOffsets.length; i++) {
            const offset = String(objectOffsets[i]).padStart(10, '0');
            xrefTable += `${offset} 00000 n \n`;
        }
        
        pdfContent += xrefTable;

        // --- 8. Trailer ---
        pdfContent += `trailer\n<<\n  /Size ${objCount}\n  /Root ${catalogID} 0 R\n>>\n`;
        pdfContent += `startxref\n${xrefStart}\n%%EOF\n`;
        
        return pdfContent;
    }

    /**
     * Implementation 1: For Node.js environment (Server-side I/O).
     * @param {string} file_path - The full path to write the file.
     */
    function write_to_node_file(file_path) {
        if (typeof fs === 'undefined') {
            throw new Error("Node.js 'fs' module not found. Use download_in_browser() for the client.");
        }
        
        const pdfContent = _serialize_pdf_content();
        
        try {
            // Write PDF as binary/buffer
            fs.writeFileSync(file_path, Buffer.from(pdfContent, 'binary'));
            console.log(`\nSuccessfully wrote PDF to: ${file_path}`);
        } catch (e) {
            throw new Error(`Failed to write file to Node FS: ${e.message}`);
        }
    }

    /**
     * Implementation 2: For Browser environment (Client-side download).
     * @param {string} file_name - The suggested name for the downloaded file.
     */
    function download_in_browser(file_name) {
        if (typeof Blob === 'undefined' || typeof URL === 'undefined') {
            throw new Error("Browser Blob/URL APIs not found. Use write_to_node_file() for the server.");
        }
        
        const pdfContent = _serialize_pdf_content();
        
        // Convert string to Uint8Array with proper binary encoding (latin1)
        const bytes = new Uint8Array(pdfContent.length);
        for (let i = 0; i < pdfContent.length; i++) {
            bytes[i] = pdfContent.charCodeAt(i) & 0xFF;
        }
        
        const blob = new Blob([bytes], { type: 'application/pdf' });
        const url = URL.createObjectURL(blob);
        
        const a = document.createElement('a');
        a.href = url;
        a.download = file_name;
        a.style.display = 'none';
        
        // Add to DOM, click, then remove and cleanup
        document.body.appendChild(a);
        a.click();
        
        // Cleanup after a delay to ensure download started
        setTimeout(() => {
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        }, 100);
        
        console.log(`\nTriggered browser download for: ${file_name}`);
    }

    return {
        new_page,
        getAlphaResourceID, // exposed for the context
        write_to_node_file, 
        download_in_browser
    };
}





// Export for Node.js (server)
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        PORT,
        recent_snapshots,
        // uuid
        NULL_UUID,
        generateUuid,
        isUuid,
        // serialization
        serialize,
        deserialize,
        // hashing
        hashAny,
        hashNext,
        // value comparison
        isEqual,
        isNotEqual,
        // schemas and constants
        MOD_ACTIONS,
        MESSAGES,
        CREDENTIAL_NOT_ACCEPTED,
        CREDENTIAL_NOT_SAVED,
        PATH_INVALID,
        PATH_TAKEN,
        NOT_OWNER,
        NO_SUCH_BOARD,
        NO_SUCH_FOLDER,
        RENAME_BLOCKED,
        MAX_PATH_LENGTH,
        PATH_FORM,
        pathFormProblem,
        findPathConflict,
        newBoardProblem,
        boardMoveProblem,
        folderMove,
        DRAWABLE,
        POINT,
        ELEMENT,
        PEN_TYPES,
        CAP_STYLES,
        JOIN_STYLES,
        PEN_TYPE_STRINGS,
        CAP_STYLE_STRINGS,
        JOIN_STYLE_STRINGS,
        TRANSFORM,
        STROKE_STYLES,
        VISUAL_STATE,
        // validation
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
        is_invalid_SHUFFLE_PROPOSAL_message,
        // transforms
        createIdentityTransform,
        applyTransform,
        bbox,
        compose,
        // stroke operations
        createStroke,
        createPoint,
        addPointToStroke,
        applyTransformToPath,
        // visual state
        createEmptyVisualState,
        compileVisualState,
        getRenderableElements,
        render_all_visible_elements,
        addElement,
        showElement,
        hideElement,
        commitEdit,
        commitDraw,
        commitErase,
        commitGroup,
        revertEdit,
        revertDraw,
        revertErase,
        revertGroup,
        // geometry
        distSquare,
        interpolate,
        addGridCell,
        tracePath,
        pathsIntersect,
        findIntersectingElements,
        PDFContext2D,
        PDFBuilder,
        zlibDeflate
    };
}
// Export for browsers (client)
else if (typeof window !== 'undefined') {
    window.shared = {
        PORT,
        recent_snapshots,
        // uuid
        NULL_UUID,
        generateUuid,
        isUuid,
        // serialization
        serialize,
        deserialize,
        // hashing
        hashAny,
        hashNext,
        // value comparison
        isEqual,
        isNotEqual,
        // schemas and constants
        MOD_ACTIONS,
        MESSAGES,
        CREDENTIAL_NOT_ACCEPTED,
        CREDENTIAL_NOT_SAVED,
        PATH_INVALID,
        PATH_TAKEN,
        NOT_OWNER,
        NO_SUCH_BOARD,
        NO_SUCH_FOLDER,
        RENAME_BLOCKED,
        MAX_PATH_LENGTH,
        PATH_FORM,
        pathFormProblem,
        findPathConflict,
        newBoardProblem,
        boardMoveProblem,
        folderMove,
        DRAWABLE,
        POINT,
        ELEMENT,
        PEN_TYPES,
        CAP_STYLES,
        JOIN_STYLES,
        PEN_TYPE_STRINGS,
        CAP_STYLE_STRINGS,
        JOIN_STYLE_STRINGS,
        TRANSFORM,
        STROKE_STYLES,
        VISUAL_STATE,
        // transforms
        createIdentityTransform,
        applyTransform,
        bbox,
        compose,
        // stroke operations
        createStroke,
        createPoint,
        addPointToStroke,
        applyTransformToPoint,
        applyTransformToPath,
        // visual state
        createEmptyVisualState,
        compileVisualState,
        getRenderableElements,
        render_all_visible_elements,
        addElement,
        showElement,
        hideElement,
        commitEdit,
        commitDraw,
        commitErase,
        commitGroup,
        revertEdit,
        revertDraw,
        revertErase,
        revertGroup,
        // geometry
        distSquare,
        interpolate,
        addGridCell,
        tracePath,
        pathsIntersect,
        findIntersectingElements,
        PDFContext2D,
        PDFBuilder,
        zlibDeflate
    };
}
