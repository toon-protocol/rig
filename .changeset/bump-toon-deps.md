---
'@toon-protocol/rig': patch
---

chore(deps): `@toon-protocol/client` `^0.29.0`, `@toon-protocol/core` `^3.2.0`

Both bumps are required for the factory-job proof to reach `PROOF COMPLETE` against live
devnet, and both were verified by a witnessed run rather than by the gate alone (#59, run 8).

- `client ^0.29.0` — the previous `^0.26.x` range predates toon-client#503, so a client bound
  under the literal BTP registry key `"client"` and its PREPARE `F02`d at the Rust edge. A
  caret range on a `0.x` does not cross minors, so `pnpm install` never picked this up on its
  own.
- `core ^3.2.0` — carries the corrected devnet genesis peer seed (toon-protocol/toon#155). The
  3.1.x seed pinned the retired TypeScript connector's nostr key, and `ToonClient`'s bootstrap
  filters kind:10032 by `authors`, so a client got `EOSE, found 0 events` and could not open a
  channel at all.
