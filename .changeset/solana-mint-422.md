---
'@toon-protocol/rig': patch
---

Re-pin the devnet Solana mock-USDC mint in the settlement-contracts table.

The README's `solana:devnet` row named `xyc5J8MgKFiEN13PnfftdXxUzYH34FEvw1LCrFwN7in`,
whose mint authority is lost — nobody can mint it, and the faucet cannot drip it. The
live devnet settlement token is `34eSxY7qxQ4GzyhDJ8GpUcTz1WWzruGbJbR8q6TtxfQU`
(connector#1212). Documentation only.
