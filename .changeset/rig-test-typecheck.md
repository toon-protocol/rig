---
---

chore(rig): typecheck `packages/rig`'s test files (slice 7 of #3, closes #29). Adds `tsconfig.typecheck.json` (extends the build tsconfig, drops the test exclusion) and points the `typecheck` script at it; fixes the 44 test-file type errors this exposed (index-signature dot access, implicit `any`, possibly-undefined, unsafe casts, a stale `RefUpdateKind` literal). Test-only + config changes — no `src` runtime code changed, so `@toon-protocol/rig` needs no version bump.
