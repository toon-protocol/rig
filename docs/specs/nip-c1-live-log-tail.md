Live Log Tail
=============

A CI Extension to NIP-C1
------------------------

`draft` `optional` `rig extension`

This document specifies **kind `39841`, the Live Log Tail**: the recent output
of a workflow run that is still in flight. It is rig's extension to
[NIP-C1](./nip-c1.md), not part of that specification. The kind number is
rig's choice and is offered upstream to ngit-ci in parallel with shipping; see
`docs/adr/0002-live-log-tail-as-a-nip-c1-extension-kind.md` for why claiming a
number is recoverable for this kind and for no other — the event carries no
durable data, so renumbering is a deploy rather than a data migration.

Everything NIP-C1 says about common tags, trigger context, workflow run ids and
[NIP-40](https://nips.nostr.com/40) expiry applies here unchanged.

| event | kind | NIP-01 class / replacement identity | publisher | lifetime |
| --- | ---: | --- | --- | --- |
| Live Log Tail | 39841 | addressable: `(kind, pubkey, d)` | coordinator | at most 30 minutes |

## What it is, and what it is not

A Live Log Tail is a **view**, never the record. The record is the job log: the
complete, redacted output uploaded when a job finishes and named by the `logs`
tag of its Job Result (kind `9841`). A client renders the tail while a job is
unfinished and the job log once it concludes.

Two consequences follow from replacing rather than appending, and both are
deliberate:

- Output that scrolls past between two publications is not recoverable from
  this event. It is in the job log a minute later.
- A viewer cannot distinguish a stalled job from a stalled coordinator beyond
  the event's expiry.

A client MUST NOT archive a Live Log Tail as a record of a run, and MUST NOT
treat the absence of one as an error: an old coordinator, an expired event, or
a concluded run all render as a normal run with no live output.

## The event

One event per **run**, not per job. Its `d` is the workflow run id — the same
value as the run's Workflow Progress (kind `39842`) `d` — so a client holding a
run's progress addresses its tail with no further lookup, at
`39841:<coordinator-pubkey>:<workflow-run-id>`.

```jsonc
{
  "kind": 39841,
  "content": "{\"jobs\":[…],\"runner\":{…}}", // JSON, see below
  "tags": [
    // the same common and trigger-context tags as the run's Workflow Progress

    ["d", "<workflow-run-id>"],            // the run's Progress `d`
    ["expiration", "<unix-timestamp>"]     // NIP-40
  ]
}
```

The common and trigger-context tags are those specified by NIP-C1 (`a`, `c`,
`w`, `o`, and then `r` for a push run or the NIP-22 `E`/`K`/`P`/`e`/`k`/`p`
tags for a pull-request run). A Live Log Tail carries no `conclusion`, no
`status`, and no `q` quotes: it says nothing about the state of the run, only
what its jobs have printed. Run state comes from Workflow Progress.

The NIP-40 `expiration` MUST be later than `created_at` and no more than 1800
seconds (30 minutes) after it, as for every other addressable kind in NIP-C1.
A consumer MUST ignore an event whose expiration is outside that bound; the
bound is evaluated against the event's own `created_at`, so no clock agreement
between publisher and consumer is required.

## Content

`content` is a JSON object — not raw text, because several tails share one
event:

```jsonc
{
  "jobs": [
    {
      "job": "build",              // job id as declared in the workflow file
      "tail": "…recent output…",   // the END of that job's output so far
      "omitted": 132096            // bytes of that job's output before `tail`
    }
  ],
  "runner": {                      // optional — the runner channel
    "tail": "…recent output…",
    "omitted": 0
  }
}
```

`jobs` MUST be present and MUST be an array; it MAY be empty (a run whose first
job has printed nothing yet). Each entry MUST carry a non-empty `job` and a
string `tail`. `omitted` is the number of **bytes** of that job's output
preceding the tail; when absent it is 0, and when present it MUST be a
non-negative integer. A job id MUST NOT appear twice in one event.

A job appears while it is unfinished and disappears once its Job Result is
published. A run publishes one final replacement when it concludes, carrying
the closing output, and then nothing: the event is left to expire. Without that
final replacement the last thing a viewer sees would be whatever the publishing
timer happened to catch, which may be from before the failure.

`runner`, when present, is the **runner channel**: the runner's own account of
executing the run — container cleanup after a timeout, image-pull failures,
backend output belonging to no job. It has the same `tail`/`omitted` shape. It
is not a job: it has no Job Result, it never concludes, and a client SHOULD
present it as the runner talking rather than as an extra job that never
finishes. It MUST NOT appear as an entry in `jobs`; an event that names the
runner channel as a job id (rig uses the reserved key `~runner`, which no
workflow job id can equal) is malformed.

Tails are sliced from the **end** of the output, on a byte boundary that does
not split a multi-byte character, so `tail` is always valid UTF-8 and `omitted`
counts everything before it.

Publishers MAY add fields to this object and to its entries. A consumer MUST
ignore fields it does not know, and MUST reject an event whose content is not
valid JSON, is not an object, or violates any MUST above — rather than
rendering a half-parsed result.

## Redaction

The publisher redacts the accumulated output and then slices the tail, never
the reverse. The guarantee is therefore exactly the durable path's: a value
injected into a run as a secret does not leave the publisher in the clear,
including across a publication boundary, because those bytes were already
replaced before the slice was taken. A consumer performs no redaction of its
own and MUST NOT assume any.

## Sizing and cadence

These are publisher decisions, stated so a consumer knows what to expect:

- A run in flight republishes its tail on a fixed 10-second cadence, plus one
  final replacement when the run concludes.
- Each live job gets 16 KiB of tail — far more than the 4 KiB that rides in a
  Job Result, because the relay fee is flat per event regardless of size. When
  the live entries would together exceed a per-event ceiling of 64 KiB, the
  budget is divided evenly among them instead.
- Because the fee is flat and all the tails ride in one event, a run's
  worst-case streaming cost is a function of run duration alone: it is
  independent of job count and of how much output the repo's build produces.

A consumer MUST NOT rely on any of these numbers; `omitted` tells it what it is
missing, and a tail may be any size.

## Reading a run

```jsonc
// the run's tail, from its Workflow Progress `d`
{ "kinds": [39841], "authors": ["<coordinator-pubkey>"], "#d": ["<workflow-run-id>"] }
```

Because the event is addressable, a relay serves the latest version, so a
client that subscribes four minutes into a five-minute job sees the current
tail immediately rather than an empty pane.

Subscribe to it per run being viewed, not alongside a repo-wide run list: a
list view has no use for log bytes and would pay to receive them.

## Implementation

rig's builder and parser are `buildCiLiveLogTail` / `parseCiLiveLogTail` in
`packages/rig/src/ci/nip-c1-events.ts`, alongside the NIP-C1 kinds; the
cadence, tail sizes and the reserved runner-channel key are exported from that
module as `CI_LIVE_LOG_TAIL_INTERVAL_MS`, `CI_LIVE_LOG_TAIL_JOB_BYTES`,
`CI_LIVE_LOG_TAIL_MAX_BYTES` and `CI_RUNNER_CHANNEL_KEY`.
