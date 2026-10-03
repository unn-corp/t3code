# Pinned Node 24 / Debian image for the collaboration service.
FROM node:24.21.0-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6 AS build

ENV CI=true \
    ELECTRON_SKIP_BINARY_DOWNLOAD=1
WORKDIR /build
RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates git python3 make g++ \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global --ignore-scripts pnpm@11.10.0 \
    && npm cache clean --force

# Use the repository root as the context. Dockerfile.dockerignore excludes local
# configuration, credentials, state, and installed dependencies before upload.
COPY . .
RUN pnpm install --frozen-lockfile --filter 't3...' --filter @t3tools/monorepo --filter @t3tools/scripts \
    && pnpm exec vp run --filter t3 build \
    && node infra/team-service/stage-runtime.mjs /opt/t3-stage

FROM node:24.21.0-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6 AS runtime
ARG T3_TEAM_UID=1000
ARG T3_TEAM_GID=1000
LABEL ai.arcwright.team-service.profile="local-v1"
RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates git \
    && rm -rf /var/lib/apt/lists/* \
    && test "$T3_TEAM_UID" -gt 0 && test "$T3_TEAM_GID" -gt 0 \
    && groupmod --gid "$T3_TEAM_GID" node \
    && usermod --uid "$T3_TEAM_UID" --gid "$T3_TEAM_GID" node \
    && install -d -m 0700 -o "$T3_TEAM_UID" -g "$T3_TEAM_GID" /data

COPY --from=build /opt/t3-stage /opt/t3
COPY --chmod=0555 infra/team-service/entrypoint.sh /usr/local/bin/team-service-entrypoint

ENV NODE_ENV=production \
    T3CODE_HOME=/data \
    T3CODE_NO_BROWSER=true \
    T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD=false \
    XDG_CACHE_HOME=/tmp/cache
USER ${T3_TEAM_UID}:${T3_TEAM_GID}
WORKDIR /opt/t3
# This imports the actual release bundle and its native dependency closure.
RUN node dist/bin.mjs --help > /dev/null
EXPOSE 3910
ENTRYPOINT ["/usr/local/bin/team-service-entrypoint"]
CMD ["node", "dist/bin.mjs", "team-service", "--base-dir", "/data", "--host", "0.0.0.0", "--port", "3910"]
