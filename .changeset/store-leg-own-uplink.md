---
'@toon-protocol/rig': patch
---

Pay store writes on the store node's own channel

On a fleet where the store route terminates on a different node than
publishes, `rig push` signed the git-object claim on the PUBLISH channel and
sent it to the store node, which refuses it outright — `F01 - claim rejected:
names a channel this connector has no record of`. There is no transit to lean
on either: the publish node's only route is its own publish prefix, so the
store has to be reached directly.

The store leg now gets its own uplink, resolved from the store node's own
kind:10032 announce (each node publishes only its own BTP ingress), its own
payment channel against that node's settlement address, and its own watermark
file — two live clients pointed at one channel store clobber each other's
watermarks. It is built lazily on the first store write, so a publish-only run
opens no second on-chain channel.

Two supporting fixes fell out of it:

- Route prices are now read from `routePrices`, the shape the live connector
  actually publishes, in addition to the older `capabilities` array — and from
  the announce of whichever node terminates the address, since each node
  prices its own routes. Without this the upload fee floored at 0 and the
  store answered `F03 - claim rejected: advances value by 0, less than this
  route's price`.
- A config pinning a store route on a different node is no longer treated as
  "fully explicit" unless it also pins that node's uplink (`storeBtpUrl` /
  `TOON_CLIENT_STORE_BTP_URL`). It previously skipped discovery entirely and
  so never learned the store endpoint.
