---
'@toon-protocol/rig': patch
---

CI secrets: injected values are scrubbed from job logs, artifacts and the coordinator's log, and `rig ci secret set` checks every NIP-C1 limit before opening the paid session (#131).

The coordinator now replaces every secret value it injected into a run — each
line of a multi-line value, and its URL-encoded and JSON-escaped forms — with
`***` in that run's job logs before the log is uploaded to the store and before
the log tail is published in the Job Result (kind:9841); an artifact whose bytes
contain a value is not uploaded, and a Runner failure message is scrubbed
before it reaches the coordinator's log. act masks secrets in its own output,
but the coordinator no longer relies on the Runner for that. Values shorter
than 4 bytes are not redacted.

`rig ci secret set|remove` now runs the full NIP-C1 plaintext check — empty or
oversized values (16,384 bytes), more than 100 names, a plaintext over 65,535
bytes — while parsing its arguments and the value read from stdin, so any
violation is a usage error (exit 2) before any relay or wallet is touched,
instead of a failed publish. Usage errors no longer echo the offending
argument, so a value typed where a NAME belongs stays off stderr.
