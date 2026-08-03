---
'@toon-protocol/rig': minor
---

Factory job adapter: turn an accepted job into a factory run that emits paid increments.

New exports (`@toon-protocol/rig`): `planFactoryJob` prices a job's `bid`
across the milestone boundaries `.sandcastle/main.ts` already produces —
plan, one increment per implementation ticket (never a single lump-sum
implement increment), then review — mirroring `planPush`'s network-free
planning split. `executeFactoryJob` runs those milestones through injected
hooks, delivers each increment's artifact through the existing `Publisher`
(upload + event publish) plus a new `JobDeliveryPort` (encrypt + wait for
payment), and halts at the first unpaid increment — the buyer and provider
are each exposed for at most one increment. `factory-job-events.ts` adds
pure builders/parser for the wire format toon-meta#263 fixed: kind:5097 job
request, kind:6097 job result, kind:7000 job feedback (quote / increment
offer / narration).

`JobDeliveryPort`'s real implementation is deferred: `@toon-protocol/client`
0.25.1 (latest published) does not yet export the earning-API/hashlock
helpers (`encryptArtifact`, `fulfillIncrement`, `createJobMessageHandler`,
`getClaimState`) merged to its `main` branch today — wiring those in is a
follow-up ticket once a release carries them.
