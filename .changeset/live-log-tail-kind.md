---
'@toon-protocol/rig': minor
---

Live Log Tail kind 39841: the wire shape and the numbers it rests on (#188).

A run is a black box while it happens — nothing about a job reaches a viewer
until the Job Result lands. The first piece of fixing that is one agreed event:
`kind:39841`, rig's addressable NIP-C1 extension carrying the recent output of
a run's unfinished jobs plus the runner channel. Its `d` is the run's Workflow
Progress `d`, so a client holding a run addresses its tail without a second
lookup; its tags are the run's own common and trigger-context tags plus a
NIP-40 `expiration` no more than 30 minutes out. `content` is JSON — `jobs` of
`{ job, tail, omitted }` and an optional `runner` — because several tails need
structure. `parseCiLiveLogTail` ignores fields it does not know so a later rig
can add to the shape, and returns `null` rather than throwing or half-parsing
on anything the shape does not allow.

The kind is documented for client authors at
`docs/specs/nip-c1-live-log-tail.md` as rig's extension, offered upstream to
ngit-ci, and the decisions behind it land as ADR-0002 (the live log tail as an
extension kind) and ADR-0003 (bounded job log uploads).

Four constants that later slices must agree on are exported from the one place
the wire shape lives: `CI_LIVE_LOG_TAIL_INTERVAL_MS` (the 10-second cadence),
`CI_LIVE_LOG_TAIL_JOB_BYTES` (16 KiB per live job),
`CI_LIVE_LOG_TAIL_MAX_BYTES` (the per-event ceiling) and
`CI_RUNNER_CHANNEL_KEY` (the reserved non-job key). `liveLogTailBudget`,
`liveLogTailEventBudget` and `sliceLogTail` do the arithmetic that goes with
them, so the coordinator that publishes the stream and the estimate that prices
it cannot disagree about a number.

Wire shape only: nothing publishes or consumes the kind yet.
