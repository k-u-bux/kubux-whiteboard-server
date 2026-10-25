FROM node:23 AS builder
WORKDIR /app
CMD ["npm", "start"]
