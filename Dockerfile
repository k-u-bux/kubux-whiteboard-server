FROM node:20 AS builder
WORKDIR /app
CMD ["npm", "start"]
