// UI manager handles user interactions
class UIManager {
  constructor(drawingManager, networkManager) {
    this.drawingManager = drawingManager;
    this.networkManager = networkManager;
    this.canvas = document.getElementById('canvas');
    this.canvasContainer = document.getElementById('canvas-container');
    this.zoomSlider = document.getElementById('zoom-slider');
    this.zoomLevelDisplay = document.getElementById('zoom-level');
    this.pageInfo = document.getElementById('page-info');
    this.cursorPosition = document.getElementById('cursor-position');
    
    this.currentTool = 'pen';
    this.zoomLevel = 1;
    
    this.setupEventListeners();
  }
  
  setupEventListeners() {
    // Tool selection
    document.getElementById('pen-tool').addEventListener('click', () => this.setTool('pen'));
    document.getElementById('eraser-tool').addEventListener('click', () => this.setTool('eraser'));
    document.getElementById('highlighter-tool').addEventListener('click', () => this.setTool('highlighter'));
    
    // Color selection
    const colorSwatches = document.querySelectorAll('.color-swatch');
    colorSwatches.forEach(swatch => {
      swatch.addEventListener('click', () => {
        colorSwatches.forEach(s => s.classList.remove('active'));
        swatch.classList.add('active');
        this.setColor(swatch.dataset.color);
      });
    });
    
    // Width selection
    const widthOptions = document.querySelectorAll('.width-option');
    widthOptions.forEach(option => {
      option.addEventListener('click', () => {
        widthOptions.forEach(o => o.classList.remove('active'));
        option.classList.add('active');
        this.setWidth(parseFloat(option.dataset.width));
      });
    });
    
    // Zoom controls
    document.getElementById('zoom-in').addEventListener('click', () => this.adjustZoom(0.1));
    document.getElementById('zoom-out').addEventListener('click', () => this.adjustZoom(-0.1));
    this.zoomSlider.addEventListener('input', () => {
      const zoomValue = parseInt(this.zoomSlider.value) / 100;
      this.setZoom(zoomValue);
    });
    
    // Page navigation
    document.getElementById('prev-page').addEventListener('click', () => {
      App.navigateToPage(App.pageNr - 1);
    });
    
    document.getElementById('next-page').addEventListener('click', () => {
      App.navigateToPage(App.pageNr + 1);
    });
    
    document.getElementById('add-page').addEventListener('click', () => {
      App.addNewPage();
    });
    
    document.getElementById('delete-page').addEventListener('click', () => {
      App.deletePage();
    });

    // Canvas events
    this.canvas.addEventListener('pointerdown', this.handlePointerDown.bind(this));
    this.canvas.addEventListener('pointermove', this.handlePointerMove.bind(this));
    this.canvas.addEventListener('pointerup', this.handlePointerUp.bind(this));
    this.canvas.addEventListener('pointerleave', this.handlePointerUp.bind(this));
    
    // Display cursor position
    this.canvas.addEventListener('mousemove', this.updateCursorPosition.bind(this));
    
    // Prevent default touch behaviors
    this.canvas.addEventListener('touchstart', e => e.preventDefault());
    this.canvas.addEventListener('touchmove', e => e.preventDefault());
    this.canvas.addEventListener('touchend', e => e.preventDefault());
  }
  
