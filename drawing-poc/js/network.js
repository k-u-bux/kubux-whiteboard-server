// Network manager handles WebSocket communication
class NetworkManager {
  constructor() {
    this.ws = null;
    this.boardId = null;
    this.connected = false;
    this.handlers = {
      connect: [],
      disconnect: [],
      accept: [],
      decline: [],
      replay: [],
      fullPage: []
    };
  }
  
  connect(boardId) {
    this.boardId = boardId;
    
    const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${wsProtocol}//${window.location.host}/ws/${this.boardId}`;
    
    this.ws = new WebSocket(wsUrl);
    
    this.ws.onopen = () => {
      Utils.log('Network', 'Connected to server');
      this.connected = true;
      this._triggerHandlers('connect');
    };
    
    this.ws.onclose = () => {
      Utils.log('Network', 'Disconnected from server');
      this.connected = false;
      this._triggerHandlers('disconnect');
    };
    
    this.ws.onerror = (error) => {
      Utils.log('Network', 'WebSocket error', error);
    };
    
    this.ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      Utils.log('Network', 'Received message', data);
      
      switch (data.type) {
        case shared.MESSAGES.SERVER_TO_CLIENT.ACCEPT_MESSAGE.TYPE:
          this._triggerHandlers('accept', data);
          break;
        case shared.MESSAGES.SERVER_TO_CLIENT.DECLINE_MESSAGE.TYPE:
          this._triggerHandlers('decline', data);
          break;
        case shared.MESSAGES.SERVER_TO_CLIENT.REPLAY_MESSAGE.TYPE:
          this._triggerHandlers('replay', data);
          break;
        case shared.MESSAGES.SERVER_TO_CLIENT.FULL_PAGE.TYPE:
          this._triggerHandlers('fullPage', data);
          break;
      }
    };
  }
  
  on(event, handler) {
    if (this.handlers[event]) {
      this.handlers[event].push(handler);
    }
  }
  
  _triggerHandlers(event, data) {
    if (this.handlers[event]) {
      for (const handler of this.handlers[event]) {
        handler(data);
      }
    }
  }
  
  sendModAction(action) {
    if (!this.connected) return false;
    
    const message = JSON.stringify(action);
    this.ws.send(message);
    Utils.log('Network', 'Sent mod action', action);
    return true;
  }
  
  requestReplay(pageUuid, beforeHash) {
    if (!this.connected) return false;
    
    const replayMessage = {
      type: shared.MESSAGES.CLIENT_TO_SERVER.REPLAY_REQUESTS.TYPE,
      [shared.MESSAGES.CLIENT_TO_SERVER.REPLAY_REQUESTS.PAGE_UUID]: pageUuid,
      [shared.MESSAGES.CLIENT_TO_SERVER.REPLAY_REQUESTS.BEFORE_HASH]: beforeHash,
      [shared.MESSAGES.CLIENT_TO_SERVER.REPLAY_REQUESTS.REQUEST_ID]: Utils.generateUuid()
    };
    
    this.ws.send(JSON.stringify(replayMessage));
    Utils.log('Network', 'Requested replay', replayMessage);
    return true;
  }
  
  requestFullPage(pageUuid) {
    if (!this.connected) return false;
    
    const fullPageRequest = {
      type: shared.MESSAGES.CLIENT_TO_SERVER.FULL_PAGE_REQUESTS.TYPE,
      [shared.MESSAGES.CLIENT_TO_SERVER.FULL_PAGE_REQUESTS.PAGE_UUID]: pageUuid,
      [shared.MESSAGES.CLIENT_TO_SERVER.FULL_PAGE_REQUESTS.REQUEST_ID]: Utils.generateUuid()
    };
    
    this.ws.send(JSON.stringify(fullPageRequest));
    Utils.log('Network', 'Requested full page', fullPageRequest);
    return true;
  }
  
  disconnect() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
      this.connected = false;
    }
  }
}
