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

# Copy package.json (for version info) and install only server dependencies
COPY --from=builder /app/package.json ./package-full.json
RUN node -e "const p=require('./package-full.json'); const s={type:'module',version:p.version,dependencies:{express:'^5.2.1','http-proxy':'^1.18.1',jsonwebtoken:'^9.0.3'}}; require('fs').writeFileSync('package.json',JSON.stringify(s))" \
    && rm package-full.json && npm install --production

# Copy compiled frontend and server
COPY --from=builder /app/dist ./dist
COPY memory-server.js .

EXPOSE 3001
ENV PORT=3001 \
    NODE_ENV=production \
    OPENCLAW_PORT=18789 \
    FIREBASE_PROJECT_ID=silos-4352a

CMD ["node", "memory-server.js"]
