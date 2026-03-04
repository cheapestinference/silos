# Build stage — compile React frontend
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# Runtime stage — Node.js with memory-server.js + compiled frontend
FROM node:20-alpine
WORKDIR /app

# Install only server production dependencies
RUN echo '{"type":"module","dependencies":{"express":"^5.2.1","http-proxy":"^1.18.1","jsonwebtoken":"^9.0.3"}}' \
    > package.json && npm install --production

# Copy compiled frontend and server
COPY --from=builder /app/dist ./dist
COPY memory-server.js .

EXPOSE 3001
ENV PORT=3001 \
    NODE_ENV=production \
    OPENCLAW_PORT=18789 \
    FIREBASE_PROJECT_ID=silos-4352a

CMD ["node", "memory-server.js"]
