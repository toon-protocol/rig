---
---

chore(rig): make the deliberate empty-catch in `balance.ts`'s `readWalletBounded` non-empty-bodied (`.catch(() => undefined)` instead of `.catch(() => {})`) to satisfy `@typescript-eslint/no-empty-function`, and register `eslint-plugin-react-hooks` so `packages/rig-web`'s three pre-existing `exhaustive-deps` disable comments target a real rule (slice 8 of #3, closes #30). Behavior-preserving — same rejection-swallowing semantics — so `@toon-protocol/rig` needs no version bump.
