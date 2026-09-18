---
'@toon-protocol/rig': patch
---

ActRunner routes backend output to the runner channel instead of dropping it (#191).

`ActRunner` dropped any line from `act` that did not parse as act JSON before
the streaming log sink (`onLog`) ever saw it — exactly the output an image
pull failure, a Docker daemon refusing to start, or act itself crashing
produces. Per ADR-0002, that output is now routed to `onLog` under the
runner channel (`CI_RUNNER_CHANNEL_KEY`) instead of being dropped, alongside
the container cleanup notes the runner channel already carried after a
timeout or cancellation.

The runner channel is not a job: it carries no result, never concludes, and
never appears in the runner's returned `jobs`. Output that parses as act
JSON is unaffected, and the durable path — `summarizeActRun`, the job logs
and conclusions the runner returns — is unchanged.
