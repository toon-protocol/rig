---
'@toon-protocol/rig': patch
---

The coordinator publishes the live log tail while a run is in flight (#193).

A run stops being a black box on the relay. The coordinator now passes a
streaming log sink into the runner — the `Runner.onLog` seam `ActRunner` has
always called and no coordinator ever supplied — accumulates what it prints
per job, with the runner channel (`~runner`) as a distinguished non-job key
for output the runner attributes to no job, and republishes one addressable
Live Log Tail (kind 39841, `d` = the run id) for the whole run on the fixed
cadence of ADR-0002. A viewer arriving four minutes into a five-minute job
sees the current tail immediately, because the relay serves an addressable
event's latest version.

A job appears while it is unfinished and drops out once its Job Result names
its durable job log. Each live entry's tail is sliced from the END of its
output with `omitted` counting everything before it, and when enough entries
are live to threaten the per-event ceiling they share the budget evenly
rather than exceeding it.

Redaction comes first and slicing second: the whole accumulated buffer is
redacted exactly as the durable path redacts a job log, and the tail is cut
out of the result. A secret written across a refresh boundary — or across a
slice boundary — was therefore already replaced before the slice was taken.

The cadence runs on the coordinator's existing scheduler seam and stops when
the runner returns, since only `runner.run` is bounded by the run timeout; at
the run's conclusion the event is replaced once more with the closing output
that never got a Job Result (a timed-out run's jobs, and the runner channel's
account of why), and then left to expire under NIP-40. A run never publishes
more of these events than `liveLogTailEventBudget(timeoutMs)` — the worst
case `estimateRunCost` priced before the run started (#192) — and a
coordinator that cannot afford a run publishes no tail at all, because it
never starts it. A run that concludes inside a single cadence interval has
nothing on the relay to replace and publishes none.

The durable path is untouched: the same job results, job logs, progress
markers and workflow result as before.

`FakeRunner` no longer replays a job's log through `onLog` when the script
already streamed that job, which would have double-emitted every byte.
