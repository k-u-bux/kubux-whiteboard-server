function generateUuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

function hashAny(data) {
  const dataString = JSON.stringify(data);
  let hash = 0;
  for (let i = 0; i < dataString.length; i++) {
    const char = dataString.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0;
  }
  return hash.toString();
}

function hashNext(previousHash, newData) {
  const combinedData = [previousHash, newData];
  return hashAny(combinedData);
}

// Maintain compatibility with existing code
const calculateHash = hashAny;
const calculateChainHash = hashNext;

// Indices for point arrays [x, y, pressure, timestamp]
const POINT = {
  X: 0,
  Y: 1,
  PRESSURE: 2,
  TIMESTAMP: 3
};

// Indices for stroke arrays [type, points[], color, width, penType, opacity, capStyle, joinStyle, dashPattern, pressureSensitivity, layer]
const STROKE = {
  TYPE: 0,         // Always "stroke"
  POINTS: 1,       // Array of point arrays
  COLOR: 2,        // Color string
  WIDTH: 3,        // Stroke width
  PEN_TYPE: 4,     // Pen type constant
  OPACITY: 5,      // Opacity (0-1)
  CAP_STYLE: 6,    // Cap style constant
  JOIN_STYLE: 7,   // Join style constant
  DASH_PATTERN: 8, // Dash pattern array
  PRESSURE_SENS: 9, // Pressure sensitivity
  LAYER: 10        // Layer number
};

// Stroke style definitions
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

// Default stroke styles (using compact array format)
const STROKE_STYLES = {
  PEN: [
    "stroke",             // type
    [],                   // points
    "#000000",            // color
    2.0,                  // width
    PEN_TYPES.MARKER,     // penType
    1.0,                  // opacity
    CAP_STYLES.ROUND,     // capStyle
    JOIN_STYLES.ROUND,    // joinStyle
    [0],                  // dashPattern
    1.0,                  // pressureSensitivity
    1                     // layer
  ],
  HIGHLIGHTER: [
    "stroke",             // type
    [],                   // points
    "#FFFF00",            // color
    24.0,                 // width
    PEN_TYPES.HIGHLIGHTER, // penType
    0.5,                  // opacity
    CAP_STYLES.SQUARE,    // capStyle
    JOIN_STYLES.ROUND,    // joinStyle
    [0],                  // dashPattern
    0.3,                  // pressureSensitivity
    1                     // layer
  ]
};

// Function to create a new stroke with specific style
function createStroke(styleTemplate = STROKE_STYLES.PEN) {
  // Clone the style array
  return [...styleTemplate];
}

// Function to add a point to a stroke with pressure and timestamp
function addPointToStroke(stroke, x, y, pressure = 0.5, timestamp = Date.now()) {
  // Create a compact point representation [x, y, pressure, timestamp]
  const point = [x, y, pressure, timestamp];
  
  // Make sure points array exists
  if (!Array.isArray(stroke[STROKE.POINTS])) {
    stroke[STROKE.POINTS] = [];
  }
  
  // Add the point
  stroke[STROKE.POINTS].push(point);
  return stroke;
}

// Helper for converting legacy point objects to compact format
function convertPointToCompact(pointObj) {
  return [
    pointObj.x, 
    pointObj.y, 
    pointObj.pressure || 0.5,
    pointObj.timestamp || Date.now()
  ];
}

// Helper for converting legacy stroke objects to compact format
function convertStrokeToCompact(strokeObj) {
  const compactStroke = [
    "stroke",  // type
    [],        // points (will fill below)
    strokeObj.style.color || "#000000",
    strokeObj.style.width || 2.0,
    getPenTypeValue(strokeObj.style.penType),
    strokeObj.style.opacity || 1.0,
    getCapStyleValue(strokeObj.style.capStyle),
    getJoinStyleValue(strokeObj.style.joinStyle),
    strokeObj.style.dashPattern || [0],
    strokeObj.style.pressureSensitivity || 1.0,
    strokeObj.style.layer || 1
  ];
  
  // Convert points
  if (strokeObj.points && Array.isArray(strokeObj.points)) {
    compactStroke[STROKE.POINTS] = strokeObj.points.map(p => 
      Array.isArray(p) ? p : convertPointToCompact(p)
    );
  }
  
  return compactStroke;
}

// Helper functions to handle string/number conversions
function getPenTypeValue(penTypeString) {
  if (typeof penTypeString === 'number') return penTypeString;
  const index = PEN_TYPE_STRINGS.indexOf(penTypeString);
  return index >= 0 ? index : PEN_TYPES.MARKER;
}

function getCapStyleValue(capStyleString) {
  if (typeof capStyleString === 'number') return capStyleString;
  const index = CAP_STYLE_STRINGS.indexOf(capStyleString);
  return index >= 0 ? index : CAP_STYLES.ROUND;
}

function getJoinStyleValue(joinStyleString) {
  if (typeof joinStyleString === 'number') return joinStyleString;
  const index = JOIN_STYLE_STRINGS.indexOf(joinStyleString);
  return index >= 0 ? index : JOIN_STYLES.ROUND;
}

// Get string values for rendering
function getPenTypeString(value) {
  return PEN_TYPE_STRINGS[value] || "marker";
}