  setTool(tool) {
    this.currentTool = tool;
    
    // Update UI
    document.querySelectorAll('.tool-btn').forEach(btn => btn.classList.remove('active'));
    document.getElementById(`${tool}-tool`).classList.add('active');
    
    // Set appropriate styles for the tool
    switch (tool) {
      case 'pen':
        this.drawingManager.setStyle(shared.STROKE_STYLES.PEN);
        break;
      case 'highlighter':
        this.drawingManager.setStyle(shared.STROKE_STYLES.HIGHLIGHTER);
        break;
      case 'eraser':
        // Eraser logic will be handled differently
        break;
    }
    
    // Update cursor
    switch (tool) {
      case 'pen':
        this.canvas.style.cursor = 'url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'24\' height=\'24\' viewBox=\'0 0 24 24\'%3E%3Cpath d=\'M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25z\'/%3E%3C/svg%3E") 0 24, auto';
        break;
      case 'highlighter':
        this.canvas.style.cursor = 'url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'24\' height=\'24\' viewBox=\'0 0 24 24\'%3E%3Cpath d=\'M10.5 13H8v-3h2.5V7.5h3V10H16v3h-2.5v2.5h-3V13z\'/%3E%3C/svg%3E") 0 24, auto';
        break;
      case 'eraser':
        this.canvas.style.cursor = 'url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'24\' height=\'24\' viewBox=\'0 0 24 24\'%3E%3Cpath d=\'M15.14 3c-.51 0-1.02.2-1.41.59L2.59 14.73c-.78.77-.78 2.04 0 2.83L5.03 20h7.66l8.72-8.72c.79-.78.79-2.05 0-2.83l-4.85-4.86c-.39-.39-.9-.59-1.42-.59z\'/%3E%3C/svg%3E") 0 24, auto';
        break;
    }
  }
  
  setColor(color) {
    const style = { color };
    this.drawingManager.setStyle(style);
    
    // Update color swatch previews
    document.querySelectorAll('.width-preview').forEach(preview => {
      preview.style.backgroundColor = color;
    });
  }
  
  setWidth(width) {
    const style = { width };
    this.drawingManager.setStyle(style);
  }
  
  setZoom(zoomLevel) {
    this.zoomLevel = zoomLevel;
    this.drawingManager.setZoom(zoomLevel);
    this.zoomLevelDisplay.textContent = `${Math.round(zoomLevel * 100)}%`;
    this.zoomSlider.value = Math.round(zoomLevel * 100);
  }
  
  adjustZoom(delta) {
    const newZoom = Math.max(0.5, Math.min(2, this.zoomLevel + delta));
    this.setZoom(newZoom);
  }
  
  updateCursorPosition(event) {
    const rect = this.canvas.getBoundingClientRect();
    const x = Math.round((event.clientX - rect.left) / this.zoomLevel);
    const y = Math.round((event.clientY - rect.top) / this.zoomLevel);
    this.cursorPosition.textContent = `(${x}, ${y})`;
  }
  
  handlePointerDown(event) {
    const rect = this.canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const pressure = event.pressure !== undefined ? event.pressure : 1.0;
    const tilt = { x: event.tiltX || 0, y: event.tiltY || 0 };
    
    if (this.currentTool === 'eraser') {
      // For eraser, we'll send erase actions on pointer move
      this.isErasing = true;
      this.lastEraseX = x;
      this.lastEraseY = y;
    } else {
      this.drawingManager.startDrawing(x, y, pressure, tilt);
    }
  }
  
  handlePointerMove(event) {
    const rect = this.canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const pressure = event.pressure !== undefined ? event.pressure : 1.0;
    const tilt = { x: event.tiltX || 0, y: event.tiltY || 0 };
    
    if (this.currentTool === 'eraser' && this.isErasing) {
      // Don't send erase actions for every pixel to avoid flooding
      const dx = x - this.lastEraseX;
      const dy = y - this.lastEraseY;
      const distance = Math.sqrt(dx * dx + dy * dy);
      
      // Only send erase action if we've moved enough
      if (distance > 10) {
        const eraseAction = this.drawingManager.eraseStrokeAt(x, y, 20); // 20px erase radius
        App.sendEraseAction(eraseAction);
        this.lastEraseX = x;
        this.lastEraseY = y;
      }
    } else if (this.drawingManager.isDrawing) {
      this.drawingManager.continueDrawing(x, y, pressure, tilt);
    }
  }
  
  handlePointerUp(event) {
    if (this.currentTool === 'eraser') {
      this.isErasing = false;
    } else if (this.drawingManager.isDrawing) {
      const stroke = this.drawingManager.finishDrawing();
      if (stroke && stroke.points.length >= 2) {
        App.sendStroke(stroke);
      }
    }
  }
  
  updatePageInfo(pageNumber, totalPages) {
    this.pageInfo.textContent = `Page ${pageNumber} of ${totalPages}`;
  }
}
