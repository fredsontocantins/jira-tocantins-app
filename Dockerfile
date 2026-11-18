# syntax=docker/dockerfile:1
FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

FROM node:22-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV DB_PATH=/app/data/users.db
# Run as root to avoid permission issues with SQLite and mounted volumes
# (Development environment - not recommended for production)
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY public ./public
EXPOSE 3000
CMD ["node", "src/server.js"]