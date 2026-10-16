---
'@toon-protocol/rig': patch
---

`rig ci serve` now breaks a repo-state `created_at` tie by lowest event id, the same rule `rig clone` uses, so a coordinator serves the refs everyone else sees.
