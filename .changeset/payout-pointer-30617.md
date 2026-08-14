---
'@toon-protocol/rig': minor
---

Add a payout pointer tag to kind:30617 and `rig payout set|clear|show` (rig#92, payout epic toon-protocol/toon-meta#391 R1).

The payout pointer is the identity half of the payout epic: no pointer on a
repo's announcement means a serving node keeps 100% of repo-scoped write
fees; a declared `["payout", "evm", <address>]` tag opts the repo into that
node's declared `ownerFeeShare` split (decided off-hot-path, downstream in
connector#968/#969). v1 accepts exactly one chain, `evm` — the payout
accrual ledger is EVM-only today
(`crates/connector-client-edge/src/btp.rs:270-272`) — but the tag shape
carries the chain label so nothing re-shapes later.

- `nip34-events.ts`: `buildRepoAnnouncement` gains an optional `payout`
  parameter; `parsePayout` reads it back (EIP-55 checksum-validated,
  normalized to checksummed form, tolerant of relay noise — an unsupported
  chain or malformed/extra tag is dropped with a `console.warn`, first
  valid tag wins). `RemoteState.payout` surfaces it from `fetchRemoteState`.
- New `rig payout set <address>|clear|show`, mirroring `rig maintainers`
  exactly: `show` is a free relay read; `set`/`clear` republish the 30617
  (one paid event), preserving name/description/maintainers byte-for-byte,
  owner-identity-only, and refuse on an unannounced repo. A malformed
  address (bad shape or bad EIP-55 checksum) is refused client-side before
  any relay/identity work — no event is ever published.
- `rig maintainers add/remove` now also preserves an existing payout
  pointer across its own republish (previously would have silently wiped
  it, since it built the 30617 without carrying `remote.payout` through).
