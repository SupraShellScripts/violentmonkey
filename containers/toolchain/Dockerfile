# syntax=docker/dockerfile:1.7

FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d

ARG PNPM_VERSION=11.17.0

LABEL org.opencontainers.image.title="Violentmonkey stateless toolchain" \
      org.opencontainers.image.description="Container-only lint, test, and build environment for the Violentmonkey fork" \
      org.opencontainers.image.source="https://github.com/SupraShellScripts/violentmonkey" \
      org.opencontainers.image.licenses="MIT" \
      io.suprashellscripts.toolchain.node="24.18.0" \
      io.suprashellscripts.toolchain.pnpm="${PNPM_VERSION}"

ENV CI=1 \
    HUSKY=0 \
    PNPM_HOME=/opt/pnpm \
    PNPM_STORE_DIR=/opt/pnpm/store \
    PATH=/opt/pnpm:$PATH

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates \
      git \
      jq \
      rsync \
      unzip \
      zip \
 && rm -rf /var/lib/apt/lists/* \
 && npm install --global "pnpm@${PNPM_VERSION}" \
 && test "$(pnpm --version)" = "${PNPM_VERSION}"

WORKDIR /opt/violentmonkey

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

# Lifecycle scripts are intentionally disabled here. The root preinstall invokes
# an unpinned npx helper, while this image needs only lockfile-defined packages.
# The upstream pnpm policy already disables dependency build scripts used here.
RUN pnpm install --frozen-lockfile --ignore-scripts \
 && sha256sum package.json pnpm-lock.yaml pnpm-workspace.yaml \
      > /opt/violentmonkey/dependency-inputs.sha256

COPY containers/toolchain/entrypoint.sh /usr/local/bin/vm-toolchain

RUN chmod 0555 /usr/local/bin/vm-toolchain \
 && mkdir -p /input /work /output /tmp/vm-home \
 && chmod 0777 /input /work /output /tmp/vm-home

ENV HOME=/tmp/vm-home
USER node
WORKDIR /work

ENTRYPOINT ["/usr/local/bin/vm-toolchain"]
CMD ["ci"]
