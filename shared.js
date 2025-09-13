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
        TARGET_ACTION: 'targetUndoActionUuid'
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
    TYPE: 0,         // At the moment always DRAWABLE.STROKE
    PATH: 1,         // At the moment always DRAWABLE.OPEN_PIECEWISE_LINEAR
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
    result.transform = compose( transform, result.transform );
    return Object.freeze( result );
}

function addElement ( visualState, uuid, element ) {
    // on the server side, the drawables do not exist
    if ( visualState.element ) {
        visualState.element.set( uuid, element );
    }
}

function showElement ( visualState, uuid ) {
    // if ( visualState.visible.has( uuid ) ) {
    //     return false;
    // }
    visualState.visible.add( uuid );
    return ( true );
}

function hideElement ( visualState, uuid ) {
    if ( ! visualState.visible.has( uuid ) ) {
        return false;
    }
    visualState.visible.delete( uuid );
    return ( true );
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

function revertEdit ( visualState, action, uuid ) {
    const type = action.type;
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
    const true_needle = applyTransformToPath(needle[ELEMENT.TRANSFORM], needle[ELEMENT.POINTS]);
    
    for (const [uuid, hay] of visualState.element) {
        const true_hay = applyTransformToPath(hay[ELEMENT.TRANSFORM], hay[ELEMENT.POINTS]);
        if (visualState.visible.has(uuid) && 
            pathsIntersect(true_hay, true_needle, eps, delta)) {
            result.push(hay);
        }
    }
    return result;
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
        findIntersectingElements
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
        findIntersectingElements
    };
}
