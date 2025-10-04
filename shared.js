// PORT

const PORT=5236;


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
  if ( n <= 1 ) { return []; }
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
  return result.reverse();
}


// uuid
function generateUuid() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
        const r = Math.random() * 16 | 0;
        const v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

function generatePasswd() {
    return 'xxxxxxxxxxxx'.replace(/[x]/g, function(c) {
        const r = Math.random() * 36 | 0;
        return r.toString(36);
    });
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
function hashAny(data) {
    const mask = 0xffffffffffffffffffffffffffffffn; // 120 bit
    const dataString = serialize( data );
    let hash = 0n;
    for (let i = 0; i < dataString.length; i++) {
        const char = dataString.charCodeAt(i);
        hash += BigInt( char );
        hash = (hash << 25n) - hash;
        hash &= mask;
    }
    return hash.toString(32); // 120 / 5 = 24 characters
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
            BOARD_ID: 'boardId',
            CLIENT_ID: 'clientId',
            REQUEST_ID: 'requestId'
        },
        CREATE_BOARD: {
            TYPE: 'create-board',
            PASSWORD: 'passwd',
            CLIENT_ID: 'clientId',
            REQUEST_ID: 'requestId'
        },
        FULL_PAGE_REQUESTS: {
            TYPE: 'fullPage-requests',
            BOARD_UUID: 'board-uuid',
            PAGE_ID: 'pageId',
            DELTA: 'delta',
            REQUEST_ID: 'requestId'
        },
        MOD_ACTION_PROPOSALS: {
            TYPE: 'mod-action-proposals',
            PASSWORD: 'passwd',
            PAGE_UUID: 'page-uuid',
            PAYLOAD: 'payload',
            BEFORE_HASH: 'before-hash'
        },
        REPLAY_REQUESTS: {
            TYPE: 'replay-requests',
            PAGE_UUID: 'page-uuid',
            PRESENT: 'present',
            PRESENT_HASH: 'present-hash',
            REQUEST_ID: 'requestId'
        }
    },
    SERVER_TO_CLIENT: {
        BOARD_CREATED: {
            TYPE: 'board-created',
            BOARD_ID: 'boardId',
            PASSWORD: 'passwd',
            FIRST_PAGE_ID: 'firstPageId',
            REQUEST_ID: 'requestId'
        },
        BOARD_REGISTERED: {
            TYPE: 'board-registered',
            BOARD_ID: 'boardId',
            FIRST_PAGE_ID: 'firstPageId',
            TOTAL_PAGES: 'totalPages',
            REQUEST_ID: 'requestId'
        },
        FULL_PAGE: {
            TYPE: 'fullPage',
            UUID: 'uuid',
            HISTORY: 'history',
            PRESENT: 'present',
            HASH: 'hash',
            PAGE_NR: 'pageNr',
            TOTAL_PAGES: 'totalPages'
        },
        ACCEPT: {
            TYPE: 'accept',
            UUID: 'uuid',
            ACTION_UUID: 'action-uuid',
            BEFORE_HASH: 'before-hash',
            AFTER_HASH: 'after-hash',
            CURRENT_PAGE_NR: 'current page-nr in its board',
            CURRENT_TOTAL_PAGES: 'current #pages of the board'
        },
        DECLINE: {
            TYPE: 'decline',
            UUID: 'uuid',
            ACTION_UUID: 'action-uuid',
            REASON: 'reason'
        },
        REPLAY: {
            TYPE: 'replay',
            UUID: 'uuid',
            BEFORE_HASH: 'beforeHash',
            AFTER_HASH: 'afterHash',
            SEQUENCE: 'edits',
            PRESENT: 'present',
            CURRENT_HASH: 'currentHash',
            PAGE_NR: 'pageNr',
            TOTAL_PAGES: 'totalPages'
        },
        PING: {
            TYPE: 'ping',
            UUID: 'uuid',
            HASH: 'hash',
            PAGE_NR: 'pageNr',
            TOTAL_PAGES: 'totalPages',
            SNAPSHOTS: 'snapshots'
        }
    }
};

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
    BRUSH: 2
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
        [0],                  // dashPattern
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
        [0],                  // dashPattern
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
        0.0,                  // opacity
        CAP_STYLES.SQUARE,    // capStyle
        JOIN_STYLES.ROUND,    // joinStyle
        [0],                  // dashPattern
        0,                    // pressureSensitivity
        1,                    // layer
        PEN_TYPES.MARKER      // penType
    ]
};

function createStroke ( styleTemplate ) {
    return [ ... styleTemplate ];
}

