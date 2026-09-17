---
'@toon-protocol/rig': minor
---

Bound the kind:30618 object map at 2000 `arweave` tags, on write and on read (#162).

The sha→txId map was merged cumulatively into a single replaceable state event
and capped by nothing, so a large repository would eventually publish an event
relays reject. One constant, `MAX_ARWEAVE_TAGS_PER_EVENT`, now bounds it:

- **Write.** When the merged map exceeds the cap, entries are kept in priority
  order — the objects this push introduced first, then objects reachable from
  the new ref tips newest-first, then whatever merge-order hints still fit.
  A repository under the cap publishes a byte-identical map to before.
- **Read.** `fetchRemoteState` (and rig-web's `parseRepoRefs`) ingest at most
  the cap from one event, so a hostile relay cannot exhaust memory with a
  giant state event.

Nothing becomes unreachable. A dropped entry's object is still on Arweave under
its `Git-SHA` / `Repo` tags and resolves through the GraphQL resolver, which was
already the documented fallback — so clone and fetch are unchanged from a user's
point of view. Push planning already treated "absent from the map" as "ask the
resolver", never as "needs upload"; resume safety and never-pay-twice are
unchanged, and are now covered by tests that run with the cap saturated.

`rig fetch` also stops deriving "objects I already have" from the remote's
`arweave` map — it reads the local object database instead — so a capped map
never causes it to re-download history the repository already holds. Both of
these object walks are streamed and bounded, so the code the cap added cannot
itself fail on the very large repositories the cap exists for.

Fixes a latent bug in rig-web's `parseRepoRefs`: hitting the 1000-ref cap used
to abandon the whole tag loop, so a state event with more than 1000 refs parsed
an empty object map.
