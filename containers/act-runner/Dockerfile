# syntax=docker/dockerfile:1.7

FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d

LABEL org.opencontainers.image.title="Violentmonkey local act runner" \
      org.opencontainers.image.description="Locally built runner image for nektos/act" \
      org.opencontainers.image.source="https://github.com/SupraShellScripts/violentmonkey" \
      org.opencontainers.image.licenses="MIT"

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      bash \
      ca-certificates \
      docker.io \
      git \
      jq \
      openssh-client \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace
