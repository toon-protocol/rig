---
'@toon-protocol/rig': major
---

Move onto `@toon-protocol/client` 0.22.0: the sealed wire, and a flat price
asked of the route. **Breaking.**

Both pins (`packages/rig`, `packages/rig-web`) go `^0.21.1` → `^0.22.0`. The
client's 0.22.0 is itself breaking on two axes, and this package's public
surface moves with it rather than papering over it. The changes below mirror
the ones already made to the copy of rig that lives in the toon-client monorepo
(toon-client#457 and #459) — the two copies stay one implementation.

**The store's answer is a sealed envelope, not HTTP text.**
`parseFulfillHttp` is gone from the client: a paid write is now an OER
`EnvelopeRequest` (ADR 0018) inside a gift wrap, and the answer comes back
sealed under the same secret. `PublishEventResult.data` (base64 HTTP/1.1 text)
becomes `PublishEventResult.response` (the opened response envelope).

`extractArweaveTxId` is therefore no longer reimplemented here — it is
re-exported from `@toon-protocol/client`. Its parameter type changes from
`string` to the response envelope, and the legacy bare-base64-txId branch is
gone with the wire that carried it. This file only ever carried a copy because
the client's extractor was thought not to be exported; it is, and with one
answer shape left to read a second reader could only drift from it.

**A price is flat per route, and the route is asked for it.**
ADR 0020 (toon-client#452) removes byte-proportional pricing from the protocol:
one handler, one price, and an app that wants to charge differently exposes
more handlers. A 100-byte and a 100 KB upload to the same store route now cost
the same, and the connector gates every paid packet at that figure regardless
of what a client computes.

So the following are **removed**, not deprecated:

- `FeeRates.uploadFeePerByte` and `FeeRates.minUploadFee`, replaced by one flat
  `FeeRates.uploadFee`.
- `flooredUploadFee()`, the `max(bytes × rate, floor)` helper the two fields
  existed to feed.
- `StandalonePublisherOptions.uploadFeePerByte`.

`uploadFeePerByte` was a public constructor option, and keeping it accepted-but-
ignored was rejected: a per-byte fee that cannot change what any packet costs
is a lie told to every caller who sets it, and it would silently misprice
`planPush` estimates against the claims actually signed. The already-present
`routePrices.store` now carries the whole upload fee rather than a floor under
a per-byte computation, so `getFeeRates()` — and with it the `rig push` confirm
table, the rig-page pointer fee and `rig site` estimates — equals what is
claimed.

`@toon-protocol/rig` is past 1.0, so removing exported API is a major bump.
