ARG NODE_IMAGE=node:22-slim
FROM ${NODE_IMAGE} AS base
LABEL org.opencontainers.image.source="https://github.com/docmost/docmost"

ARG NPM_REGISTRY=
RUN if [ -n "$NPM_REGISTRY" ]; then npm config set --global registry "$NPM_REGISTRY"; fi \
  && npm install -g pnpm@10.4.0 \
  && if [ -n "$NPM_REGISTRY" ]; then pnpm config set --global registry "$NPM_REGISTRY"; fi

FROM base AS builder

WORKDIR /app
ARG DOCMOST_PUBLIC_PATH_PREFIX=
ENV DOCMOST_PUBLIC_PATH_PREFIX=${DOCMOST_PUBLIC_PATH_PREFIX}

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml nx.json .npmrc ./
COPY patches ./patches
COPY apps/server/package.json ./apps/server/package.json
COPY apps/client/package.json ./apps/client/package.json
COPY packages/editor-ext/package.json ./packages/editor-ext/package.json
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm build

FROM base AS installer

RUN apt-get \
    -o Acquire::Retries=5 \
    -o Acquire::http::Timeout=30 \
    update \
  && apt-get \
    -o Acquire::Retries=5 \
    -o Acquire::http::Timeout=30 \
    install -y --no-install-recommends curl bash \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy apps
COPY --from=builder /app/apps/server/dist /app/apps/server/dist
COPY --from=builder /app/apps/client/dist /app/apps/client/dist
COPY --from=builder /app/apps/server/package.json /app/apps/server/package.json

# Copy packages
COPY --from=builder /app/packages/editor-ext/dist /app/packages/editor-ext/dist
COPY --from=builder /app/packages/editor-ext/package.json /app/packages/editor-ext/package.json

# Copy root package files
COPY --from=builder /app/package.json /app/package.json
COPY --from=builder /app/pnpm*.yaml /app/
COPY --from=builder /app/.npmrc /app/.npmrc

# Copy patches
COPY --from=builder /app/patches /app/patches

RUN chown -R node:node /app

USER node

RUN pnpm install --frozen-lockfile --prod

USER root

RUN mkdir -p /app/data/storage
RUN chown -R node:node /app/data

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

VOLUME ["/app/data/storage"]

EXPOSE 3000

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["pnpm", "start"]
