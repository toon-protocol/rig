---
'@toon-protocol/rig': patch
---

`rig inbox --follow` now reports a relay's `CLOSED` reason and any `NOTICE` on stderr. A `CLOSED` subscription reconnects with backoff; a `NOTICE` keeps the connection. Neither exits the follower.
