---
'@toon-protocol/rig': minor
---

A patch's branch is now visible instead of invisible-and-mislabeled (rig#161). rig used to write a `rig pr create --branch` value into a kind:1617 patch's `t` tag, while both of rig's own readers (`rig pr list`/`rig pr show` and rig-web's parser) looked for a tag named `branch` — so the branch never showed up as a branch and was misreported as a label instead.

`buildPatch` now writes the branch to `branch-name` — the tag name confirmed against the NIP-34 source at implementation time (it is the exact tag kind:1618 pull requests use; rig's kind:1617 patches now use the same spelling) — and never to `t`. Readers (`rig pr list`/`rig pr show` and rig-web) look for `branch-name` first, then fall back to the legacy `branch` tag for old events. A patch that only ever carried its branch in `t` is left exactly as it renders today: no heuristic guesses which `t` value was a branch, so it still shows as a label, not a branch.

`@toon-protocol/rig-web` picks up the same reader fix (`packages/rig-web/src/web/nip34-parsers.ts`) but is not independently versioned — it is excluded from changesets in this repo (`.changeset/config.json`) and ships from `main`.
