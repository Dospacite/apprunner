# syntax=docker/dockerfile:1

# ── deps ────────────────────────────────────────────────────────────────────
FROM node:22.14-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
# better-sqlite3 ships glibc prebuilds; python3/make/g++ are the fallback path.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && npm install --omit=dev --no-audit --no-fund \
 && apt-get purge -y python3 make g++ \
 && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/*

# ── runtime ─────────────────────────────────────────────────────────────────
FROM node:22.14-bookworm-slim AS runtime
ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data
WORKDIR /app

# tar/unzip are used to validate and inspect uploaded project archives.
RUN apt-get update \
 && apt-get install -y --no-install-recommends tar gzip unzip ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY public ./public

RUN mkdir -p /data && chown -R node:node /data /app
USER node

EXPOSE 8080

# tini reaps zombies and forwards SIGTERM so the graceful shutdown path runs.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "src/index.js"]
