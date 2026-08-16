---
'@toon-protocol/rig': patch
---

`rig name buy/set --via` travel the paid ILP path instead of a bare fetch

`--via` used to do a raw `fetch(${viaUrl}/store)`. No connector serves
`/store`, so the brokered ArNS path could not work against any node:

| endpoint | `/store` | `/ilp` |
|---|---|---|
| `dvm.devnet.toonprotocol.dev` (the shipped default) | 404 | — |
| a third-party node's client edge | 404 | 400 |
| `proxy.ario.devnet.toonprotocol.dev` | 404 | 400 |

The endpoint is absent by design, not by oversight. The store sits behind the
connector's payment termination, so a publicly reachable `POST /store` is an
unpaid path to a paid handler — the free-gateway failure ADR 0020 names, and
the exact door the devnet store box closed on 2026-08-05 (it let anyone spend
that box's funded Arweave wallet for free). The default `dvm.` hostname is a
second dead end on top of that: it maps to the store's BLS **health** server,
whose app registers exactly one route, `GET /health`.

So `--via` changes meaning: it now names an **ILP destination**, and the job
rides a paid packet with `/store` as the envelope target beneath the route's
handler path — the same transport `rig push` already uses for kind:5094
git-object writes. The kind:5095/5096 `param` tags are unchanged, so the
handler sees the identical event either way.

- `Publisher` gains an optional `submitStoreJob`, following `uploadBlob`'s
  optional-method pattern. A DVM refusal comes back as **data rather than an
  exception**: under ADR 0020 `accept: false` arrives on a FULFILL and the
  payer was charged either way, and the zero-ARIO rehearsal (submit a buy with
  no `processId`, watch the handler refuse by name before it quotes or touches
  the registry) is the cheapest proof the whole paid path works.
- `StandalonePublisher.submitStoreJob` mirrors `uploadGitObject`: the store
  leg's own channel, one claim at the store route's flat price, a `bid` tag
  carrying that same figure, `proxyPath: '/store'`.
- `StandaloneLoadOptions` gains `storeDestination`, at highest precedence over
  `TOON_CLIENT_STORE_DESTINATION` and the config file, since it is a
  per-invocation choice rather than a setting.
- The devnet default is repointed from the unreachable
  `https://dvm.devnet.toonprotocol.dev` to the ILP destination `g.toon.ario`,
  which is the path that is actually paid and actually works.
- The override is weighed in `createStandaloneContext`'s announce-discovery
  gate too. Without that, a config pinning store == publish reads as fully
  explicit, discovery is skipped, and the announce of the node `--via` actually
  names — the only thing carrying its uplink, price and channel — is never
  fetched. A pinned `storeBtpUrl` likewise vouches for nothing once `--via`
  names a different node.
- A URL in `--via` is **rejected** with the destination form in the error,
  rather than failing later as an unroutable address. A URL means the caller
  still expects the old direct-POST path.
- `RIG_ARNS_DVM_DESTINATION` is the env spelling; `RIG_ARNS_DVM_URL` is still
  read so an existing environment keeps working, and `DEVNET_DVM_URL` stays
  exported as a deprecated alias of `DEVNET_DVM_DESTINATION`.
