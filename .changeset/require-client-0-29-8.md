---
'@toon-protocol/rig': patch
---

Require `@toon-protocol/client` >= 0.29.8

The store leg cannot open a channel against the store node's own settlement
address without the per-destination counterparty resolution that shipped in
client 0.29.8 (toon-client#571). On 0.29.7 `openChannel` still falls back to
the first negotiated peer, so the store connector refuses every git-object
upload with `F01 - claim rejected: names a channel this connector has no
record of`. Verified directly: the same rig build fails on 0.29.7 and
succeeds on 0.29.8. The floor is raised rather than left at `^0.29.7`,
because this is a hard requirement, not a preference.
