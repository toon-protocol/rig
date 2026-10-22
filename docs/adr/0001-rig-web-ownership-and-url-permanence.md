# ADR-0001: rig-web ownership and URL permanence

## Status

Accepted (2026-07-25). Amended 2026-10-22 for the rig sunset (rig#261): the
pointer pages and both Pages sites are frozen. See "Amendment: frozen at
sunset" below.

## Context

`rig-web` existed in two repos at once after the 2026-07-21 extraction of
`rig` from `toon-client`: `toon-client` kept its original copy (deployed,
green, serving `https://toon-protocol.github.io/toon-client/`), and `rig`
carried a second copy whose own `deploy-rig-web.yml` was red — GitHub Pages
had never been enabled on the `rig` repo. The extraction was incomplete,
not broken.

Separately, `packages/rig/src/rig-pointer.ts` bakes
`DEFAULT_RIG_WEB_URL` into every pointer HTML page that `rig push`
generates and uploads to Arweave. Arweave storage is permanent and
content-addressed: once a pointer is uploaded, its bytes — including
whatever URL was baked in at push time — cannot be changed or deleted.
Every repo pushed before this decision already has pointers on Arweave
linking to `https://toon-protocol.github.io/toon-client`.

## Decision

1. **`rig` owns `rig-web`.** The `toon-client` copy of `packages/rig-web`
   and its `deploy-rig-web.yml` are deleted (tracked as a companion change
   in the `toon-client` repo, since this repo's tooling cannot open a PR
   there). `rig`'s own `deploy-rig-web.yml` publishes to
   `https://toon-protocol.github.io/rig/`.

2. **`/toon-client/` becomes a permanent redirect.** `toon-client`'s Pages
   site stops serving the full SPA and instead serves a minimal static
   page that redirects to `https://toon-protocol.github.io/rig/`,
   preserving the URL fragment (`#/<npub>/<repo>?relay=…`). rig-web is a
   `HashRouter` app and pointers carry state in the fragment, so a redirect
   that drops it would break exactly the already-published links it exists
   to save.

3. **`DEFAULT_RIG_WEB_URL` now points at `/rig`.** New pointers, from this
   point forward, embed `https://toon-protocol.github.io/rig` as their
   fallback link. This is a behavior change to what `rig push` writes, so
   it ships with a changeset (`@toon-protocol/rig`, minor).

## Consequences

- **The `/toon-client/` redirect stub can never be deleted.** Every
  pointer pushed before this ADR — an unbounded, permanent set living on
  Arweave — links to `toon-protocol.github.io/toon-client`. Removing the
  stub or letting GitHub Pages lapse on `toon-client` 404s those pointers'
  fallback links forever. This is not a migration with an end date; it is
  a standing obligation the moment the first pointer referencing that URL
  was uploaded.
- New pointers (post-ADR) fall back to `/rig`; old pointers keep working
  only as long as the redirect stub is served.
- Ownership of `rig-web` source, CI, and Pages deploy configuration lives
  solely in `rig` going forward. `toon-client` retains only the redirect
  stub.

## Amendment: frozen at sunset (2026-10-22)

rig is being sunset (rig#261, plan in toon-protocol/relay#276). The relay's
`/repo` UI replaces rig-web, and the TOON clients plus the `git` skill replace
`rig push`. Once rig is archived, no new pointers are written. The pointers
already on Arweave stay there, because Arweave cannot delete them.

Everything a published pointer depends on is **frozen**: still readable, no
longer maintained. That covers:

- **The pointer pages on Arweave.** Each one boots the rig-web deployment
  whose manifest txId was baked in at push time. Those deployments are
  permanent too, so a pointer keeps rendering the repo it was pushed for,
  through whatever gateway still serves it.
- **`https://toon-protocol.github.io/rig/`**, the fallback link in pointers
  pushed after this ADR. It keeps serving the last rig-web build deployed
  before the archive.
- **The `/toon-client/` redirect stub**, the fallback link in pointers pushed
  before this ADR. The standing obligation above does not change: it is still
  never deleted.

"Frozen" means:

- Nobody fixes bugs, updates dependencies, or follows NIP-34 or NIP-C1
  changes in these pages. If the relay's event shapes move on, a frozen
  pointer can show stale or partial data. That is accepted.
- Neither Pages site is unpublished, and neither the `rig` nor the
  `toon-client` repo is deleted. Archiving a repo is fine: GitHub keeps
  serving an archived repo's Pages site, but deleting the repo or disabling
  Pages 404s every fallback link at once.
- Nothing is pointed elsewhere silently. Redirecting `/rig/` or
  `/toon-client/` to the relay's `/repo` would need its own decision,
  because `/repo` URLs do not use rig-web's `#/<npub>/<repo>?relay=…`
  fragment and a naive redirect would drop the state that pointers carry.
