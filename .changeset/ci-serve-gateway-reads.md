---
'@toon-protocol/rig': minor
---

`rig ci serve` reads through the gateway it links to (#134).

The coordinator's `--gateway` only named where log and artifact links point; a
commit's objects were always read through the shared public gateway list. A
coordinator pointed at a private or local gateway — the packaged image against
the TOON sandbox, whose gateway serves bytes at `/raw/<txId>` only — could
therefore never materialize a commit. Now `--gateway` (or `RIG_ARWEAVE_GATEWAY`
when the flag is absent, the variable `rig push` and `rig site` already honour)
is also the first place the coordinator reads objects from, on the store's
raw-bytes route `<gateway>/raw/<txId>`, before falling back to the shared list.
The sandbox integration test gives the coordinator no fetch seam any more, so
it proves the same read path the Docker image uses.
