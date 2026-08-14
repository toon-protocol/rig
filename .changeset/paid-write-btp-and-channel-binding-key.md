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
(genesis seed as the fallback) whenever no uplink was pinned explicitly, and
the embedded client is built with `preferBtpForPaidWrites` (toon-client#482)
so claims ride the BTP session, which authenticates on connect. The proxy
stays in place as the HTTP leg the x402 greeting bootstrap (connector #617)
needs, and as the BTP transport's own fallback; an explicitly pinned
`proxyUrl`/`btpUrl` is never overridden. Reads, fee estimates and the channel
open are unchanged.

Note the client's own `requiredTransport` guard (toon-client#558) does not
cover this case: not one live kind:10032 announce carries that field, so the
guard never fires against the current fleet. `@toon-protocol/client` is bumped
to `^0.29.7` for the #558/#563 guards regardless — they are the second line of
defence once an announce does declare it, and #563's 402-driven retry needs a
`btpUrl` to retry ONTO, which is exactly what this change supplies.

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
