// Utility functions
const Utils = {
  // Generate a UUID (from shared.js)
  generateUuid: function() {
    return shared.generateUuid();
  },
  
  // Throttle function to limit execution rate
  throttle: function(func, limit) {
    let inThrottle;
    return function() {
      const args = arguments;
      const context = this;
      if (!inThrottle) {
        func.apply(context, args);
        inThrottle = true;
        setTimeout(() => inThrottle = false, limit);
      }
    };
  },
  
  // Debounce function for events that should wait until action completes
  debounce: function(func, wait) {
    let timeout;
    return function() {
      const context = this;
      const args = arguments;
      clearTimeout(timeout);
      timeout = setTimeout(() => func.apply(context, args), wait);
    };
  },
  
  // Log events to console in development
  log: function(category, message, data) {
    if (window.DEBUG) {
      console.log(`[${category}] ${message}`, data || '');
    }
  }
};
