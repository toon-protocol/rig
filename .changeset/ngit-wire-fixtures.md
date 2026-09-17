---
"@toon-protocol/rig": patch
---

Export real NIP-34 wire fixtures captured from `wss://relay.ngit.dev` (rig#153, rig#155) — a kind:30617 announcement with role tags and `clone`, a kind:30618 state event with peeled `^{}` tags, a kind:1111 comment thread with a nested reply, and a kind:1630-1633 status in NIP-10 marker form — so downstream NIP-34 conformance work in this package and `@toon-protocol/rig-web` can test against what the incumbent actually publishes. Additive only: no existing export changes behavior.
