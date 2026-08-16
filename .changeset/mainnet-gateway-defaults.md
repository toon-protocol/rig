---
'@toon-protocol/rig-web': patch
---

Default the ArNS result URL and the pointer-page asset gateway to mainnet ar.io gateways. `ar-io.dev` is ar.io's testnet gateway (its ArNS resolver runs against the Solana devnet contracts), so a mainnet name printed as `https://<name>.ar-io.dev/` was a guaranteed 404. `RIG_ARNS_GATEWAY` still overrides.
