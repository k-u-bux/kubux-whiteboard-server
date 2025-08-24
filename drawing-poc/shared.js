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

const MESSAGES = {
  CLIENT_TO_SERVER: {
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
      ACTION_UUID: 'action-uuid'
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

const MOD_ACTIONS = {
    DRAW: {
        TYPE: 'draw',
        POINTS: 'points'
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
    }
};

// Export for Node.js (server)
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    generateUuid,
    calculateHash,
    calculateChainHash,
    hashAny,
    hashNext,
    MESSAGES,
    MOD_ACTIONS
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
    MESSAGES,
    MOD_ACTIONS
  };
}
