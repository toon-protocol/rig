---
'@toon-protocol/rig': minor
---

Add `rig pr merge <patch-id>`: applies the latest authorized revision with `git am` in an isolated worktree, pushes through the `rig push` path (fast-forward check included), and only then publishes the applied status (kind:1631) naming the merged commits. A conflict, a refused caller or a failed push publishes nothing; a status failure after a successful push is a partial success with a `rig pr status` retry hint.
