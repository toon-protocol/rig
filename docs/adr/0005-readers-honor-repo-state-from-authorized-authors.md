# ADR-0005: Readers honor repo state from authorized authors

## Status

Accepted (2026-10-16). Records the decision on rig#225, built in rig#226.

## Context

Readers accepted a kind:30618 repo state only when the owner signed it. A
declared maintainer could set status on issues and patches (rig#287) but could
not move a branch, so "multiple maintainers" meant one person who pushes and
several who comment.

This is a reader policy. It adds no wire shapes: kind:30617 already carries
the `maintainers` tag and kind:30618 is already a replaceable event per author,
so it does not belong in `toon-protocol/connector`.

## Decision

**Authorized authors** are the owner plus the pubkeys in the `maintainers` tag
of the owner's own latest kind:30617. Maintainers listed in another
maintainer's announcement carry no authority, so authority never spreads
beyond what the owner granted, and removing a pubkey from the owner's tag
revokes it for all later and earlier events alike.

The **honored repo state** is the newest kind:30618 signed by an authorized
author. A `created_at` tie goes to the lowest event id, the same tie-break
status events use. A stranger's repo state is ignored, however new.

Status honoring uses the same authorized-author set, plus the target's own
author. Its behavior is unchanged.

The rule is two pure functions in `@toon-protocol/rig` (`authorizedAuthors`,
`honoredRepoState`, `src/repo-authority.ts`) that do no I/O, so the CLI and
rig-web resolve identical refs. The CLI's remote-state fetch reads the owner's
announcement, then queries repo state by the authorized-author set.

## Consequences

- A maintainer can move refs, not only set status. `rig maintainers add` and
  `remove` say so.
- Two maintainers can publish states that drop each other's commits; the
  replaceable event has no merge. Guarding against that is a push-side concern
  (rig#225), not a reader one.
- Revocation is by the owner's current announcement only. A removed
  maintainer's old events stop counting immediately; there is no history.
