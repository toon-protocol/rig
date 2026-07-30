---
'@toon-protocol/rig': minor
---

The official Rust edge is rig's default uplink.

With no explicit entry (`rig entry <url>` / `rig entry sandbox` /
`TOON_CLIENT_*` env), paid writes now go to the official TOON relay
implementation — the Rust connector at
`https://proxy.devnet.toonprotocol.dev/rust/ilp`, route `g.toon.relay`
(connector #616). A live announce no longer places the uplink (it still
informs the destination anchor, routes, prices and bootstrap peers), and a
price floor from one fleet's announce no longer binds a write that targets
another fleet's edge.

Requires `@toon-protocol/client` ^0.24.0 (bumped here): the official edge
never announces (ADR 0022), so the channel bootstrap comes from the
client's new announce-less path — the edge's x402 greeting carries the
channel-opening facts (connector #617) and the client synthesizes the
negotiation from them.
