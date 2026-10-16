---
'@toon-protocol/rig': patch
---

Pin `@toon-protocol/client` to exactly 4.1.2. Client 4.2.0 and 5.x sign x402 vouchers for a newer connector wire than the devnet and provider fleet run (`rust-2026.09.29.1`), so `^4.1.2` let a fresh install of rig pick up a client the network refuses.
