---
'@toon-protocol/rig': patch
---

CI 1 (#126): close the two evidence gaps in the Runner seam's tests. `FakeRunner`
is now driven with a multi-job workflow (mixed conclusions, exit codes, timings,
per-job logs and artifacts, one `onLog` call per job), and `materializeCommit` +
`discoverWorkflows` are tested together on a materialized checkout: the exact tree
lands (`git ls-tree -r` equality) and the workflow list carries paths from both
`.github/workflows/` and `.ngit/act/workflows/` with the SHA-256 of each file's
bytes. Tests only; no runtime change.
