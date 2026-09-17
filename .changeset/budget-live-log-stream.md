---
'@toon-protocol/rig': patch
---

Budget the live log stream before the run starts (#192).

The coordinator's affordability check must never let a run begin that it
cannot afford to finish publishing, and streaming a live log tail adds to
that obligation. `estimateRunCost` now folds in the worst case from
ADR-0002: a tail republication on every 10-second cadence tick for the
whole run timeout, plus the one final replacement —
`liveLogTailEventBudget(runTimeoutMs)` from #188, so the two tickets can
never disagree on the number. `makeAffordabilityCheck` takes the
coordinator's own run timeout and prices every estimate against it.

The addition is deliberately a function of run duration alone: a repo's
own build output cannot move it, and a workflow with many jobs costs no
more to stream than one with a single job, because the tail is one
addressable event per run rather than one per job. There is no
best-effort mode — a coordinator that cannot afford the full worst case
declines to start the run and says so, exactly as it already does for a
run it cannot afford outright.

This lands before the coordinator publishes any live log tail (#193), so
there is never a commit where it publishes events it did not already
price.
