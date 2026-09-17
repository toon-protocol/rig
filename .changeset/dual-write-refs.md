---
'@toon-protocol/rig': minor
---

Write repository state refs in both NIP-34 and legacy shapes on push (rig#157).

A `rig push` now publishes every ref in the kind:30618 repository state event in the NIP-34 shape `[<refPath>, "<sha>"]` — the ref path as the tag name — alongside rig's legacy `["r", <refPath>, "<sha>"]`, with identical SHAs for each ref. `HEAD` and the `arweave` object map are unchanged.

This makes a rig-pushed repo's branches and tags visible to ngit, gitworkshop.dev and any other conformant NIP-34 client, while rig installs older than this release — which only read the legacy shape — keep fetching without any change on their end. An event produced by this writer parses to the same refs through rig's dual-shape reader (rig#156) and through a legacy-only reader.

The legacy `r` write is removed in a later, separately ticketed change once rig versions older than this release are no longer supported.
