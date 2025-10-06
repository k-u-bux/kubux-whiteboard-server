// Minimal Service Worker for PWA installation
// This worker does the bare minimum to enable PWA functionality
// while allowing the browser to handle all network requests normally.

self.addEventListener('install', (event) => {
  // Skip waiting to activate immediately
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  // Take control of all clients immediately
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  // Do nothing - let the browser handle all requests normally
  // This keeps the service worker active while being transparent to network operations
});
