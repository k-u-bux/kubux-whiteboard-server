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


// visual state and actions to state compiler
// ==========================================

// Visual State constants and structures
const VISUAL_STATE = {
  // Element types
  ELEMENT_TYPES: {
    STROKE: 'stroke',
    FILL: 'fill'
  },
  
  // Interpolation types
  INTERPOLATION: {
    PIECEWISE_LINEAR: 0,
    BEZIER_CURVE: 1
  },
  
  // Entry structure indices
  ENTRY: {
    ELEMENT: 0,    // The visual element
    VISIBLE: 1,    // Boolean indicating visibility
    CREATOR_ID: 2  // Action UUID that created this element
  }
};

// Affine transform structure [a, b, c, d, e, f]
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
function createIdentityTransform() {
  return [1, 0, 0, 1, 0, 0];
}

// Apply transform to a point
function applyTransform(transform, x, y) {
  return {
    x: transform[TRANSFORM.A] * x + transform[TRANSFORM.C] * y + transform[TRANSFORM.E],
    y: transform[TRANSFORM.B] * x + transform[TRANSFORM.D] * y + transform[TRANSFORM.F]
  };
}

// Create a visual state entry from a stroke
function createStrokeElement(stroke, transform = createIdentityTransform()) {
  return {
    type: VISUAL_STATE.ELEMENT_TYPES.STROKE,
    points: stroke[STROKE.POINTS].map(point => ({
      x: point[POINT.X],
      y: point[POINT.Y],
      width: stroke[STROKE.WIDTH] * (stroke[STROKE.PRESSURE_SENS] ? point[POINT.PRESSURE] : 1)
    })),
    isBezier: false, // Currently all strokes are piecewise linear
    isClosed: false, // Currently all strokes are open paths
    transform: transform,
    color: {
      hex: stroke[STROKE.COLOR],
      opacity: stroke[STROKE.OPACITY]
    },
    styles: {
      penType: stroke[STROKE.PEN_TYPE],
      capStyle: stroke[STROKE.CAP_STYLE],
      joinStyle: stroke[STROKE.JOIN_STYLE],
      dashPattern: stroke[STROKE.DASH_PATTERN]
    }
  };
}

// Create a visual state entry
function createVisualStateEntry(element, visible, creatorId) {
  return [element, visible, creatorId];
}

// Function to get an element from a visual state entry
function getElement(entry) {
  return entry[VISUAL_STATE.ENTRY.ELEMENT];
}

// Function to check if an entry is visible
function isVisible(entry) {
  return entry[VISUAL_STATE.ENTRY.VISIBLE];
}

// Function to get the creator ID of an entry
function getCreatorId(entry) {
  return entry[VISUAL_STATE.ENTRY.CREATOR_ID];
}

// Creates an empty visual state
function createEmptyVisualState() {
  return [];
}

// Applies a mod action to a visual state
function applyModAction(visualState, action) {
  const payload = action[MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.PAYLOAD];
  const actionUuid = action[MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.ACTION_UUID];
  
  if (!payload || !payload.type) {
    return null; // Invalid action
  }
  
  switch (payload.type) {
    case MOD_ACTIONS.DRAW.TYPE:
      return applyDrawAction(visualState, payload, actionUuid);
    
    case MOD_ACTIONS.ERASE.TYPE:
      return applyEraseAction(visualState, payload, actionUuid);
    
    case MOD_ACTIONS.UNDO.TYPE:
      return applyUndoAction(visualState, payload, actionUuid);
    
    case MOD_ACTIONS.REDO.TYPE:
      return applyRedoAction(visualState, payload, actionUuid);
    
    case MOD_ACTIONS.GROUP.TYPE:
      return applyGroupAction(visualState, payload, actionUuid);
    
    case MOD_ACTIONS.NEW_PAGE.TYPE:
    case MOD_ACTIONS.DELETE_PAGE.TYPE:
      // These actions don't directly affect the visual state of the current page
      return visualState;
    
    default:
      return null; // Unknown action type
  }
}

// Apply a draw action
function applyDrawAction(visualState, payload, actionUuid) {
  if (!payload[MOD_ACTIONS.DRAW.STROKE]) {
    return null; // Invalid draw action
  }
  
  const stroke = payload[MOD_ACTIONS.DRAW.STROKE];
  const element = createStrokeElement(stroke);
  const entry = createVisualStateEntry(element, true, actionUuid);
  
  return [...visualState, entry];
}

// Apply an erase action
function applyEraseAction(visualState, payload, actionUuid) {
  if (!payload[MOD_ACTIONS.ERASE.ACTION_UUID]) {
    return null; // Invalid erase action
  }
  
  const targetActionUuid = payload[MOD_ACTIONS.ERASE.ACTION_UUID];
  
  // Find all entries created by the target action
  const hasTargetAction = visualState.some(entry => 
    getCreatorId(entry) === targetActionUuid && isVisible(entry)
  );
  
  if (!hasTargetAction) {
    return null; // Nothing to erase
  }
  
  // Create a new state with targeted elements marked as invisible
  return visualState.map(entry => {
    if (getCreatorId(entry) === targetActionUuid && isVisible(entry)) {
      return createVisualStateEntry(getElement(entry), false, getCreatorId(entry));
    }
    return entry;
  });
}