function getCapStyleString(value) {
  return CAP_STYLE_STRINGS[value] || "round";
}

function getJoinStyleString(value) {
  return JOIN_STYLE_STRINGS[value] || "round";
}

// Message constants remain the same for backward compatibility
const MESSAGES = {
  CLIENT_TO_SERVER: {
    REGISTER_BOARD: {
      TYPE: 'register-board',
      BOARD_ID: 'boardId',
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
      ACTION_UUID: 'action-uuid',
      PAYLOAD: 'payload',
      BEFORE_HASH: 'before-hash'
    },
    REPLAY_REQUESTS: {
      TYPE: 'replay-requests',
      PAGE_UUID: 'page-uuid',
      BEFORE_HASH: 'before-hash',
      REQUEST_ID: 'requestId'
    }
  },
  SERVER_TO_CLIENT: {
    BOARD_REGISTERED: {
      TYPE: 'board-registered',
      BOARD_ID: 'boardId',
      INITIAL_PAGE_ID: 'initialPageId',
      TOTAL_PAGES: 'totalPages',
      REQUEST_ID: 'requestId'
    },
    FULL_PAGE: {
      TYPE: 'fullPage',
      PAGE: 'page',
      STATE: 'state',
      HASH: 'hash',
      PAGE_NR: 'pageNr',
      TOTAL_PAGES: 'totalPages'
    },
    ACCEPT_MESSAGE: {
      TYPE: 'accept-message',
      PAGE_UUID: 'page-uuid',
      ACTION_UUID: 'action-uuid',
      BEFORE_HASH: 'before-hash',
      AFTER_HASH: 'after-hash',
      CURRENT_PAGE_NR: 'current page-nr in its board',
      CURRENT_TOTAL_PAGES: 'current #pages of the board'
    },
    DECLINE_MESSAGE: {
      TYPE: 'decline-message',
      PAGE_UUID: 'page-uuid',
      ACTION_UUID: 'action-uuid',
      REASON: 'reason'
    },
    REPLAY_MESSAGE: {
      TYPE: 'replay-message',
      PAGE_UUID: 'page-uuid',
      BEFORE_HASH: 'before-hash',
      AFTER_HASH: 'after-hash',
      SEQUENCE: 'sequence of mod-actions',
      CURRENT_PAGE_NR: 'current page-nr in its board',
      CURRENT_TOTAL_PAGES: 'current #pages of the board'
    },
    PING: {
      TYPE: 'ping',
      PAGE_UUID: 'page-uuid',
      HASH: 'hash',
      CURRENT_PAGE_NR: 'current page-nr in its board',
      CURRENT_TOTAL_PAGES: 'current #pages of the board'
    }
  }
};

// Action types using compact format for MOD_ACTIONS
const MOD_ACTIONS = {
    DRAW: {
        TYPE: 'draw',
        STROKE: 'stroke'
    },
    ERASE: {
        TYPE: 'erase',
        ACTION_UUID: 'actionUuid'
    },
    NEW_PAGE: {
        TYPE: 'new page'
    },
    DELETE_PAGE: {
        TYPE: 'delete page'
    },
    UNDO: {
        TYPE: 'undo',
        TARGET_ACTION_UUID: 'targetActionUuid',
        CLIENT_ID: 'clientId'
    },
    REDO: {
        TYPE: 'redo',
        TARGET_UNDO_ACTION_UUID: 'targetUndoActionUuid',
        CLIENT_ID: 'clientId'
    },
    GROUP: {
        TYPE: 'group',
        ACTIONS: 'actions' // array of mod_actions
    }
};

// Helper function to check if an action is an undo action
function isUndoAction(action) {
  return action && 
         action[MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.PAYLOAD] && 
         action[MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.PAYLOAD].type === MOD_ACTIONS.UNDO.TYPE;
}

// Helper function to check if an action is a redo action
function isRedoAction(action) {
  return action && 
         action[MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.PAYLOAD] && 
         action[MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.PAYLOAD].type === MOD_ACTIONS.REDO.TYPE;
}

// Helper function to get the target of an undo action
function getUndoTarget(action) {
  if (!isUndoAction(action)) return null;
  return action[MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.PAYLOAD][MOD_ACTIONS.UNDO.TARGET_ACTION_UUID];
}

// Helper function to get the target of a redo action
function getRedoTarget(action) {
  if (!isRedoAction(action)) return null;
  return action[MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.PAYLOAD][MOD_ACTIONS.REDO.TARGET_UNDO_ACTION_UUID];
}

// Helper function to check if an action has been undone
function isActionUndone(modActions, actionUuid) {
  return modActions.some(action => 
    isUndoAction(action) && 
    getUndoTarget(action) === actionUuid
  );
}

// Helper function to find what action undid a specific action
function findUndoActionFor(modActions, targetActionUuid) {
  return modActions.find(action => 
    isUndoAction(action) && 
    getUndoTarget(action) === targetActionUuid
  );
}

// Export for Node.js (server)
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    generateUuid,
    calculateHash,
    calculateChainHash,
    hashAny,
    hashNext,
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
    findUndoActionFor
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
    findUndoActionFor
  };
}
