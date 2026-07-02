# syntax=docker/dockerfile:1
FROM neond/neond@sha256:e94082a476cb348daa59c960e2ce6f279cd7f745ab34ebee5562ae5bf97dafd7 AS neon-binaries

FROM node:22-bookworm-slim
# Runtime libs the neon binaries + postgres need (oracle: neond Dockerfile runtime stage)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl libssl3 libpq5 libreadline8 libseccomp2 libcurl4 \
    libicu72 zlib1g liblz4-1 libzstd1 libxml2 libkrb5-3 libuuid1 \
    && rm -rf /var/lib/apt/lists/*
COPY --from=neon-binaries /usr/local/share/neon /usr/local/share/neon
ENV NEON_BINARIES_DIR=/usr/local/share/neon/bin \
    PG_INSTALL_DIR=/usr/local/share/neon/pg_install \
    DEVDB_DATA_DIR=/data \
    DEVDB_HTTP_PORT=4400 \
    DEVDB_PORT_RANGE=54300-54339
RUN corepack enable && mkdir -p /data /app && chown -R node:node /data /app
WORKDIR /app
COPY --chown=node:node package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc tsconfig.base.json ./
COPY --chown=node:node packages ./packages
USER node
RUN pnpm install --frozen-lockfile && pnpm -r build
COPY --chown=node:node docker/verify-binaries.sh /usr/local/bin/verify-binaries.sh
RUN bash /usr/local/bin/verify-binaries.sh
EXPOSE 4400 54300-54339
CMD ["node", "packages/daemon/dist/index.js"]