// Apply an undo action
function applyUndoAction(visualState, payload, actionUuid) {
  if (!payload[MOD_ACTIONS.UNDO.TARGET_ACTION_UUID]) {
    return null; // Invalid undo action
  }
  
  const targetActionUuid = payload[MOD_ACTIONS.UNDO.TARGET_ACTION_UUID];
  
  // Find entries created by the target action
  const hasTargetAction = visualState.some(entry => 
    getCreatorId(entry) === targetActionUuid
  );
  
  if (!hasTargetAction) {
    return null; // Cannot undo an action that doesn't exist
  }
  
  // Toggle visibility of elements created by the target action
  return visualState.map(entry => {
    if (getCreatorId(entry) === targetActionUuid) {
      return createVisualStateEntry(getElement(entry), !isVisible(entry), getCreatorId(entry));
    }
    return entry;
  });
}

// Apply a redo action
function applyRedoAction(visualState, payload, actionUuid) {
  if (!payload[MOD_ACTIONS.REDO.TARGET_UNDO_ACTION_UUID]) {
    return null; // Invalid redo action
  }
  
  const targetUndoActionUuid = payload[MOD_ACTIONS.REDO.TARGET_UNDO_ACTION_UUID];
  
  // First, find the undo action this redo is targeting
  const undoAction = visualState.find(entry => 
    getCreatorId(entry) === targetUndoActionUuid
  );
  
  if (!undoAction) {
    return null; // Cannot find the undo action to redo
  }
  
  // Now find the original action that was undone
  const originalActionUuid = undoAction[VISUAL_STATE.ENTRY.ELEMENT].targetActionUuid;
  
  if (!originalActionUuid) {
    return null; // Cannot determine what action to redo
  }
  
  // Toggle visibility of elements created by the original action
  return visualState.map(entry => {
    if (getCreatorId(entry) === originalActionUuid) {
      return createVisualStateEntry(getElement(entry), !isVisible(entry), getCreatorId(entry));
    }
    return entry;
  });
}

// Apply a group action
function applyGroupAction(visualState, payload, actionUuid) {
  if (!payload[MOD_ACTIONS.GROUP.ACTIONS] || !Array.isArray(payload[MOD_ACTIONS.GROUP.ACTIONS])) {
    throw new Error("Invalid group action: missing or non-array actions field");
  }
  return applyActionSequence(visualState, payload[MOD_ACTIONS.GROUP.ACTIONS])
}

// apply a sequence of mod actions to a visual state
function applyActionSequence(input_state, actions) {
  let output_state = [...input_state];
  for (const action of actions) {
    output_state = applyModAction(output_state, action);
    if (output_state == null) { return output_state; }
  }
  return output_state;
}

// Compile a sequence of mod actions into a visual state
function compileVisualState(actions) {
  let state = createEmptyVisualState();
  return applyActionSequence(state, actions);
}


// Get a flattened list of visible elements for rendering
function getRenderableElements(visualState) {
  return visualState
    .filter(entry => isVisible(entry))
    .map(entry => getElement(entry));
}


// Helper function to determine if two elements intersect
// used, e.g., by erase
function doElementsIntersect(element1, element2) {
  if (element1.type === VISUAL_STATE.ELEMENT_TYPES.STROKE && 
      element2.type === VISUAL_STATE.ELEMENT_TYPES.STROKE) {
    
    // Simple bounding box check first
    const bbox1 = calculateBoundingBox(element1);
    const bbox2 = calculateBoundingBox(element2);
    
    if (!doBoundingBoxesIntersect(bbox1, bbox2)) {
      return false;
    }
    
    // Get the maximum width as our distance threshold
    const threshold = Math.max(
      getMaxWidth(element1.points),
      getMaxWidth(element2.points)
    ) / 2; // Half the width is reasonable for threshold
    
    // Check line segments for intersection or proximity
    for (let i = 0; i < element1.points.length - 1; i++) {
      const line1 = {
        x1: element1.points[i].x,
        y1: element1.points[i].y,
        x2: element1.points[i + 1].x,
        y2: element1.points[i + 1].y,
        width: element1.points[i].width || 1
      };
      
      for (let j = 0; j < element2.points.length - 1; j++) {
        const line2 = {
          x1: element2.points[j].x,
          y1: element2.points[j].y,
          x2: element2.points[j + 1].x,
          y2: element2.points[j + 1].y,
          width: element2.points[j].width || 1
        };
        
        // Check if line segments intersect directly
        if (lineSegmentsIntersect(line1.x1, line1.y1, line1.x2, line1.y2, 
                                  line2.x1, line2.y1, line2.x2, line2.y2)) {
          return true;
        }
        
        // If no direct intersection, check if they come within threshold distance
        if (minimumDistanceBetweenLineSegments(line1, line2) < threshold) {
          return true;
        }
      }
    }
  }
  
  return false;
}

// Check if two line segments intersect
function lineSegmentsIntersect(x1, y1, x2, y2, x3, y3, x4, y4) {
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
