# Stage 1: The Build Environment
# Use a specific version of Node.js for consistency
FROM node:20 AS builder

# Set the working directory
WORKDIR /app

# Install npm dependencies. Using 'npm ci' ensures a clean, reproducible install.
RUN npm ci

# Run the build script defined in your package.json
# This will compile your TypeScript files into JavaScript
# RUN npm run build

# The 'start' script will execute the server.js file
CMD ["npm", "start"]
