---
'@toon-protocol/rig': patch
---

Bound what the coordinator uploads as a job log (#189).

The coordinator uploaded each job's complete log to the store and put the
resulting gateway URL in the Job Result's `logs` tag, with nothing capping
it: a job that left `set -x` on inside a loop wrote an unbounded blob to
permanent, paid storage. Per ADR-0003, the coordinator now caps what it
uploads at 1 MiB — a log under the cap goes up whole, exactly as before; a
log over the cap goes up as its head, an explicit marker naming the number
of omitted bytes, and its tail. It never uploads more than the cap.
Redaction is unchanged and still runs on the whole log before the cap is
applied, so an injected secret is absent whether it falls in the kept head,
the kept tail, or the omitted middle.

The `logs` tag's meaning narrows from "the complete log" to "the job log,
bounded" — done now, before a population of URLs promising the whole log
exists.

`estimateRunCost`'s per-upload envelope is now this same cap
(`LOG_UPLOAD_CAP_BYTES`) instead of a 64 KiB guess the actual upload could
exceed by orders of magnitude, so the affordability estimate is an actual
bound.

The Job Result's own 4 KiB log tail and its `logs` URL are unchanged.
