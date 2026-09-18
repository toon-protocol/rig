# ADR-0004: rig never publishes a Deployment (kind 30437)

## Status

Accepted (2026-09-18). Records the decision on rig#208; follows
toon-protocol/TOON_Network#56.

## Context

TOON Network #56 replaces the Tenant's signature on a Lease Request with a
Continuation Token, which removes every Tenant-signed artifact from the
lease path. Once it lands, a Provider holds no transferable proof that a
named Tenant asked it to run anything, and no Tenant-signed event about a
lease is published anywhere.

Kind `30437` (Deployment) is the one remaining way to undo that, and rig —
the first tenant tooling for TOON Network — is the only thing that would
emit one. The spec reserves the kind and leaves its shape to tenant
tooling: a Tenant-signed event naming, in one place, the repository, the
Provider, the workload id and the image digest. It also re-publishes the
`workload_id` that #56 removes from kind `30438`, and that value is the
join key across independently signed events — paired with a
Provider-signed Eviction Notice (`4433`) or Takeover (`30433`) carrying the
same id, a third party gets both parties from two signatures neither party
can repudiate.

rig has no TOON Network client today. Grepping `packages/*/src` for
`toon.network`, `4432`, `4433`, `30432`, `30433`, `30437`, `30438`,
`Lease Request`, `standby` and `workload_id` returns nothing, so there is
no code to change and no migration to run. That is the reason to decide
now rather than later: once tenant tooling exists, "does rig publish a
Deployment" becomes a default someone picked while building something
else, and defaults are hard to take back once anyone depends on them.

## Decision

rig never publishes a kind `30437` Deployment. Not by default, and not
behind a flag.

Which Lease serves which environment is client state. rig tracks it
locally, for the Tenant who already knows it, and publishes nothing about
the pairing. rig ships no code path — no flag, no config key, no
environment variable — that signs one.

rig#208 recommended instead an opt-in flag, off by default, naming its own
attribution cost. That was not taken. The flag's only beneficiary is a
team that wants to read "what is deployed where" off the network rather
than ask rig, and #208 makes the case against itself: that audience is
indistinguishable from a third party assembling exactly the attribution
record #56 exists to deny. A flag is also a surface — it has to be
documented, kept working, and defended against the CI config that sets it
once and attributes every deployment thereafter. Shipping nothing is the
only version of this with no way to get it wrong.

Should rig ever need to publish one, that is a new decision superseding
this ADR, not a flag added while building something else.

## Consequences

- **Third-party deployment discovery is lost**, permanently and by
  design. Nobody can ask the network which Provider is serving a given
  repository's production environment, because rig never says.
- **Tenant-side discovery is unaffected.** The Tenant holds the Lease and
  chose the environment; rig can answer "what is deployed where" from
  local state without publishing anything.
- **The join key stays unpublished.** With `workload_id` gone from kind
  `30438` and never re-published by rig, a Provider-signed Eviction Notice
  or Takeover names a workload no public Tenant-signed event names too, so
  it pairs with nothing.
- **The first tenant tooling commit has to match this.** There is no code
  to migrate today; the cost of this ADR is entirely that whoever writes
  rig's TOON Network client reads it first.
