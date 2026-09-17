---
'@toon-protocol/rig': patch
---

Give the read path the gateway override the write path already had (#176).

`RIG_ARWEAVE_GATEWAY` / `--gateway` steered `rig push`, `rig site` and
`rig ci serve`, but `rig clone` and `rig fetch` resolved object bytes through
the gateway list baked into `@toon-protocol/arweave` with no override — so a
repository whose objects live only on a self-hosted, local or air-gapped
gateway could be pushed but never cloned back (reading your own repo on the
dev sandbox took a `globalThis.fetch` monkey-patch).

`rig clone` and `rig fetch` now accept `--gateway <url>`, defaulting to
`RIG_ARWEAVE_GATEWAY`. The configured gateway is tried FIRST, on the store's
raw-bytes route `<gateway>/raw/<txId>` — the same route and ordering
`rig ci serve --gateway` uses to materialize a commit — with the public
gateway list kept behind it as the fallback. With nothing configured the read
path is byte-for-byte what it was: the shared public list, untouched.

The selection now lives in one place (`gateway-preference.ts`:
`configuredGateway` / `readGateways` / `readGatewaysFor`), which `rig ci serve`
also uses, so the three commands cannot drift apart.
