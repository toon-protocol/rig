---
'@toon-protocol/rig': minor
---

Add `rig inbox --follow`: emit the backlog since the cursor, then stay connected to the same relays and stream one JSON object per line (the `--json` entry shape) for each new event, with no duplicates. Dropped relays reconnect with backoff and report on stderr; the cursor advances as events are emitted, so a restart resumes where it left off.
