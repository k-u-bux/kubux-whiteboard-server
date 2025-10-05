FROM node:20 AS builder
WORKDIR /app
RUN npm ci
CMD ["npm", "start"]
