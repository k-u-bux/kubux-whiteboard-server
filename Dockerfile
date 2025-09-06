# Stage 1: The Build Environment
# Use a specific version of Node.js for consistency
FROM node:20 AS builder

# Set the working directory
WORKDIR /app

# Copy the package manifests first to leverage Docker's build cache
COPY package.json package-lock.json ./

# Install npm dependencies. Using 'npm ci' ensures a clean, reproducible install.
RUN npm ci

# Copy the rest of the source code
COPY . .

# Run the build script defined in your package.json
# This will compile your TypeScript files into JavaScript
# RUN npm run build

# Stage 2: The Final, Minimal Container
# Use a smaller base image that only contains the Node.js runtime
FROM node:20-slim

# Set the working directory
WORKDIR /app

# Copy the built application and its node_modules from the builder stage
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/server.js ./server.js

# The 'start' script will execute the server.js file
CMD ["npm", "start"]