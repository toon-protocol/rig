---
---

chore(rig): narrow the `process.stderr.write` overload in `calmBootstrapNoise` so `packages/rig` core typechecks clean (TS2345, first slice of #3). Type-level only — the `as` cast erases and both branches call `original.call` with the same arguments, so the emitted JS is unchanged and `@toon-protocol/rig` needs no version bump.
