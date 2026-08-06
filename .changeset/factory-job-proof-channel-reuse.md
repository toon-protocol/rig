---
'@toon-protocol/rig': patch
---

factory-job proof: resume the provider's existing channel instead of locking a fresh deposit every run.

The proof called `providerClient.openChannel()` directly, so each run against the
same provider mnemonic opened a new channel and locked another 100000 — five
distinct channel ids across runs 4–8, and a rising channel count that could not
be distinguished from a leak. The open now goes through the same peer→channel
map `rig channel open` uses (`src/standalone/channel-map.ts`, keyed under
`TOON_CLIENT_HOME`), which resumes a recorded channel when one exists and only
opens on-chain when it does not.
