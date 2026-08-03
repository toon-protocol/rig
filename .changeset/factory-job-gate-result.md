---
'@toon-protocol/rig': minor
---

Publish a reproducible gate result per increment: the objective floor of toon-meta#262 decision 5.

New exports (`@toon-protocol/rig`): `GateResult`/`GateCheck` (`factory-job-gate.ts`)
record which checks ran, the literal command for each, the commit, and the
toolchain versions — enough for a buyer to re-run the gate themselves and
get the same answer. `gatePassed` derives the aggregate pass/fail.

`FactoryJobHooks.implement`/`.review` now return a `FactoryJobWork`
(`{ artifact, gate? }`) instead of raw bytes — `plan` carries no gate, since
there is no code to lint/typecheck/test/build against a brief.
`buildIncrementOfferEvent` (`factory-job-events.ts`) threads the gate result
onto the `kind:7000 status:"partial"` offer: a `["gate", "pass"|"fail"]` tag
for cheap aggregation into a gate-pass rate (decision 8), and the full
reproducible result in `content` — visible to the buyer before they pay, per
the issue's "not discovered after payment." Throws if a gate result is
missing its commit or check list, since either would make the claim
unreproducible rather than verifiable. A failing gate is not a protocol
violation — the increment is still offered, just visibly failing; the
distinction between "passed the gate" and "is good work" stays with
reputation, never this.
