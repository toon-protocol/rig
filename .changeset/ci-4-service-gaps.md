---
'@toon-protocol/rig': patch
---

CI 4 (#129): close the two evidence gaps in the coordinator's push-trigger
tests. A kind:30618 whose refs did not move — an `arweave`-map-only re-upload,
or a byte-identical republish — is now shown to run nothing while still
advancing the persisted cursor, and a tag move (`refs/tags/v1`) is shown to run
only the workflows whose `on: push` filter matches tags, with `o = push` and
`r = refs/tags/v1` on the published events while a `branches: [main]` workflow
stays quiet (and vice versa on the next branch move). Tests only; no runtime
change.
