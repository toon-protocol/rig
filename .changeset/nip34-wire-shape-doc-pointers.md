---
'@toon-protocol/rig': patch
---

Document the NIP-34 wire contract in `docs/nip34-wire-shapes.md` (rig#163, the last ticket of spec rig#153) and point at it from the builders and parsers.

Per event kind — 30617, 30618, 1617, 1618/1619 (read-only), 1621, 1111, legacy 1622, 1630-1633 — it records the tags rig writes, the NIP-34/NIP-22 clause each one follows, every legacy shape rig still reads and the end condition for each, and the places rig deliberately departs from the NIP (`payout`, `arweave`, `branch-name` on a kind:1617, and the never-written `clone`).

Source change is comments only: `nip34-events.ts`, `nip34-refs.ts` and rig-web's `nip34-parsers.ts` gain a module-header pointer to the document, so a tag-shape change is made with the contract in view. No behavior change.
