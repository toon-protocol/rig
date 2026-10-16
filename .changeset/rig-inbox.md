---
'@toon-protocol/rig': minor
---

Add `rig inbox`, a free read command that prints everything new since you last checked: patches, revisions, issues, comments, authorized statuses and CI results for repos you own or maintain, plus any event that tags your pubkey. A per-identity cursor advances after each read; `--since` and `--all` look back without moving it. `--json` returns an array of events.