function createPoint ( x, y, pressure = 0.5, timestamp = Date.now() ) {
    return [ x, y, pressure, timestamp ];
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

    // Initial commands to set defaults in the PDF content stream
    addCommand(`${internalState._lineWidth} w`);
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
            addCommand(`${value} w`);
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
            addCommand(`${value} M`);
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
                addCommand(`${internalState._lineWidth} w`);
                
                const resourceID = builder.getAlphaResourceID(internalState._globalAlpha);
                addCommand(`${resourceID} gs`);

                const pattern = internalState.lineDash.join(' ');
                addCommand(`[${pattern}] 0 d`);
            }
        },

        // --- Path Commands ---
        beginPath() { internalState.path = []; },
        moveTo(x, y) { addPathCommand(`${x} ${invertY(y)} m`); },
        lineTo(x, y) { addPathCommand(`${x} ${invertY(y)} l`); },
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

        // --- Shape Shortcuts ---
        fillRect(x, y, w, h) {
            // PDF's 're' operator uses bottom-left as origin
            addCommand(`${x} ${invertY(y + h)} ${w} ${h} re`);
            addCommand('f');
        },
        strokeRect(x, y, w, h) {
            addCommand(`${x} ${invertY(y + h)} ${w} ${h} re`);
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
            addCommand(`1 0 0 1 ${x} ${-y} cm`);
        },
        transform(a, b, c, d, e, f) {
            // Multiply current matrix by the transformation matrix
            addCommand(`${a} ${b} ${c} ${d} ${e} ${f} cm`);
        },
        setTransform(a, b, c, d, e, f) {
            addCommand(`${a} ${b} ${c} ${d} ${e} ${f} cm`);
        },

        // --- Line Style ---
        setLineDash(segments) {
            internalState.lineDash = segments;
            const pattern = segments.join(' ');
            addCommand(`[${pattern}] 0 d`);
        }
    };
    
    return context;
}



// PDFBuilder: The Document Manager and Complete Serializer
// --------------------------------------------------------

// Node.js conditional imports
let fs, zlib;
if (typeof process !== 'undefined' && process.versions && process.versions.node) {
    try {
        fs = require('fs');
        zlib = require('zlib');
    } catch (e) {
        // This is fine if the user runs the file in the browser (where 'require' is not defined)
        // or if running in a restrictive sandbox.
    }
}

// Check for pako library in browser (for compression)
function hasPako() {
    return typeof window !== 'undefined' && typeof window.pako !== 'undefined';
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

        // --- 1. Content Streams (with optional compression) ---
        for (const page of pages) {
            const contentStream = page.commands.join('\n');
            
            // Try to compress the content stream
            let compressedData = null;
            let useCompression = false;
            
            // Node.js environment (use zlib)
            if (typeof zlib !== 'undefined') {
                try {
                    compressedData = zlib.deflateSync(Buffer.from(contentStream, 'utf8'));
                    useCompression = true;
                } catch (e) {
                    console.warn('Compression failed (Node.js), using uncompressed stream:', e.message);
                }
            }
            // Browser environment (use pako if available)
            else if (hasPako()) {
                try {
                    const textEncoder = new TextEncoder();
                    const uint8Array = textEncoder.encode(contentStream);
                    compressedData = window.pako.deflate(uint8Array);
                    useCompression = true;
                } catch (e) {
                    console.warn('Compression failed (browser), using uncompressed stream:', e.message);
                }
            }
            
            let streamContent;
            if (useCompression && compressedData) {
                // Convert binary data to Latin-1 string for PDF
                let binaryString = '';
                const bytes = new Uint8Array(compressedData);
                for (let i = 0; i < bytes.length; i++) {
                    binaryString += String.fromCharCode(bytes[i]);
                }
                
                streamContent = `<< /Length ${binaryString.length} /Filter /FlateDecode >>\nstream\n${binaryString}\nendstream`;
            } else {
                // Uncompressed fallback
                streamContent = `<< /Length ${contentStream.length} >>\nstream\n${contentStream}\nendstream`;
            }
            
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
        const resourcesDict = `<< /ExtGState <<\n${extGStateDict}>>\n>>`;
        const resourceObjID = addObject(resourcesDict);

        // --- 4. Page Dictionaries ---
        let pagesKids = '';
        for (let i = 0; i < pages.length; i++) {
            const pageDict = `<<\n  /Type /Page\n  /Parent 2 0 R\n  /MediaBox [0 0 ${pages[i].width} ${pages[i].height}]\n  /Contents ${contentStreamIDs[i]} 0 R\n  /Resources ${resourceObjID} 0 R\n>>`;
            const pageObjID = addObject(pageDict);
            pagesKids += `${pageObjID} 0 R `;
            pageObjIDs.push(pageObjID);
        }
        
        // --- 5. Pages Root Dictionary (Object 2 - fixed ID for Pages tree) ---
        // Note: We use a fixed ID for the Pages Root for simplicity, so we must manually place it.
        const pagesRootID = 2; 
        const pagesRootDict = `<<\n  /Type /Pages\n  /Kids [${pagesKids}]\n  /Count ${pages.length}\n>>`;
        
        // We ensure the object ID is correct by pushing a dummy for all previous objects, 
        // then correcting its offset later, or by simply using the current objCount.
        
        // For simplicity in this functional example, we will let objCount determine the IDs
        // and adjust the Page Dictionaries to reference the correct parent ID, 
        // which will be the ID of the Pages dictionary added next.
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
        generateUuid,
        generatePasswd,
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
        PDFBuilder
    };
}
// Export for browsers (client)
else if (typeof window !== 'undefined') {
    window.shared = {
        PORT,
        recent_snapshots,
        // uuid
        generateUuid,
        generatePasswd,
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
        PDFBuilder
    };
}
