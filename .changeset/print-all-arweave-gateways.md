---
'@toon-protocol/rig': patch
---

Print every Arweave gateway from the shared list, and take the default from it

The Rig-page link is the one URL a user clicks after a push, and it was
hardcoded to `ar-io.dev` with a single printed alternate. A gateway can be
flat DOWN rather than merely behind: observed 2026-08-15, `ar-io.dev`
answered `503` on its own root while a freshly pushed page was `404` on
`arweave.net` (not yet indexed) and `200` on `permagate.io` — so the single
alternate was also dead and the reader was left with no working link and the
impression the push had failed.

`rig push` now prints every gateway in `ARWEAVE_GATEWAYS` from the shared
`@toon-protocol/arweave` package, and both `rig push` and `rig site` take
their default primary from the head of that list instead of repeating a
literal, so the one list stays the single source of truth. The wording no
longer blames indexing speed alone — it says a gateway can be down, because
that is the case that sends someone hunting a publish bug that isn't there.

`RIG_ARWEAVE_GATEWAY` / `--gateway` still override, and an overridden primary
is never repeated among its own alternates.
