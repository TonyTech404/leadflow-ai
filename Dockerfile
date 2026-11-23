# Self-hosted image: the same API and web app as the Cloudflare deployment, on Node.
# docker compose up starts it with a local Postgres; see README.

FROM node:22-alpine AS build
WORKDIR /src
COPY package.json package-lock.json ./
COPY api/package.json api/
COPY web/package.json web/
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build -w web && npm run build -w api

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=8787 STATIC_DIR=/app/public
COPY --from=build /src/api/dist/ ./
COPY --from=build /src/web/dist/ ./public/
COPY db/migrations ./db/migrations
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:8787/api/health || exit 1
CMD ["sh", "-c", "node migrate.mjs && node server.mjs"]
