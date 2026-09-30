---
'@toon-protocol/rig': major
---

Pay with x402 `batch-settlement` vouchers on `@toon-protocol/client` 4.x (connector ADR 0075). A current connector refuses the toon-channel claims client 3.x signed.

- The client's channel store defaults to `<TOON_CLIENT_HOME>/channels-x402.json` and rig's channel map to `rig-channels-x402.json`. A client 3.x `channels.json` / `rig-channels.json` is never read or written, only named; a `channelStorePath` that points at a 3.x store is refused.
- No nonce: `rig channel list` and `rig balance` drop the `nonce` field and show the running total signed.
- `rig channel open --deposit` tops up a Base channel only; a Solana channel is replaced by a fresh sponsored one when it runs out. `rig channel close` / `settle` drive the client's exit, which walks every channel held with the node.
- The channel a paid command drew on is recorded in the map when the command ends.
- New knob `TOON_CLIENT_FACILITATOR_URL` / `facilitatorUrl` for a Base deposit; rig warns which chain it pays on when the node offers several and none is configured.
