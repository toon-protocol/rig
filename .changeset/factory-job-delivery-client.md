---
'@toon-protocol/rig': minor
---

Wire `JobDeliveryPort` to the released `@toon-protocol/client` (#56): the last piece of toon-meta#262's "agents earning" epic — a real, runnable proof that one paid factory-job increment moves end to end.

Bumps `@toon-protocol/client` to `^0.26.0`, the first release carrying the hashlock-delivery (toon-client#495) and serve-side job handling (toon-client#494) helpers `JobDeliveryPort` was built against as an interface-only seam in #52.

New exports (`@toon-protocol/rig`):

- `ClientJobDeliveryPort` (`factory-job-delivery-client.ts`) — the concrete `JobDeliveryPort`. `encryptArtifact` calls `@toon-protocol/client`'s `encryptArtifact` directly (never re-derives the key/condition relationship, per the issue's explicit instruction); `handleJob` is a `JobHandler` to register as `ToonClientConfig.jobHandler` — it arms on `waitForPayment` and answers a matching job PREPARE with `fulfillIncrement(key)`, refusing (F99) anything else.
- `payIncrementOffer` / `decryptIncrementArtifact` (`factory-job-pay.ts`) — the buyer-side counterpart: builds the paying PREPARE via `buildIncrementPrepare` (`executionCondition` equal to the offer's `condition` byte for byte, `data` carrying the offer event id, per `docs/factory-job-protocol.md` §4.2), and decrypts via `decryptArtifact` once fulfilled.

`packages/rig/scripts/factory-job-proof.ts` (`pnpm factory-job-proof`) is the reproducible proof: two real `ToonClient`s against the live devnet, one paid increment, encrypt → upload → offer → pay → fulfil → decrypt, then asserts the provider's `getClaimState()` spendable balance rose with the on-chain deposit unchanged (no settlement). A new integration test (`factory-job-real-delivery.test.ts`) exercises the same chain — `executeFactoryJob` driven by the real `ClientJobDeliveryPort`/`payIncrementOffer`, only the relay/Arweave legs faked — without needing network access.

Gotcha found running the proof script against the live devnet, worth recording since nothing else documents it: `@toon-protocol/client@0.26.0`'s `network: 'devnet'` preset computes its EVM chain id as `evm:base:84532` (family-qualified), but the devnet apex's own kind:10032 announce advertises `evm:84532` (unqualified, matching this README's own tables) — the two never intersect, so a bare `network: 'devnet'` client can never negotiate EVM and always falls back to `solana:devnet`, which then needs a natively-funded Solana wallet the faucet's USDC-only route doesn't provide. The proof script works around it with `network: 'custom'` and the chain's parameters spelled out verbatim from the announce. Filed as a note on the ticket rather than "fixed" here — it lives in `@toon-protocol/client`/`@toon-protocol/core`, not this package.
