// uuid
function generateUuid() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
        const r = Math.random() * 16 | 0;
        const v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
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
        TAGET_ACTION: 'targetActionUuid'
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
            TYPE: 'register-board',
            PASSWD: 'passwd'
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
            PAGE_UUID: 'page-uuid',
            PAYLOAD: 'payload',
            BEFORE_HASH: 'before-hash'
        },
        REPLAY_REQUESTS: {
            TYPE: 'replay-requests',
            PAGE_UUID: 'page-uuid',
            PRESENT: 'present'
            PRESENT_HASH: 'present-hash',
            REQUEST_ID: 'requestId'
        }
    },
    SERVER_TO_CLIENT: {
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
            PRESENT: 'present'
            CURRENT_HASH: 'currentHash',
            PAGE_NR: 'pageNr',
            TOTAL_PAGES: 'totalPages'
        },
        PING: {
            TYPE: 'ping',
            UUID: 'uuid',
            HASH: 'hash',
            PAGE_NR: 'pageNr',
            TOTAL_PAGES: 'totalPages'
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
    TRANSFORM: 5,    // Affine transformation (at the moment the identity)
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
function applyTransform ( transform, x, y ) {
    return {
        x: transform[TRANSFORM.A] * x + transform[TRANSFORM.C] * y + transform[TRANSFORM.E],
        y: transform[TRANSFORM.B] * x + transform[TRANSFORM.D] * y + transform[TRANSFORM.F]
    };
}

function compose ( t1, t2 ) {
    const { x: a, y: b } = applyTransform( t2, 0, 0 );
    const { x: c, y: d } = applyTransform( t2, 1, 0 );
    const { x: e, y: f } = applyTransform( t2, 0, 1 );
    const { x: A, y: B } = applyTransform( t1, a, b );
    const { x: C, y: D } = applyTransform( t1, c, d );
    const { x: E, y: F } = applyTransform( t1, e, f );
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
    PEN: [
        "stroke",             // type
        "opl",                // path
        [],                   // points
        "#000000",            // color
        2.0,                  // width
        createIdentityTransform(), // transform
        1.0,                  // opacity
        CAP_STYLES.ROUND,     // capStyle
        JOIN_STYLES.ROUND,    // joinStyle
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
        0.5,                  // opacity
        CAP_STYLES.SQUARE,    // capStyle
        JOIN_STYLES.ROUND,    // joinStyle
        [0],                  // dashPattern
        0.3,                  // pressureSensitivity
        1,                    // layer
        PEN_TYPES.MARKER      // penType
    ]
};

function createStroke ( styleTemplate = STROKE_STYLES.PEN ) {
    return [ ... styleTemplate ];
}

function createPoint ( x, y, pressure = 0.5, timestamp = Date.now() ) {
    return [ x, y, pressure, timestamp ];
}

function addPointToStroke ( stroke, point ) {
    assert( Array.isArray( stroke[STROKE.POINTS] ) )
    stroke[STROKE.POINTS].push( point );
    return stroke;
}


// visual state and actions to state compiler
// ==========================================

const VISUAL_STATE = {
    ELEMENT: 'element' // map edit_uuid -> element
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
    for ( [ uuid, element ] of visualState.element ) {
        if ( visualState.visible.has( uuid ) ) {
            result.push( element );
        }
    }
}

function render_all_visible_elements ( visualState, render ) {
    for ( const [ uuid, element ] of visualState.element ) {
        if ( visualState.visible.has( uuid ) ) {
            reder( element );
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
    if ( visualState.visible.has( uuid ) ) {
        return false;
    }
    visualState.visible.add( uuid );
    return ( true );
}

function hideElement ( visualState, uuid ) {
    if ( ! visualState.visible.has( uuid ) ) {
        return false;
    }
    visualState.visible.del( uuid );
    return ( true );
}


function commitEdit( visualState, action ) {
    const type = action.type;
    const uuid = action.uuid;
    switch ( type ) {
    case MOD_ACTIONS.DRAW.TYPE:
        return commitDraw( visualState, payload[MOD_ACTIONS.DRAW.STROKE], uuid );
    case MOD_ACTIONS.ERASE.TYPE:
        return commitErase( visualState, payload[MOD_ACTIONS.ERASE.TARGET_ACTION], uuid );
    case MOD_ACTIONS.GROUP.TYPE:
        return commitGroup( visualState, payload[MOD_ACTIONS.GROUP.ACTIONS], uuid );
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
    const previouslyVisible = structuredClone( visualState.visible );
    let flag = true;
    for ( const edit of actions ) {
        flag = flag & commitEdit( visualState, edit );
        if (!flag) {
            visualState.visible = previouslyVisible;
            return false;
        }
    }
    return true;
}

function revertEdit ( visualState, payload, uuid ) {
    const type = payload.type;
    switch ( type ) {
    case MOD_ACTIONS.DRAW.TYPE:
        return revertDraw( visualState, payload[MOD_ACTIONS.DRAW.STROKE], uuid );
    case MOD_ACTIONS.ERASE.TYPE:
        return revertErase( visualState, payload[MOD_ACTIONS.ERASE.TARGET_ACTION], uuid );
    case MOD_ACTIONS.GROUP.TYPE:
        return revertGroup( visualState, payload[MOD_ACTIONS.GROUP.ACTIONS], uuid );
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
        const edti = actions[ index ];
        flag = flag & commitEdit( visualState, edit.payload, edit.uuid );
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

function doElementsIntersect ( element1, element2 ) {
    if ( element1.type === VISUAL_STATE.ELEMENT_TYPES.STROKE && 
         element2.type === VISUAL_STATE.ELEMENT_TYPES.STROKE ) {
        
        // Simple bounding box check first
        const bbox1 = calculateBoundingBox( element1 );
        const bbox2 = calculateBoundingBox( element2 );
        
        if ( ! doBoundingBoxesIntersect (bbox1, bbox2 ) ) {
            return false;
        }
        
        // Get the maximum width as our distance threshold
        const threshold = Math.max(
            getMaxWidth( element1.points ),
            getMaxWidth( element2.points )
        ) / 2; // Half the width is reasonable for threshold
        
        // Check line segments for intersection or proximity
        for ( let i = 0; i < element1.points.length - 1; i++ ) {
            const line1 = {
                x1: element1.points[i].x,
                y1: element1.points[i].y,
                x2: element1.points[i + 1].x,
                y2: element1.points[i + 1].y,
                width: element1.points[i].width || 1
            };
            
            for ( let j = 0; j < element2.points.length - 1; j++ ) {
                const line2 = {
                    x1: element2.points[j].x,
                    y1: element2.points[j].y,
                    x2: element2.points[j + 1].x,
                    y2: element2.points[j + 1].y,
                    width: element2.points[j].width || 1
                };
                
                // Check if line segments intersect directly
                if ( lineSegmentsIntersect( line1.x1, line1.y1, line1.x2, line1.y2, 
                                            line2.x1, line2.y1, line2.x2, line2.y2 ) ) {
                    return true;
                }
                
                // If no direct intersection, check if they come within threshold distance
                if ( minimumDistanceBetweenLineSegments(line1, line2) < threshold ) {
                    return true;
                }
            }
        }
    }
    
    return false;
}

// Check if two line segments intersect
function lineSegmentsIntersect ( x1, y1, x2, y2, x3, y3, x4, y4 ) {
    // Calculate direction vectors
    const dx1 = x2 - x1;
    const dy1 = y2 - y1;
    const dx2 = x4 - x3;
    const dy2 = y4 - y3;
    
    // Calculate determinant
    const determinant = dx1 * dy2 - dy1 * dx2;
    
    // If determinant is zero, lines are parallel
    if (Math.abs(determinant) < 1e-6) {
        return false;
    }
    
    // Calculate the parameters of intersection
    const s = ((x3 - x1) * dy2 - (y3 - y1) * dx2) / determinant;
    const t = ((x3 - x1) * dy1 - (y3 - y1) * dx1) / determinant;
    
    // Check if intersection occurs within both line segments
    return (s >= 0 && s <= 1 && t >= 0 && t <= 1);
}

// Calculate the minimum distance between two line segments
function minimumDistanceBetweenLineSegments(line1, line2) {
    // Check distance from endpoints of line1 to line2
    const d1 = pointToLineDistance(line1.x1, line1.y1, line2.x1, line2.y1, line2.x2, line2.y2);
    const d2 = pointToLineDistance(line1.x2, line1.y2, line2.x1, line2.y1, line2.x2, line2.y2);
    
    // Check distance from endpoints of line2 to line1
    const d3 = pointToLineDistance(line2.x1, line2.y1, line1.x1, line1.y1, line1.x2, line1.y2);
    const d4 = pointToLineDistance(line2.x2, line2.y2, line1.x1, line1.y1, line1.x2, line1.y2);
    
    // Return minimum of all distances
    return Math.min(d1, d2, d3, d4);
}

// Calculate distance from point (x0,y0) to line segment (x1,y1)-(x2,y2)
function pointToLineDistance(x0, y0, x1, y1, x2, y2) {
    // Calculate length of line segment
    const lineLengthSquared = (x2 - x1) * (x2 - x1) + (y2 - y1) * (y2 - y1);
    
    // If line segment is just a point, return distance to that point
    if (lineLengthSquared < 1e-6) {
        return Math.sqrt((x0 - x1) * (x0 - x1) + (y0 - y1) * (y0 - y1));
    }
    
    // Calculate projection of point onto line
    const t = Math.max(0, Math.min(1, ((x0 - x1) * (x2 - x1) + (y0 - y1) * (y2 - y1)) / lineLengthSquared));
    
    // Calculate closest point on line segment
    const projX = x1 + t * (x2 - x1);
    const projY = y1 + t * (y2 - y1);
    
    // Return distance to closest point
    return Math.sqrt((x0 - projX) * (x0 - projX) + (y0 - projY) * (y0 - projY));
}


// Helper to calculate a simple bounding box
function calculateBoundingBox(element) {
    if (!element.points || element.points.length === 0) {
        return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
    }
    
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    
    for (const point of element.points) {
        minX = Math.min(minX, point.x);
        minY = Math.min(minY, point.y);
        maxX = Math.max(maxX, point.x);
        maxY = Math.max(maxY, point.y);
    }
    
    // Add width to the bounding box
    const maxWidth = getMaxWidth(element.points);
    
    return {
        minX: minX - maxWidth/2,
        minY: minY - maxWidth/2,
        maxX: maxX + maxWidth/2,
        maxY: maxY + maxWidth/2
    };
}

// Helper to check if two bounding boxes intersect
function doBoundingBoxesIntersect(bbox1, bbox2) {
    return !(
        bbox1.maxX < bbox2.minX ||
            bbox1.minX > bbox2.maxX ||
            bbox1.maxY < bbox2.minY ||
            bbox1.minY > bbox2.maxY
    );
}

// Helper to get maximum width in a stroke
function getMaxWidth(points) {
    if (!points || points.length === 0) {
        return 0;
    }
    
    let maxWidth = 0;
    for (const point of points) {
        if (typeof point.width === 'number') {
            maxWidth = Math.max(maxWidth, point.width);
        }
    }
    
    return maxWidth || 1; // Default to 1 if no width found
}

// Helper to find elements that intersect with a given element
function findIntersectingElements(visualState, testElement) {
    return visualState
        .filter(entry => isVisible(entry))
        .filter(entry => doElementsIntersect(getElement(entry), testElement))
        .map(entry => getCreatorId(entry));
}


// Export for Node.js (server)
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        generateUuid,
        calculateHash,
        calculateChainHash,
        hashAny,
        hashNext,
        isEqual,
        isNotEqual,
        POINT,
        STROKE,
        PEN_TYPES,
        CAP_STYLES,
        JOIN_STYLES,
        PEN_TYPE_STRINGS,
        CAP_STYLE_STRINGS, 
        JOIN_STYLE_STRINGS,
        STROKE_STYLES,
        createStroke,
        addPointToStroke,
        convertPointToCompact,
        convertStrokeToCompact,
        getPenTypeValue,
        getCapStyleValue,
        getJoinStyleValue,
        getPenTypeString,
        getCapStyleString,
        getJoinStyleString,
        MESSAGES,
        MOD_ACTIONS,
        isUndoAction,
        isRedoAction,
        getUndoTarget,
        getRedoTarget,
        isActionUndone,
        findUndoActionFor,
        // visual state and compiler
        VISUAL_STATE,
        TRANSFORM,
        createIdentityTransform,
        applyTransform,
        createStrokeElement,
        createVisualStateEntry,
        getElement,
        isVisible,
        getCreatorId,
        createEmptyVisualState,
        applyModAction,
        compileVisualState,
        getRenderableElements,
        doElementsIntersect,
        calculateBoundingBox,
        doBoundingBoxesIntersect,
        getMaxWidth,
        findIntersectingElements
    };
}
// Export for browsers (client)
else if (typeof window !== 'undefined') {
    window.shared = {
        generateUuid,
        calculateHash,
        calculateChainHash,
        hashAny,
        hashNext,
        isEqual,
        isNotEqual,
        POINT,
        STROKE,
        PEN_TYPES,
        CAP_STYLES,
        JOIN_STYLES,
        PEN_TYPE_STRINGS,
        CAP_STYLE_STRINGS,
        JOIN_STYLE_STRINGS,
        STROKE_STYLES,
        createStroke,
        addPointToStroke,
        convertPointToCompact,
        convertStrokeToCompact,
        getPenTypeValue,
        getCapStyleValue,
        getJoinStyleValue,
        getPenTypeString,
        getCapStyleString,
        getJoinStyleString,
        MESSAGES,
        MOD_ACTIONS,
        isUndoAction,
        isRedoAction,
        getUndoTarget,
        getRedoTarget,
        isActionUndone,
        findUndoActionFor,
        // visual state and compiler
        VISUAL_STATE,
        TRANSFORM,
        createIdentityTransform,
        applyTransform,
        createStrokeElement,
        createVisualStateEntry,
        getElement,
        isVisible,
        getCreatorId,
        createEmptyVisualState,
        applyModAction,
        compileVisualState,
        getRenderableElements,
        doElementsIntersect,
        calculateBoundingBox,
        doBoundingBoxesIntersect,
        getMaxWidth,
        findIntersectingElements,
    };
}
