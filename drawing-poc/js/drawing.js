// Drawing manager handles canvas rendering
class DrawingManager {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.isDrawing = false;
    this.currentPath = [];
    this.zoomLevel = 1;
    
    // Default styles
    this.currentStyle = {
      penType: shared.PEN_TYPES.MARKER,
      color: "#000000",
      opacity: 1.0,
      width: 2.0,
      capStyle: shared.CAP_STYLES.ROUND,
      joinStyle: shared.JOIN_STYLES.ROUND,
      dashPattern: [0],
      pressureSensitivity: 1.0,
      tiltSensitivity: 0.0,
      layer: 1
    };
    
    // Smoothing settings
    this.enableSmoothing = true;
    this.smoothingFactor = 0.2;
    this.lastPoints = [];
    this.smoothingCount = 5;
  }
  
  setStyle(style) {
    this.currentStyle = { ...this.currentStyle, ...style };
  }
  
  setZoom(zoomLevel) {
    this.zoomLevel = zoomLevel;
    this.ctx.setTransform(zoomLevel, 0, 0, zoomLevel, 0, 0);
  }
  
  startDrawing(x, y, pressure, tilt) {
    this.isDrawing = true;
    this.currentPath = [];
    this.lastPoints = [];
    
    const point = {
      x: x / this.zoomLevel,
      y: y / this.zoomLevel,
      pressure: pressure || 1.0,
      tilt: tilt || { x: 0, y: 0 },
      timestamp: Date.now()
    };
    
    this.addPoint(point);
  }
  
  continueDrawing(x, y, pressure, tilt) {
    if (!this.isDrawing) return;
    
    const point = {
      x: x / this.zoomLevel,
      y: y / this.zoomLevel,
      pressure: pressure || 1.0,
      tilt: tilt || { x: 0, y: 0 },
      timestamp: Date.now()
    };
    
    this.addPoint(point);
  }
  
  addPoint(point) {
    // Apply smoothing if enabled
    if (this.enableSmoothing && this.currentPath.length > 0) {
      this.lastPoints.push(point);
      if (this.lastPoints.length > this.smoothingCount) {
        this.lastPoints.shift();
      }
      
      // Average the last few points for smoothing
      const smoothedPoint = { ...point };
      if (this.lastPoints.length > 1) {
        let sumX = 0, sumY = 0;
        for (const p of this.lastPoints) {
          sumX += p.x;
          sumY += p.y;
        }
        
        smoothedPoint.x = this.currentPath[this.currentPath.length - 1].x * (1 - this.smoothingFactor) + 
                           (sumX / this.lastPoints.length) * this.smoothingFactor;
        smoothedPoint.y = this.currentPath[this.currentPath.length - 1].y * (1 - this.smoothingFactor) + 
                           (sumY / this.lastPoints.length) * this.smoothingFactor;
      }
      
      this.currentPath.push(smoothedPoint);
    } else {
      this.currentPath.push(point);
    }
    
    this.redrawCurrentPath();
  }
  
  finishDrawing() {
    if (!this.isDrawing) return;
    this.isDrawing = false;
    
    // Return the completed stroke
    const stroke = {
      points: this.currentPath,
      style: this.currentStyle
    };
    
    this.currentPath = [];
    return stroke;
  }
  
  redrawCurrentPath() {
    if (this.currentPath.length < 2) return;
    
    const lastTwoPoints = this.currentPath.slice(-2);
    this.drawStrokePart(lastTwoPoints, this.currentStyle);
  }
  
  drawStrokePart(points, style) {
    if (points.length < 2) return;
    
    const ctx = this.ctx;
    ctx.save();
    
    // Apply style
    ctx.strokeStyle = style.color;
    ctx.lineWidth = style.width;
    
    if (style.penType === shared.PEN_TYPES.HIGHLIGHTER) {
      ctx.globalAlpha = 0.5; // Highlighters are semi-transparent
      ctx.lineJoin = shared.JOIN_STYLES.ROUND;
      ctx.lineCap = shared.CAP_STYLES.SQUARE;
    } else {
      ctx.globalAlpha = style.opacity;
      ctx.lineJoin = style.joinStyle;
      ctx.lineCap = style.capStyle;
    }
    
    if (style.dashPattern && style.dashPattern.length > 1) {
      ctx.setLineDash(style.dashPattern);
    } else {
      ctx.setLineDash([]);
    }
    
    // Start path
    ctx.beginPath();
    
    // Move to the first point
    ctx.moveTo(points[0].x, points[0].y);
    
    // Draw lines to all other points
    for (let i = 1; i < points.length; i++) {
      const point = points[i];
      const prevPoint = points[i - 1];
      
      // Apply pressure sensitivity if available
      if (style.pressureSensitivity > 0 && point.pressure !== undefined) {
        const pressureEffect = 1 + (point.pressure - 1) * style.pressureSensitivity;
        ctx.lineWidth = style.width * pressureEffect;
      }
      
      ctx.lineTo(point.x, point.y);
    }
    
    ctx.stroke();
    ctx.restore();
  }
  
  drawStroke(stroke) {
    if (!stroke || !stroke.points || stroke.points.length < 2) return;
    
    this.drawStrokePart(stroke.points, stroke.style);
  }
  
  clearCanvas() {
    this.ctx.save();
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.ctx.restore();
  }
  
  renderStrokes(strokes) {
    this.clearCanvas();
    
    // Group strokes by layer
    const strokesByLayer = {};
    for (const stroke of strokes) {
      const layer = stroke.style.layer || 0;
      if (!strokesByLayer[layer]) {
        strokesByLayer[layer] = [];
      }
      strokesByLayer[layer].push(stroke);
    }
    
    // Draw strokes in layer order (lower layers first)
    const layers = Object.keys(strokesByLayer).sort((a, b) => a - b);
    for (const layer of layers) {
      for (const stroke of strokesByLayer[layer]) {
        this.drawStroke(stroke);
      }
    }
  }
}
