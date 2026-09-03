---
'@toon-protocol/rig': patch
---

Re-check the counterparty before resuming a cached payment channel

`rig-channels.json` keys a resumed channel by
`identity|destination|chain|tokenNetwork` — a ROUTE, with no counterparty in
it. When the node terminating an ILP name is replaced (the devnet apex
`g.toon` was retired and another node took over `g.toon.relay`), all four key
fields still matched, so rig resumed a channel opened against the retired node
and signed balance proofs against it. The new connector holds no record of
that channel and refuses every packet:

```
F01 - claim rejected: names a channel this connector has no record of,
so there is no counterparty to verify its signature against
```

Every paid write failed until the cache entry was deleted by hand.

A record already stores the counterparty it was opened against
(`context.recipient`); it is now re-checked against the settlement address the
destination announces TODAY before the channel is resumed. On a mismatch the
record is superseded and the channel re-resolved — which binds the channel
this identity already holds with the new counterparty where one exists, rather
than opening (and funding) a fresh one. EVM addresses compare
case-insensitively; Solana/Mina addresses compare verbatim.

A superseded record is MOVED to an archive key rather than deleted: it may
still hold an on-chain deposit, and `rig channel list/close/settle` find
channels by scanning the map, so deleting it would strand those funds behind
hand-editing the JSON. It is never a resume candidate again.

Records written by older versions carry no `context.recipient`. They are
treated as unverified rather than stale: the resume proceeds (no fresh
on-chain open, nothing for the user to fix) and the record is back-filled from
the announce, so the next run can verify it.
