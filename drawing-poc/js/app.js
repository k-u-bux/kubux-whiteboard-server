// Main application
const App = {
  verifiedModActions: [],
  optimisticUpdates: [],
  verifiedHash: '',
  currentPageId: '',
  pageNr: 1,
  totalPages: 1,
  
  init: function() {
    // Set debug mode
    window.DEBUG = true;
    
    // Initialize the canvas
    this.setupCanvas();
    
    // Create managers
    this.drawingManager = new DrawingManager(this.canvas);
    this.networkManager = new NetworkManager();
    this.uiManager = new UIManager(this.drawingManager, this.networkManager);
    
    // Set up network event handlers
    this.setupNetworkHandlers();
    
    // Connect to server
    const urlParams = new URLSearchParams(window.location.search);
    const boardId = urlParams.get('id') || shared.generateUuid();
    history.replaceState(null, null, `?id=${boardId}`);
    
    this.networkManager.connect(boardId);
  },
  
  setupCanvas: function() {
    this.canvas = document.getElementById('canvas');
    this.ctx = this.canvas.getContext('2d');
    
    // Resize canvas to fit window
    this.resizeCanvas();
    window.addEventListener('resize', this.resizeCanvas.bind(this));
  },
  
  resizeCanvas: function() {
    const container = document.getElementById('canvas-container');
    this.canvas.width = 800;
    this.canvas.height = 600;
  },
  
  setupNetworkHandlers: function() {
    this.networkManager.on('connect', () => {
      Utils.log('App', 'Connected to server, requesting initial page');
      this.currentPageId = shared.generateUuid();
      this.createNewPage(this.currentPageId);
    });
    
    this.networkManager.on('accept', (data) => {
      this.handleAcceptMessage(data);
    });
    
    this.networkManager.on('decline', (data) => {
      this.handleDeclineMessage(data);
    });
    
    this.networkManager.on('replay', (data) => {
      this.handleReplayMessage(data);
    });
    
    this.networkManager.on('fullPage', (data) => {
      this.handleFullPageMessage(data);
    });
  },
  
  handleAcceptMessage: function(data) {
    Utils.log('App', 'Received accept message', data);
    
    const acceptedActionUuid = data[shared.MESSAGES.SERVER_TO_CLIENT.ACCEPT_MESSAGE.ACTION_UUID];
    const acceptedAction = this.optimisticUpdates.find(a => a[shared.MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.ACTION_UUID] === acceptedActionUuid);
    
    if (acceptedAction) {
      // Move the action from optimistic to verified
      this.optimisticUpdates = this.optimisticUpdates.filter(a => 
        a[shared.MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.ACTION_UUID] !== acceptedActionUuid
      );
      
      // Update the hash values to match server's values
      acceptedAction.hashes = {
        [shared.MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.BEFORE_HASH]: 
          data[shared.MESSAGES.SERVER_TO_CLIENT.ACCEPT_MESSAGE.BEFORE_HASH],
        [shared.MESSAGES.SERVER_TO_CLIENT.ACCEPT_MESSAGE.AFTER_HASH]: 
          data[shared.MESSAGES.SERVER_TO_CLIENT.ACCEPT_MESSAGE.AFTER_HASH]
      };
      
      this.verifiedModActions.push(acceptedAction);
      this.verifiedHash = data[shared.MESSAGES.SERVER_TO_CLIENT.ACCEPT_MESSAGE.AFTER_HASH];
      
      // Update UI with new page info
      this.pageNr = data[shared.MESSAGES.SERVER_TO_CLIENT.ACCEPT_MESSAGE.CURRENT_PAGE_NR];
      this.totalPages = data[shared.MESSAGES.SERVER_TO_CLIENT.ACCEPT_MESSAGE.CURRENT_TOTAL_PAGES];
      this.uiManager.updatePageInfo(this.pageNr, this.totalPages);
      
      // Redraw canvas
      this.renderCanvas();
    } else {
      // Server accepted something we don't know about - request a replay
      this.networkManager.requestReplay(this.currentPageId, this.verifiedHash);
    }
  },
  
  handleDeclineMessage: function(data) {
    Utils.log('App', 'Received decline message', data);
    
    const declinedActionUuid = data[shared.MESSAGES.SERVER_TO_CLIENT.DECLINE_MESSAGE.ACTION_UUID];
    
    // Remove the declined action from optimistic updates
    this.optimisticUpdates = this.optimisticUpdates.filter(a => 
      a[shared.MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.ACTION_UUID] !== declinedActionUuid
    );
    
    // Request a replay to ensure we're in sync
    this.networkManager.requestReplay(this.currentPageId, this.verifiedHash);
    
    // Redraw canvas
    this.renderCanvas();
  },
  
  handleReplayMessage: function(data) {
    Utils.log('App', 'Received replay message', data);
    
    const replayActions = data[shared.MESSAGES.SERVER_TO_CLIENT.REPLAY_MESSAGE.MOD_ACTIONS];
    this.verifiedHash = data[shared.MESSAGES.SERVER_TO_CLIENT.REPLAY_MESSAGE.AFTER_HASH];
    
    // Apply the replayed actions
    this.verifiedModActions = this.verifiedModActions.concat(replayActions);
    
    // Redraw canvas
    this.renderCanvas();
  },
  
  handleFullPageMessage: function(data) {
    Utils.log('App', 'Received full page message', data);
    
    const pageUuid = data[shared.MESSAGES.SERVER_TO_CLIENT.FULL_PAGE.PAGE_UUID];
    const modActions = data[shared.MESSAGES.SERVER_TO_CLIENT.FULL_PAGE.MOD_ACTIONS];
    const afterHash = data[shared.MESSAGES.SERVER_TO_CLIENT.FULL_PAGE.AFTER_HASH];
    
    // Replace current page data
    this.currentPageId = pageUuid;
    this.verifiedModActions = modActions;
    this.optimisticUpdates = [];
    this.verifiedHash = afterHash;
    
    // Update page info
    this.pageNr = data[shared.MESSAGES.SERVER_TO_CLIENT.FULL_PAGE.CURRENT_PAGE_NR];
    this.totalPages = data[shared.MESSAGES.SERVER_TO_CLIENT.FULL_PAGE.CURRENT_TOTAL_PAGES];
    this.uiManager.updatePageInfo(this.pageNr, this.totalPages);
    
    // Redraw canvas
    this.renderCanvas();
  },
  
  sendStroke: function(stroke) {
    const actionUuid = Utils.generateUuid();
    
    const action = {
      type: shared.MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.TYPE,
      [shared.MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.ACTION_TYPE]: shared.MOD_ACTIONS.DRAW.TYPE,
      [shared.MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.PAGE_UUID]: this.currentPageId,
      [shared.MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.ACTION_UUID]: actionUuid,
      [shared.MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.BEFORE_HASH]: this.verifiedHash,
      [shared.MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.PAYLOAD]: {
        type: shared.MOD_ACTIONS.DRAW.TYPE,
        stroke: stroke
      }
    };
    
    // Calculate what we think the hash will be
    const nextHash = shared.hashNext(this.verifiedHash, action[shared.MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.PAYLOAD]);
    
    // Add action to optimistic updates
    const optimisticAction = {
      [shared.MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.ACTION_UUID]: actionUuid,
      [shared.MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.PAYLOAD]: action[shared.MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.PAYLOAD],
      hashes: {
        [shared.MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.BEFORE_HASH]: this.verifiedHash,
        [shared.MESSAGES.SERVER_TO_CLIENT.ACCEPT_MESSAGE.AFTER_HASH]: nextHash
      }
    };
    
    this.optimisticUpdates.push(optimisticAction);
    this.renderCanvas();
    
    // Send to server
    this.networkManager.sendModAction(action);
  },
  
  createNewPage: function(pageUuid) {
    const action = {
      type: shared.MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.TYPE,
      [shared.MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.ACTION_TYPE]: shared.MOD_ACTIONS.CREATE_PAGE.TYPE,
      [shared.MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.PAGE_UUID]: pageUuid,
      [shared.MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.ACTION_UUID]: Utils.generateUuid(),
      [shared.MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.BEFORE_HASH]: '',
      [shared.MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.PAYLOAD]: {
        type: shared.MOD_ACTIONS.CREATE_PAGE.TYPE
      }
    };
    
    // Send to server
    this.networkManager.sendModAction(action);
    
    // Reset local state
    this.verifiedModActions = [];
    this.optimisticUpdates = [];
    this.verifiedHash = '';
  },
  
  renderCanvas: function() {
    // First collect all draw actions to get strokes
    const strokes = [];
    const allActions = [...this.verifiedModActions, ...this.optimisticUpdates];
    
    // Process actions in order
    for (const action of allActions) {
      const payload = action[shared.MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.PAYLOAD];
      if (payload.type === shared.MOD_ACTIONS.DRAW.TYPE) {
        strokes.push(payload.stroke);
      } else if (payload.type === shared.MOD_ACTIONS.ERASE.TYPE) {
        // We'll handle erase logic in the drawing manager
        // For now we're not removing strokes, just passing the erase action
        strokes.push({
          isErase: true,
          position: payload.position,
          radius: payload.radius
        });
      }
    }
    
    // Render all strokes
    this.drawingManager.renderStrokes(strokes);
  }

  sendEraseAction: function(eraseAction) {
    const actionUuid = Utils.generateUuid();
    
    const action = {
      type: shared.MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.TYPE,
      [shared.MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.ACTION_TYPE]: shared.MOD_ACTIONS.ERASE.TYPE,
      [shared.MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.PAGE_UUID]: this.currentPageId,
      [shared.MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.ACTION_UUID]: actionUuid,
      [shared.MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.BEFORE_HASH]: this.verifiedHash,
      [shared.MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.PAYLOAD]: eraseAction
    };
    
    // Calculate what we think the hash will be
    const nextHash = shared.hashNext(this.verifiedHash, action[shared.MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.PAYLOAD]);
    
    // Add action to optimistic updates
    const optimisticAction = {
      [shared.MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.ACTION_UUID]: actionUuid,
      [shared.MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.PAYLOAD]: action[shared.MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.PAYLOAD],
      hashes: {
        [shared.MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.BEFORE_HASH]: this.verifiedHash,
        [shared.MESSAGES.SERVER_TO_CLIENT.ACCEPT_MESSAGE.AFTER_HASH]: nextHash
      }
    };
    
    this.optimisticUpdates.push(optimisticAction);
    this.renderCanvas();
    
    // Send to server
    this.networkManager.sendModAction(action);
  },
  
  addNewPage: function() {
    const newPageId = Utils.generateUuid();
    this.createNewPage(newPageId);
  },
  
  deletePage: function() {
    if (this.totalPages <= 1) {
      alert("Cannot delete the only page");
      return;
    }
    
    const action = {
      type: shared.MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.TYPE,
      [shared.MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.ACTION_TYPE]: shared.MOD_ACTIONS.DELETE_PAGE.TYPE,
      [shared.MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.PAGE_UUID]: this.currentPageId,
      [shared.MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.ACTION_UUID]: Utils.generateUuid(),
      [shared.MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.BEFORE_HASH]: this.verifiedHash,
      [shared.MESSAGES.CLIENT_TO_SERVER.MOD_ACTION_PROPOSALS.PAYLOAD]: {
        type: shared.MOD_ACTIONS.DELETE_PAGE.TYPE
      }
    };
    
    // Send to server
    this.networkManager.sendModAction(action);
  },
  
  navigateToPage: function(pageNumber) {
    if (pageNumber < 1 || pageNumber > this.totalPages) {
      return;
    }
    
    // Request the page from server
    const pageRequestMessage = {
      type: shared.MESSAGES.CLIENT_TO_SERVER.PAGE_REQUEST.TYPE,
      [shared.MESSAGES.CLIENT_TO_SERVER.PAGE_REQUEST.PAGE_NR]: pageNumber
    };
    
    this.networkManager.ws.send(JSON.stringify(pageRequestMessage));
  }
};

// Initialize the app when DOM is fully loaded
document.addEventListener('DOMContentLoaded', function() {
  App.init();
});
