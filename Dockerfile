# syntax=docker/dockerfile:1
FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
# caminho padrao do banco SQLite (sobrescrito por DB_PATH no Coolify)
ENV DB_PATH=/app/data/users.db
# usuario nao-root
RUN groupadd -r app && useradd -r -g app -s /usr/sbin/nologin app
# diretório de dados gravável pelo usuário não-root
RUN mkdir -p /app/data && chown -R app:app /app/data
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY public ./public
USER app
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1
CMD ["node", "src/server.js"]