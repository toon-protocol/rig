---
'@toon-protocol/rig': patch
---

CI secrets: job logs are scrubbed of injected values, and `rig ci secret set` refuses an oversized value before paying (#131).

The coordinator now replaces every secret value it injected into a run with
`***` in that run's job logs before the log is uploaded to the store and before
the log tail is published in the Job Result (kind:9841). act masks secrets in its
own output, but the coordinator no longer relies on the Runner for that: a
workflow that prints a secret leaks nothing to the relay or the store.

`rig ci secret set` checks each value against the NIP-C1 16,384-byte limit
while parsing its arguments (and the value read from stdin), so an oversized
value is a usage error (exit 2) before any relay or wallet is touched, instead
of a failed publish. The value is never echoed.
