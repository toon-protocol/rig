---
'@toon-protocol/rig': minor
---

`rig pr merge` gains `--require-ci-trust <level>`, which refuses the merge before paying unless the patch series' head commit has a concluded green CI run at that trust level (the same gate as `rig ci status`), and `--closes <issue-id>` (repeatable), which publishes kind:1632 for each issue after a successful merge and lists them in `--json`.
