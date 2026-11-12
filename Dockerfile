FROM node:24 AS builder
WORKDIR /app
USER node
CMD ["npm", "start"]
