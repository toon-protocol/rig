# Rig

The **Rig** is TOON Protocol's git-to-TOON write path and its decentralized
control-plane frontend. It interprets Nostr events (NIP-34 git is its first
surface — not a GitHub clone) and gives them a browsable, forge-like UI, while
the core library builds the git objects and NIP-34 events that make repos
publishable to TOON.

This repository is a small pnpm workspace with two packages:

| Package | Name | Published | What it is |
| --- | --- | --- | --- |
| [`packages/rig`](packages/rig) | `@toon-protocol/rig` | ✅ npm | Git-to-TOON write-path core + `rig` CLI. Builds git objects and NIP-34 events for the Rig control plane. |
| [`packages/rig-web`](packages/rig-web) | `@toon-protocol/rig-web` | ❌ (deployed) | Browser control-plane frontend. Consumes `@toon-protocol/rig` and renders NIP-34 git events as a forge UI. Deployed to GitHub Pages. |

`rig-web` depends on `rig` internally (via `workspace:*`); everything else
(`@toon-protocol/client`, `@toon-protocol/core`, `@toon-protocol/arweave`,
`@toon-protocol/views`, `@toon-protocol/relay`) is consumed as a published npm
package.

## Develop

```bash
pnpm install          # install the workspace
pnpm -r build         # build both packages (rig, then rig-web)
pnpm -r test          # run all test suites
pnpm --filter @toon-protocol/rig-web dev   # run the frontend dev server
```

Requires Node `>=22` and pnpm `8.15.9` (see `packageManager`).

## Release

`@toon-protocol/rig` is released via [changesets](https://github.com/changesets/changesets).
Add a changeset with `pnpm changeset` when you change the package; merging to
`main` opens/updates a Release PR, and merging that publishes. `rig-web` is
private and deployed to GitHub Pages (`.github/workflows/deploy-rig-web.yml`),
not published to npm.

**Publishing provenance.** Versions `1.0.0` through `3.0.0` of
`@toon-protocol/rig` were published from the
[`toon-client`](https://github.com/toon-protocol/toon-client) monorepo, where
this package lived before extraction. This repository has not published to npm
yet; it becomes the publishing source at `3.1.0`. `packages/rig/package.json` is
pinned at `3.0.0` to match npm's `latest` so the first release cut here follows
on from the published history rather than re-minting an occupied version. See
[`packages/rig/CHANGELOG.md`](packages/rig/CHANGELOG.md).

## License

MIT © Jonathan Green
