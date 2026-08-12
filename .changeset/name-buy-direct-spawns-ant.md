---
'@toon-protocol/rig': patch
---

`rig name buy` (direct, wallet-paid path): spawn our own ANT before registering, and never exit 0 with no ANT attached.

The direct buy path went straight to `buyRecord` and collapsed the result to
`receipt.processId ?? null` — nothing on that path ever spawned an ANT, so the
name registered against the ar.io registry's all-ones placeholder
(`11111111111111111111111111111111`) and could never resolve. The path now
spawns an ANT first (mirroring the existing `--via` brokered path) and passes
its process id into `buyRecord`; the reported `antProcessId` is the ANT we
spawned (the SDK echoes back no process id of its own), never the old
`receipt.processId ?? null`.

A buy that ends without an ANT attached — whether `spawnAnt` throws (aborts
before any spend) or the registry echoes back the placeholder — now exits
non-zero and, when the purchase itself went through, still reports the
registry tx id so the spend stays recoverable.

The placeholder is now treated as "no ANT" everywhere an ANT process id is
accepted or reported, not just on the buy path. The `getArNSRecord` seam
normalizes it to `null`, so `rig name set` refuses a placeholder-registered
name with a clear error instead of building and signing a record update
against the Solana System Program, and `rig name status` prints
`ANT process: NONE — no ANT is attached`, marks `antMissing: true` in
`--json` (with `record.antProcessId: null` and a `hint`), and exits non-zero
rather than reporting a broken registration as healthy.
