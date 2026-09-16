# The rig coordinator image (#125): rig + act + a Docker client, so
# `rig ci serve` can run a repo's GitHub-Actions-syntax workflows on Docker
# and publish NIP-C1 results as paid relay writes from its own identity.
#
# Build from the WORKSPACE ROOT (the pnpm lockfile lives there):
#
#   docker build -f packages/rig/Dockerfile -t rig-ci .
#
# Run with the host's Docker socket mounted — act launches every job as a
# container on the daemon behind that socket (there is no Docker daemon in
# this image), and with a persistent state volume for the coordinator's
# identity, channel watermarks, cursor, and secret inventory:
#
#   docker run --rm \
#     -v /var/run/docker.sock:/var/run/docker.sock \
#     -v rig-ci-state:/state \
#     -e RIG_MNEMONIC='<the coordinator phrase>' \
#     -e TOON_CONNECTOR=https://<connector> \
#     -e RIG_ARWEAVE_GATEWAY=https://<gateway> \
#     rig-ci ci serve --relay wss://<relay> --repo <owner>/<repo-id>
#
# Every environment variable rig honours means the same here (TOON_CLIENT_*,
# RIG_*); RIG_ARWEAVE_GATEWAY (or --gateway) is both where log links point and
# the first gateway the coordinator reads objects through. Against the sandbox
# on the same host add `--network host` and use its localhost addresses: a
# client dials the endpoint a node ADVERTISES, and the sandbox hub advertises
# http://127.0.0.1:3200/ilp (sandbox-only). The README's "Packaging" section
# has the full sandbox command.
#
# Later this image is what a TOON workload spawns (TOON_Network #14 asks the
# provider for a docker capability for exactly this reason): the coordinator
# becomes a leased workload whose runner is the lease's own Docker.
#
# Pinned to linux/amd64: the act and docker-cli tarballs below are
# checksum-verified for that architecture only.

# ---------------------------------------------------------------------------
# Stage 1: build @toon-protocol/rig from the workspace
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS build

RUN corepack enable && corepack prepare pnpm@8.15.9 --activate

WORKDIR /src

# Manifests first so the dependency layer caches across source edits. rig-web's
# manifest is copied only because the lockfile describes the whole workspace;
# the `...` filter installs rig and its dependencies alone.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc tsconfig.json ./
COPY packages/rig/package.json packages/rig/
COPY packages/rig-web/package.json packages/rig-web/
RUN pnpm install --frozen-lockfile --filter @toon-protocol/rig...

COPY packages/rig packages/rig
RUN pnpm --filter @toon-protocol/rig build

# Prune to production dependencies in place. (`pnpm deploy` would produce a
# self-contained copy, but it re-links every package one by one and is far
# slower than pruning the already-linked workspace; the runtime image copies
# the workspace tree with its pnpm symlinks intact.)
RUN pnpm install --prod --frozen-lockfile --offline --filter @toon-protocol/rig... \
 && rm -rf packages/rig/src

# ---------------------------------------------------------------------------
# Stage 2: runtime — node, git, the docker CLI, act, and rig on PATH
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim

# git: the coordinator materializes commits through git plumbing and act
# reads the checkout. ca-certificates + curl: the two downloads below.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*

# The Docker CLI only (static build; the daemon is the host's, via the socket).
ARG DOCKER_VERSION=27.5.1
ARG DOCKER_SHA256=4f798b3ee1e0140eab5bf30b0edc4e84f4cdb53255a429dc3bbae9524845d640
RUN curl -fsSL "https://download.docker.com/linux/static/stable/x86_64/docker-${DOCKER_VERSION}.tgz" -o /tmp/docker.tgz \
 && echo "${DOCKER_SHA256}  /tmp/docker.tgz" | sha256sum -c - \
 && tar -xzf /tmp/docker.tgz -C /tmp docker/docker \
 && install -m 0755 /tmp/docker/docker /usr/local/bin/docker \
 && rm -rf /tmp/docker /tmp/docker.tgz

# act: the runner family rig's coordinator advertises. 0.2.89 is the version
# the act-runner test was verified against (src/ci/act-runner.test.ts).
ARG ACT_VERSION=0.2.89
ARG ACT_SHA256=0191d6f1f3b716b5c55820032605d05fc3c1cdbf581ebeff655019e5dd1524c0
RUN curl -fsSL "https://github.com/nektos/act/releases/download/v${ACT_VERSION}/act_Linux_x86_64.tar.gz" -o /tmp/act.tgz \
 && echo "${ACT_SHA256}  /tmp/act.tgz" | sha256sum -c - \
 && tar -xzf /tmp/act.tgz -C /tmp act \
 && install -m 0755 /tmp/act /usr/local/bin/act \
 && rm -f /tmp/act /tmp/act.tgz

COPY --from=build /src /app
RUN chmod +x /app/packages/rig/dist/cli/rig.js \
 && ln -s /app/packages/rig/dist/cli/rig.js /usr/local/bin/rig

# Everything rig persists (identity keystore, channel watermarks, the
# coordinator's cursor + secret inventory under rig-ci/<pubkey>/) lives here.
ENV TOON_CLIENT_HOME=/state
VOLUME ["/state"]
WORKDIR /work

ENTRYPOINT ["rig"]
CMD ["ci", "serve", "--help"]
