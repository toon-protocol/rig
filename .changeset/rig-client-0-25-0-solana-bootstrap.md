---
'@toon-protocol/rig': minor
---

Consume `@toon-protocol/client@^0.25.0`, so a published rig can do the Solana greeting-bootstrap.

`^0.24.0` on a 0.x version resolves to `>=0.24.0 <0.25.0`, so rig could not pick 0.25.0 up
on its own — the devnet e2e had to run rig from toon-client workspace source. This bump makes
the published artifact carry the real thing.

What rig gains from client 0.25.0:

- **Solana greeting-bootstrap** (toon-client#470) — a wallet holding only Solana assets can
  open a payment channel and pay through a settling connector, with no prior EVM funding and
  no `kind:10032` announce required.
- **Solana open-path fixes** (toon-client#476) — the channel is funded at open rather than
  left at zero; the connector greeting's `programId` is honoured instead of a hardcoded
  default; an existing under-collateralized channel is topped up instead of being reused as
  is; and RPC failures are discriminated from genuine "no such channel" answers so a flaky
  endpoint no longer looks like a missing channel.

`@toon-protocol/rig-web` is `private: true` and is deployed rather than published, so it is
unaffected by this release.
