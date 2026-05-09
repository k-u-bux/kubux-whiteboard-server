# WhiteboardServer Project Outline

## Core Functionality
- Real-time collaboration: Multiple users can simultaneously draw and edit on the same canvas.
- Every user has their own view: user can be on different pages, have different zoom levels, different pans, different visible layers, etc.
- Every user has their own settings for drawing tools.
- State synchronization via WebSocket with hash chain verification.

## Advanced Drawing Features
- The overall UI/UX and drawing features will be modeled after Xournal++.
- A diverse set of drawing tools such as pens, markers, and highlighters.
- Customization of tools, including adjustable stroke size, color, and opacity.
- Tools for creating basic shapes like lines, rectangles, and circles.
- Layers: The ability to organize and control different elements of the drawing independently.
- Functionality for undoing and redoing actions.
- Advanced stroke controls: cap styles (round/butt/square), join styles (round/bevel/miter), dash patterns.
- Pressure sensitivity: adjustable sensitivity levels for variable-width strokes.
- Path modes: open paths, closed paths, and filled shapes.
- Selection tools: rectangle, lasso, and stroke-based selection.
- Clipboard operations: cut, copy, paste, and move selected elements.
- Transform operations: scaling, rotation, and translation of selections.
- Eraser tool for removing drawn elements.
- Timer for timed drawing sessions.

## Multi-Board Support
- Multiple independent whiteboards, each with its own set of pages and password.
- Board navigation overlay: switch between boards, copy shareable links, create new boards from within the app.
- Board creation requires a server-level credential (scrypt-hashed master password).
- Board-specific password for edit access; viewing possible without password (spectator mode).

## Multi-Page Support
- Each board can have multiple pages in an ordered list.
- Navigate pages via first/prev/next/last controls or jump-to-page menu.
- Add and delete pages (deleted pages redirect to a replacement).
- Full page deletion mapping with redirect chains.

## Import/Export Features
- Exports: The ability to export the whiteboard's content as a PDF.
- Single page export and entire board export (multi-page PDF).
- Vector rendering with FlateDecode compression.

## Progressive Web App (PWA)
- manifest.json for standalone app installation on tablets and mobile devices.
- Service worker (sw.js) for offline resource caching.
- Multiple icon sizes including apple-touch-icon for iOS.

## Protocol and Architecture (see protocol.md for details)
- WebSocket-based communication with JSON message format.
- Memory-hard authentication: scrypt password hashing.
- Hash chain state verification with spaced snapshots for efficient synchronization.
- Optimistic updates with server authority and replay-based conflict resolution.
- Server: Node.js with dual-mode operation (direct or reverse proxy).
- Client: Single-page HTML/JS application with two-canvas rendering.