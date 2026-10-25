# WhiteboardServer Project Outline

## Core Functionality
- Real-time collaboration: Multiple users can simultaneously draw and edit on the same canvas.
- Every user has their own view: user can be on different pages, have different zoom levels, different pans, different visible layers, etc.
- Every user has their own settings for drawing tools.
- State synchronization via WebSocket with hash chain verification.

## Advanced Drawing Features
- The overall UI/UX and drawing features will be modeled after Xournal++.
- Six pen slots, each remembering its own shape, color, width, opacity, and stroke style, plus an eraser.
- Customization of tools, including adjustable stroke size, color, and opacity.
- Tools for creating basic shapes like lines, rectangles, and circles.
- Layers: The ability to organize and control different elements of the drawing independently.
- Functionality for undoing and redoing actions.
- Advanced stroke controls: cap styles (round/butt/square), join styles (round/bevel/miter), dash patterns.
- Pressure sensitivity: adjustable sensitivity levels for variable-width strokes.
- Path modes: open paths, closed paths, and filled shapes.
- Selection tools: rectangle, lasso, and stroke-based selection.
- Clipboard operations: cut, copy, paste, and move selected elements.
- Interactive paste with affine transform controls (move, rotate, scale, shear).
- Multi-paste modes: place copies evenly along a path, line, circle, or in a grid.
- Canvas format presets (A4, Letter, Legal, 16:9, 16:10, 4:3, 3:2, 2:1, custom) with fit-width/fit-height zoom.
- Transform operations: scaling, rotation, and translation of selections.
- Eraser tool for removing drawn elements.
- Timer: a per-pen switch that erases each stroke drawn with that pen 3 seconds later (temporary annotations).

## Multi-Board Support
- Multiple independent whiteboards, each with its own set of pages and password.
- Board navigation overlay: switch between boards, copy shareable links, create new boards from within the app.
- Board creation requires a server-level credential (scrypt-hashed master password).
- Board-specific password for edit access; viewing possible without password (spectator mode).

## Multi-Page Support
- Each board can have multiple pages in an ordered list.
- Navigate pages via first/prev/next/last controls, or by clicking a thumbnail in the page overview.
- Add and delete pages (deleted pages redirect to a replacement).
- Page overview mode: thumbnail grid with drag-and-drop reordering, batch delete, and multi-page PDF export.
- Page reordering via shuffle proposals (validated against server state).
- Full page deletion mapping with redirect chains.

## Import/Export Features
- Exports: The ability to export the whiteboard's content as a PDF.
- Current-page export, and export of selected pages or the entire board from the overview (multi-page PDF).
- Vector rendering with FlateDecode compression.

## Progressive Web App (PWA)
- manifest.json for standalone app installation on tablets and mobile devices.
- Minimal service worker (sw.js) that enables installation; it caches nothing and passes all requests through to the network.
- Multiple icon sizes including apple-touch-icon for iOS.

## Protocol and Architecture (see protocol.md for details)
- WebSocket-based communication with plain JSON messages.
- Memory-hard authentication: scrypt hashing of the server-level credentials (board edit passwords are random strings stored with the board).
- Hash chain state verification with spaced snapshots for efficient synchronization.
- Optimistic updates with server authority and replay-based conflict resolution.
- Server: Node.js with dual-mode operation (direct or reverse proxy).
- Client: Single-page HTML/JS application with two-canvas rendering.