---
'@toon-protocol/rig': minor
---

Repository announcements (kind:30617) now carry the NIP-34 conformance tags, and `rig refresh` backfills them on an existing repo.

A repo's announcement gains three tags, so other NIP-34 clients (ngit, gitworkshop.dev) can find, browse and group it:

- `relays` — the relay URLs the publish is going to, as one multi-value tag: where the repo's issues, patches and state live.
- `web` — the repo's rig-web viewer URL, built from the same base URL and route shape the Rig pointer already uses (so ADR-0001's URL-permanence rules govern it).
- `["r", "<sha>", "euc"]` — the earliest unique commit, the repo's fork identity. It is computed from the local repo's root commits: one root wins outright; with several, only the roots reachable from the default branch are candidates, and a remaining tie is broken on the lexicographically lowest SHA. **Once an announcement carries an `euc`, a republish preserves it and never recomputes it** — a repo's fork identity must never change under its owner.

`clone` is never written: rig has no git-clonable URL and must not send other clients to a fetch that cannot succeed. An existing `clone` tag written by another client is preserved, like every other tag rig does not model.

New repos get all three on their first push. Existing repos are backfilled on any owner-initiated republish — `rig maintainers add|remove`, `rig payout set|clear`, or the new `rig refresh`. **A plain `rig push` still never republishes an existing announcement**, so it can never charge an event fee the owner did not confirm.

`rig refresh` is a new owner-only command that republishes the announcement with no field edit, purely to refresh those tags. It runs behind the same fee confirmation gate and the same `--json` contract as `rig maintainers`, lists the exact tags it would add, change or drop before asking, and publishes nothing and pays nothing when no tag would change.

`rig maintainers add|remove` and `rig payout set|clear` now show the same tag-level diff before their confirmation, and their `--json` envelopes gain a `changes: { added, removed }` field, so a machine consumer sees exactly what the fee buys.

Note for repos announced by another NIP-34 client: `relays` and `web` are **unioned**, never substituted — a republish adds rig's relay and viewer URL to whatever the announcement already declares and keeps that client's entries in their original order. A republish that adds nothing new changes no tag, so it publishes nothing and costs nothing. Every tag rig does not model — `clone`, the maintainer role tags, `blossoms`, `t`, `alt` and anything else — still rides along verbatim.
