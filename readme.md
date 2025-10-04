# Kubux Whiteboard Server

A real-time collaborative whiteboard application designed for mathematics education and collaboration. This project provides a WebSocket-based server and browser client that enables multiple users to draw, annotate, and collaborate on a shared canvas in real-time.

![Kubux Whiteboard Demo](https://via.placeholder.com/800x400?text=Kubux+Whiteboard+Demo)

## Features

- **Real-time collaboration** - Multiple users can simultaneously work on the same whiteboard
- **Multi-page support** - Create and navigate between multiple pages in a whiteboard
- **Rich drawing tools** - Pen, highlighter, and chalk tools with customizable properties
- **Shape tools** - Draw circles, rectangles, horizontal/vertical/diagonal lines
- **Selection tools** - Rectangle, lasso, and stroke-based selection with cut/copy/paste
- **Layer system** - Organize content across 8 separate layers with visibility control
- **PDF export** - Export single pages or entire whiteboards as vector PDFs
- **Undo/redo** - Full history tracking with undo/redo capability
- **Optimized rendering** - Two-canvas approach for smooth performance

## Installation

### Prerequisites

- Node.js (v14 or higher)
- npm (v6 or higher)

### Setup

1. Clone the repository:
   ```bash
   git clone https://github.com/yourusername/kubux-whiteboard-server.git
   cd kubux-whiteboard-server
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Generate SSL certificates for secure WebSocket connections (optional):
   ```bash
   mkdir -p data/certs
   openssl req -nodes -new -x509 -keyout data/certs/server.key -out data/certs/server.cert
   ```

4. Start the server:
   ```bash
   npm start
   ```

5. Open the whiteboard in your browser:
   ```
   http://localhost:5236
   ```

## Usage

### Creating a New Whiteboard

1. Visit the server URL in your browser
2. You will be presented with a login screen or directly taken to a new board
3. Share the board URL with collaborators to work together

### Basic Controls

- **Drawing** - Select a drawing tool and draw directly on the canvas
- **Navigation** - Use the hand tool (✋) to pan around the canvas
- **Zooming** - Use the zoom controls or mouse wheel to zoom in/out
- **Undo/Redo** - Use the undo (↩) and redo (↪) buttons or keyboard shortcuts (Ctrl+Z, Ctrl+Y)
- **Page Management** - Add new pages, navigate between pages using the controls at the top

### Tool Options

- **Color** - Select from predefined colors or open the color picker for custom colors
- **Width** - Adjust the stroke width using the slider
- **Opacity** - Control transparency with the opacity slider
- **Shape Mode** - Toggle between freeform drawing and shape modes (rectangle, circle, etc.)

### Layers

- The whiteboard supports 8 separate drawing layers
- Toggle layer visibility using the eye icons
- Select active drawing layer using the layer buttons

### Selection and Clipboard

- Use the selection tools to select content
- Cut, copy, or move selected elements
- Move elements between layers
- Transform selections with scaling and rotation

## Technical Overview

### Architecture

The system uses a client-server architecture with WebSockets for real-time communication. The protocol is designed around an action-based model where each modification to the whiteboard is represented as an action that can be applied, undone, or redone.

Key components:
- **server.js** - WebSocket server handling client connections and message routing
- **shared.js** - Common code used by both client and server
- **index.html** - Web client interface with integrated JavaScript

### Protocol

The communication protocol between clients and the server uses:
- WebSockets for real-time data exchange
- JSON message format with support for complex data types
- Hash-chain verification for ensuring state consistency
- Optimistic local updates for responsive UI
- Replay mechanism for resolving inconsistencies

For detailed protocol documentation, see [protocol.md](protocol.md).

### Rendering

The client uses an optimized two-canvas rendering approach:
- Static background canvas for committed content
- Foreground canvas for interactive elements (current stroke, selection, etc.)
- Incremental updates when possible for better performance

## Development

### Project Structure

```
kubux-whiteboard-server/
├── server.js           # Main WebSocket server
├── shared.js           # Shared code between client and server
├── index.html          # Web client (HTML, CSS, and JavaScript)
├── protocol.md         # Protocol documentation
├── package.json        # Project configuration and dependencies
└── data/               # Data storage directory
    ├── certs/          # SSL certificates
    └── *.board/*.page  # Board and page data
```

### Adding New Features

When adding new features:

1. Update the shared.js file for any constants or utilities needed by both client and server
2. Modify server.js to handle any new message types or actions
3. Update index.html to add UI controls and client-side logic
4. Document the new feature in the appropriate documentation files

### Running Tests

Currently, the project does not include automated tests. Manual testing is required for new features and bug fixes.

## License

[Apache License 2.0](LICENSE) - This project is licensed under the Apache License 2.0. See the LICENSE file for the full license text.

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add some amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## Acknowledgements

- Inspired by [Xournal++](https://github.com/xournalpp/xournalpp), a handwriting note-taking software
- Uses WebSockets for real-time communication
- Implements the Model-Context Protocol for extensibility
