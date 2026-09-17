---
'@toon-protocol/rig': minor
---

Read NIP-34-shaped ref tags from repository state events everywhere (rig#156).

NIP-34 puts the ref path in the kind:30618 tag *name* (`["refs/heads/main", "<sha>"]`). rig has only ever read its own `["r", "refs/heads/main", "<sha>"]` spelling, so it parsed zero refs from a state event written by ngit, gitworkshop.dev or any other conformant client. Every reader now accepts both shapes, through one shared parser (`nip34-refs.ts`): the CLI's remote-state reader behind `rig clone` / `rig fetch`, and the CI Coordinator's push watcher and commit materialization.

- A tag is a NIP-shape ref when its name starts with `refs/heads/` or `refs/tags/`. Nothing else in that shape is read as a ref.
- A NIP-shape name ending in `^{}` is a peeled annotated tag: not a ref, not listed.
- When both shapes name the same ref with different SHAs, the NIP shape wins, whichever came first in tag order — so two rig versions can never silently disagree about an event.
- The existing refname-safety and full-SHA checks apply identically to both shapes; the new parse path is not a hostile-relay bypass.
- The 1000-ref cap counts distinct refs across both shapes combined, so a dual-written event cannot double the limit.

Read-only: rig still writes the legacy `r` shape, and legacy-only state events behave exactly as before. The same dual-shape rules land in `@toon-protocol/rig-web`'s `parseRepoRefs` (a documented copy — rig-web cannot import this package), so the viewer renders any NIP-34 repo's branches and tags.
