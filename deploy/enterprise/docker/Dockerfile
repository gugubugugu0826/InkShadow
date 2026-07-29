# The caller must provide an immutable Node image reference containing @sha256:<64 hex>.
# Example:
# docker build --build-arg INKSHADOW_NODE_IMAGE=node:24-bookworm-slim@sha256:<verified-digest> ...
ARG INKSHADOW_NODE_IMAGE

FROM ${INKSHADOW_NODE_IMAGE} AS build
ARG INKSHADOW_NODE_IMAGE
WORKDIR /workspace
COPY . .
RUN node -e "if (!/@sha256:[a-f0-9]{64}$/u.test(process.argv[1] ?? '')) process.exit(1)" "${INKSHADOW_NODE_IMAGE}" \
  && corepack enable \
  && corepack prepare pnpm@11.13.0 --activate \
  && pnpm install --frozen-lockfile \
  && pnpm --filter @inkshadow/cloud-api build

FROM ${INKSHADOW_NODE_IMAGE} AS production-dependencies
WORKDIR /workspace
COPY . .
RUN corepack enable \
  && corepack prepare pnpm@11.13.0 --activate \
  && pnpm install --frozen-lockfile --prod --filter @inkshadow/cloud-api... --ignore-scripts

FROM ${INKSHADOW_NODE_IMAGE} AS runtime
ENV NODE_ENV=production
WORKDIR /workspace/apps/cloud-api
COPY --from=production-dependencies --chown=10001:10001 /workspace/node_modules /workspace/node_modules
COPY --from=production-dependencies --chown=10001:10001 /workspace/apps/cloud-api/node_modules ./node_modules
COPY --from=production-dependencies --chown=10001:10001 /workspace/packages/access-core /workspace/packages/access-core
COPY --from=production-dependencies --chown=10001:10001 /workspace/packages/contracts /workspace/packages/contracts
COPY --from=build --chown=10001:10001 /workspace/apps/cloud-api/dist ./dist
COPY --from=build --chown=10001:10001 /workspace/apps/cloud-api/migrations ./migrations
COPY --from=build --chown=10001:10001 /workspace/apps/cloud-api/package.json ./package.json
USER 10001:10001
EXPOSE 8787
ENTRYPOINT ["node", "dist/cloud-api.mjs"]
