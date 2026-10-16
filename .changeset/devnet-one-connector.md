---
'@toon-protocol/rig': patch
---

Follow the devnet's consolidation to one connector (2026-10-16). `rig fund` (and `rig name`'s default DVM) infer devnet from the new `https://toonprotocol.dev` connector and `wss://relay.toonprotocol.dev` relay as well as from `*.devnet.toonprotocol.dev`. The default upload destination now prefers a `*.store` route the node terminates itself, so on the one connector git objects go to `g.toon.store` and not to the relay's forwarded `g.toon.relay.store`; a node that only forwards to a store is unchanged. The README's devnet table and examples name the new URLs.
