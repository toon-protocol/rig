---
'@toon-protocol/rig': patch
---

`rig pr merge` now applies the whole multi-event patch series (a root 1617 plus its `e`-replying follow-ons, as ngit sends them) in one isolated `git am`, gates `--require-ci-trust` on the series' final commit, and names every applied SHA in the applied status.
