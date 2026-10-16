---
'@toon-protocol/rig': minor
---

A declared maintainer can run `rig push` against the owner's repo (`toon.owner`): the fast-forward check runs against the honored repo state, refs not being pushed are carried over, and a diverged ref is refused before any fee is paid (`non_fast_forward` under `--json`) unless `--force` is given.
