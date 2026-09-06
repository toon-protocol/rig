---
'@toon-protocol/rig': minor
---

Size is priced, not refused; and `rig chain set mina` is actually refused

**Object size (#102).** `MAX_OBJECT_SIZE` was `95 * 1024` (97,280), described as
a "95KB safety margin under the 100KB free tier". The upstream publishes no
100KB limit — it publishes **107,520**, twice, as `freeUploadLimitBytes` and
`freeTier.maxItemBytes` at `https://upload.ardrive.io/`. So the margin sat under
a number that was never upstream's, and refused ~10 KiB of objects the upstream
would have taken for free.

Worse, it was a *hard error*: an object over it aborted the whole push. That
made sense when every upload was flat-priced, but the store route is metered —
`g.toon.relay.store` advertises `{price: "1001", pricePerKib: "10"}`, and that
per-KiB term exists precisely so size can be charged for.

- `FREE_TIER_MAX_ITEM_BYTES = 107_520` replaces it, and is a **pricing
  boundary, not a cap**: at or under it an object rides the free tier, above it
  the object uploads and is paid for per KiB.
- The hard errors are gone from `planPush`, `uploadGitObject` and `uploadBlob`.
  A large object is now a more expensive line in the fee table the user
  confirms, not a refusal — verified against the live devnet connector, where a
  204,800-byte blob (nearly 2× the free ceiling) plans and prices at 6,724 base
  units rather than erroring, against 4,004 if it were still flat-priced.
- `MAX_OBJECT_SIZE` remains as a deprecated alias, and `OversizeObjectsError` /
  `OversizeObject` remain exported but are **never thrown** — a `catch` for them
  is now dead code.

**`rig chain set mina`.** The 4.0.0 changelog says Mina is gone and that
`rig chain set mina` is refused. Nothing refused it: it exited **0**, printed
"Settlement chain set to mina → spends Mina USDC", and wrote `"chain": "mina"`
to the config — pinning a settlement chain no paid command can use. It is now
refused by name, writing nothing, and says what happened to Mina rather than
falling through to a generic "unknown chain". `mina:`-prefixed full chain ids
are refused the same way. `rig --help` and `rig chain --help` no longer offer
it.
