---
'@toon-protocol/rig': minor
---

`DEFAULT_RIG_WEB_URL` (the pointer's no-JS/delayed fallback link, embedded permanently in every Arweave-published rig pointer) now points at `https://toon-protocol.github.io/rig` instead of the retired `toon-protocol.github.io/toon-client` copy. `rig` is now the sole owner of `rig-web`; `/toon-client/` becomes a permanent fragment-preserving redirect stub (tracked separately in `toon-client`, see `docs/adr/0001-rig-web-ownership-and-url-permanence.md`).
