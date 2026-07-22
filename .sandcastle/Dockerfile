FROM node:22-bookworm

# Install system dependencies
RUN apt-get update && apt-get install -y \
  git \
  curl \
  jq \
  && rm -rf /var/lib/apt/lists/*

# Install GitHub CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
  | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
  | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
  && apt-get update && apt-get install -y gh \
  && rm -rf /var/lib/apt/lists/*

# Enable pnpm via corepack (run as root, before the USER switch — corepack
# writes shims into a root-owned prefix). Pin matches rig's package.json
# `packageManager` field (pnpm@8.15.9).
RUN corepack enable && corepack prepare pnpm@8.15.9 --activate

# NOTE on rig's Git-to-TOON write-path native deps: rig pulls in `better-sqlite3`
# (a native addon) transitively, but it is declared in the root package.json's
# `pnpm.neverBuiltDependencies`, so pnpm never compiles it — no C toolchain
# needed. Its other heavy deps (`sharp`, `esbuild`) ship prebuilt binaries.
# Verified: a fresh `pnpm install --frozen-lockfile` + `pnpm -r build` complete
# in this stock image with no build-essential/python. So there is deliberately
# NOTHING extra to install here. If a future dep needs to compile from source,
# add `build-essential python3` to the apt block above (as root).

# Build-args for UID/GID alignment: sandcastle docker build-image
# defaults these to the host user's UID/GID so image-built files
# and bind-mounted files share an owner without runtime chown.
ARG AGENT_UID=1000
ARG AGENT_GID=1000

# Rename the base image's "node" user to "agent" and align UID/GID.
RUN groupmod -o -g $AGENT_GID node && usermod -o -u $AGENT_UID -g $AGENT_GID -d /home/agent -m -l agent node
USER ${AGENT_UID}:${AGENT_GID}

# Install Claude Code CLI
RUN curl -fsSL https://claude.ai/install.sh | bash

# Add Claude to PATH
ENV PATH="/home/agent/.local/bin:$PATH"

WORKDIR /home/agent

# In worktree sandbox mode, Sandcastle bind-mounts the git worktree at /home/agent/workspace
# and overrides the working directory to /home/agent/workspace at container start.
# Structure your Dockerfile so that /home/agent/workspace can serve as the project root.
ENTRYPOINT ["sleep", "infinity"]
