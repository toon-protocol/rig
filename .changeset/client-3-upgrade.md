---
'@toon-protocol/rig': minor
---

Move the paid write path to `@toon-protocol/client` 3.x (#136).

Client 2.x wrote a 32-byte `executionCondition` on every PREPARE. Connectors
built since ADR 0069 read a one-byte `greeting` flag there instead, so every
paid `rig push`, `rig ci request` and coordinator write was refused at the
first packet with `invalid packet type byte`. The `^2.1.1` range could never
resolve to a client that speaks the new framing.

`@toon-protocol/client` is now `^3.0.0` and `@toon-protocol/core` is `^3.5.0`,
the pair the sandbox runs. The 3.0 major only removes
`IlpSendParams.executionCondition`, `SealedExchange.condition`,
`deriveCondition` and `resolveExecutionCondition`, none of which rig used, so
no code under `standalone/*` changes. This changes which connectors rig can
pay: anything carrying ADR 0069 (the sandbox hub and the current devnet
fleet) now accepts rig's writes.
