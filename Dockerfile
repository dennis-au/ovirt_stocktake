FROM node:22-bookworm-slim AS build

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build
RUN npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime

ARG VERSION=dev

RUN apt-get update \
    && apt-get install -y --no-install-recommends gosu \
    && rm -rf /var/lib/apt/lists/*

LABEL org.opencontainers.image.source="https://github.com/dennis-au/ovirt_stocktake"
LABEL org.opencontainers.image.version="${VERSION}"
LABEL org.opencontainers.image.description="oVirt/RHV inventory web app"

ENV NODE_ENV=production \
    OVIRT_INVENTORY_HOST=0.0.0.0 \
    OVIRT_INVENTORY_PORT=3000 \
    OVIRT_INVENTORY_ENV_FILE=/data/.env \
    OVIRT_INVENTORY_DB_PATH=/data/ovirt-inventory.sqlite

WORKDIR /app

COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

RUN chmod +x /usr/local/bin/docker-entrypoint.sh \
    && mkdir -p /data \
    && chown -R node:node /data /app

EXPOSE 3000
VOLUME ["/data"]

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "dist/server/server/main.js"]
