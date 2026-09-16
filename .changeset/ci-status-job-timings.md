---
'@toon-protocol/rig': patch
---

`rig ci status` now prints each job's duration and each concluded run's wall-clock time on the human lines, and the `--json` envelope's jobs carry `queuedAt` and `concludedAt` (the Job Result's `created_at`) next to `startedAt`, so a script can read job timings without re-parsing the 9841 (rig#128).
