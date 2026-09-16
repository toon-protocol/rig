---
'@toon-protocol/rig': patch
---

CI 8 (#133): close the evidence gaps in the coordinator's operations tests.
Three pushes under `--concurrency 1` are now shown to run one at a time in
push order with `queue` rounds 1, 2, 3 on their waiting markers (and
concurrency 2 to run two at once, queuing the third in round 2); a run that
hits the wall clock is shown to have its Runner stopped, the job it cut short
published as `timed_out` while a job that finished successfully keeps its
verdict, and the Workflow Result and final progress marker concluded
`timed_out`; a publisher that cannot pay is shown to refuse each new run with
one log line and nothing published, then resume once funded; and a push that
lands at the relay while the socket is down is shown to run exactly once after
the backoff reconnect and never again on a later reconnect. `rig ci serve
--help` now quotes the coordinator's own `DEFAULT_CONCURRENCY` (1) and
`DEFAULT_RUN_TIMEOUT_MS` (1800 s) instead of hard-coded numbers, and a test
pins the help to those constants; no behaviour change. The shared coordinator
"world" fixture lives in `src/ci/coordinator-testkit.ts`.
