---
"@toon-protocol/rig": minor
---

Status events (kinds 1630-1633) now carry the NIP-10 `root` marker on their `e` tag and the repo's `a` coordinate, so other NIP-34 clients (ngit, gitworkshop.dev) resolve and thread rig's issue/PR statuses correctly instead of failing on the old marker-less `["e", <id>]` shape. `buildStatus` takes the repo owner pubkey and repo id as its first two arguments to build the `a` tag; `rig pr status` is updated accordingly.

Readers (`rig issue`/`rig pr` list and show, and `@toon-protocol/rig-web`'s parsers and hooks) accept both this new marker form and the legacy bare form identically — an existing repo's already-published bare-form statuses keep applying with no migration needed. Status authority also now includes the target's own author (issue/PR author closing their own item) alongside the repo owner and declared maintainers, in both this package and `@toon-protocol/rig-web`; the maintainer acceptance handshake stays out of scope. A marker-form status from anyone outside that authorized set continues to be ignored, and the latest-wins tie-break is unchanged regardless of which form a given status used.
