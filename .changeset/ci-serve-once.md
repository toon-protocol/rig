---
'@toon-protocol/rig': minor
---

`rig ci serve --once`: stop after the first run concludes (#127).

A coordinator started with `--once` listens as usual, and exits 0 on its own
once the first run's Workflow Result (9842) and final `concluded` progress
marker (39842) are on the relay — so one `rig ci trigger` from a maintainer can
be answered by one bounded `rig ci serve --once` on the coordinator side, with
nothing left running. Runs that never reach the Runner (`startup_failure`,
`cancelled`) count; ignored or refused triggers (a non-maintainer author, a
workflow SHA-256 mismatch, an unaffordable run) publish nothing and do not.
The `--json` start document gains `once`, and the library's
`CoordinatorOptions` gains the `onRunConcluded` hook the flag is built on.
