---
'@toon-protocol/rig': patch
---

Fix two defects found by a live devnet run: every paid write 401'd, and each
run risked leaking a fresh on-chain payment channel.

**Paid writes could never reach BTP.** With no explicit entry, topology
resolution placed the official proxy (ILP-over-HTTP) and nothing else, so the
embedded client built no BTP session at all. The client's default transport
precedence is HTTP-first, so every claim-bearing write went out as a
`POST /ilp` one-shot carrying only an unauthenticated `ILP-Peer-Id` header —
which the live edge answers `401 Unauthorized: identity 'g.toon.client'
failed to authenticate`, failing `rig push --yes` before any object uploaded.
Resolution now ALSO adopts the payment peer's announced `btpEndpoint`
whenever no uplink was pinned explicitly, and the embedded client is built
with `preferBtpForPaidWrites` (toon-client#482) so claims ride the BTP
session, which authenticates on connect. The proxy stays in place as the HTTP
leg the x402 greeting bootstrap (connector #617) needs, and as the BTP
transport's own fallback; an explicitly pinned `proxyUrl`/`btpUrl` is never
overridden. Reads, fee estimates and the channel open are unchanged.

**Both official default endpoints move off the retired apex.** The two-box
cutover destroyed `proxy.devnet.toonprotocol.dev`; it still resolves but
refuses connections, and rig's defaults both pointed at it:

- `OFFICIAL_PROXY_URL` was `https://proxy.devnet.toonprotocol.dev/rust/ilp`
  and is now `https://proxy.relay.devnet.toonprotocol.dev/ilp` — exactly what
  the relay's own live kind:10032 announce advertises as its `httpEndpoint`.
  The PATH moved too: `/rust/ilp` was a legacy path from when the Rust and TS
  fleets ran side by side, and the live edge answers `410 Gone` on it while
  serving the ingress at plain `/ilp`. This one is load-bearing beyond paid
  writes — it is the endpoint the x402 greeting bootstrap dials, so a dead
  value fails a FRESH channel open even when claims ride BTP.
- `OFFICIAL_BTP_URL` is new: `wss://proxy.relay.devnet.toonprotocol.dev/ilp/btp`,
  the fallback when discovery names no BTP endpoint. Deliberately NOT
  `@toon-protocol/core`'s genesis seed, which still names the retired apex —
  and because the embedded client dials BTP during `start()`, adopting a dead
  endpoint would turn a late 401 into rig refusing to run at all.

Both now sit on the relay box, which is the one that terminates
`OFFICIAL_PUBLISH_DESTINATION` (`g.toon.relay`). After this change no rig
default references the retired apex anywhere — a property the tests pin
directly, so the next topology move fails loudly rather than silently.

Because a derived endpoint is only a discovery guess, an unreachable one now
DEGRADES instead of failing the run: a bootstrap failure classified as a BTP
socket/auth error (`isBtpTransportError`) on a derived endpoint rebuilds the
publisher without the BTP leg and retries once over HTTP. An explicitly
pinned `btpUrl` is never dropped — that is an operator's choice, and quietly
abandoning it would hide a real misconfiguration. This shares the existing
#279 cached-topology retry seam, now a bounded ordered chain of single-use
recoveries (`bootstrapRecoveries`); bootstrap failures are pre-payment by
construction, so no retry can double-pay.

Note the client's own `requiredTransport` guard (toon-client#558) does not
cover this case: not one live kind:10032 announce carries that field, so the
guard never fires against the current fleet. `@toon-protocol/client` is bumped
to `^0.29.7` for the #558/#563 guards regardless — they are the second line of
defence once an announce does declare it, and #563's 402-driven retry needs a
`btpUrl` to retry ONTO, which is exactly what this change supplies.

A further bump will be wanted once a client carrying toon-client#569
(`Http401RequiresBtpError` — a 401→BTP retry, the exact failure seen here) and
#571 (stop sending the unbacked `ILP-Peer-Id`, so the 401 never happens) is
published; neither is on npm yet, and neither is needed for this fix to work.
When they ship, rig could drop `preferBtpForPaidWrites` back to an opt-in and
let HTTP-first stand, since the 401 would either not occur or self-recover.

**Leaked on-chain payment channels.** `ChannelManager.peerChannels` is keyed
by the composite binding key `<peerId>|<chain>|<tokenNetwork>`
(toon-client#489), not the bare peer id. Rig read that key back as if it WERE
a peer id, so `peerNegotiations.get(...)` missed and a freshly opened channel
was never recorded — rig warned `opened channel 0x… but could not record the
peer→channel mapping` and the next invocation had nothing to resume. It also
seeded resumed channels under the bare peer id, a key `ensureChannel` never
looks up. Both sides now spell the binding key the way the client does (with
pre-#489 bare keys still read correctly), so one channel serves every
invocation. On a devnet where gas is the scarce resource, each duplicate open
was a real cost. The unit mocks keyed `peerChannels` by the bare peer id too,
which is why the suite stayed green through the regression; they now mirror
the client's real key.

The topology cache key gains a schema tag, so entries written before this
change cannot shadow the new resolution for a TTL after upgrading.
