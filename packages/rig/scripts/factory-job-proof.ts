#!/usr/bin/env -S npx tsx
/**
 * factory-job-proof.ts — the runnable proof issue #56 asks for: one paid
 * factory-job increment, end to end, against the live devnet, using the
 * concrete `ClientJobDeliveryPort` (../src/factory-job-delivery-client.ts)
 * and buyer-side `payIncrementOffer`/`decryptIncrementArtifact`
 * (../src/factory-job-pay.ts) — both wired to the REAL, published
 * `@toon-protocol/client@^0.26.0`, never to a fake.
 *
 * Two identities, each a real `ToonClient` against the public devnet
 * (../README.md's "Devnet reference"):
 *
 *   1. Provider encrypts a trivial increment artifact
 *      (`ClientJobDeliveryPort.encryptArtifact`) — mints a fresh key and
 *      `condition = sha256(key)`. Never re-derived locally, per the issue.
 *   2. Provider's `ToonClient` is started with `jobHandler:
 *      delivery.handleJob` (toon-client#494) — the connector delivers a
 *      buyer's paying PREPARE addressed to the provider as a
 *      server-originated BTP MESSAGE, and the handler answers with the
 *      revealed key as the ILP fulfillment.
 *   3. Buyer pays via `payIncrementOffer` — `executionCondition` equal to
 *      the offer's `condition` byte for byte, `data` carrying a reference
 *      back to the (synthetic, for this script) offer id — per
 *      docs/factory-job-protocol.md §4.2 (toon-meta). The relay leg (the
 *      actual kind:7000 event) is exercised separately by
 *      `executeFactoryJob`'s own tests (#52/#53); this script's job is the
 *      CONNECTOR leg, which nothing in this repo has run against a live
 *      network before.
 *   4. Buyer decrypts the artifact using ONLY the key revealed as the ILP
 *      fulfillment (`decryptIncrementArtifact`) — no other channel ever
 *      carries it.
 *   5. Assert the thesis (toon-meta#262's whole point): the provider's
 *      `getClaimState()` credited/spendable position rises by the
 *      increment price minus the connector's fee, with the on-chain
 *      deposit UNCHANGED across the run (no settlement).
 *
 * Usage (from packages/rig):
 *   npx tsx scripts/factory-job-proof.ts
 *
 * Env (all optional):
 *   FACTORY_JOB_PROOF_PROVIDER_MNEMONIC   BIP-39 mnemonic for the provider identity.
 *                                         Default: generate + faucet-fund a fresh one.
 *   FACTORY_JOB_PROOF_BUYER_MNEMONIC      BIP-39 mnemonic for the buyer identity.
 *                                         Default: generate + faucet-fund a fresh one.
 *   FACTORY_JOB_PROOF_PROXY_URL           default https://proxy.devnet.toonprotocol.dev
 *   FACTORY_JOB_PROOF_BTP_URL             default wss://proxy.devnet.toonprotocol.dev:443
 *   FACTORY_JOB_PROOF_FAUCET_URL          default https://faucet.devnet.toonprotocol.dev
 *   FACTORY_JOB_PROOF_AMOUNT_USDC         increment price, micro-USDC (default "10000" = 0.01 USDC)
 *   FACTORY_JOB_PROOF_SKIP_FUND=1         skip the faucet drip (identity already funded)
 *
 * Safe to re-run: every run mints a fresh key/condition (never reuses one),
 * and by default a fresh identity is generated so repeat runs never collide
 * on nonce/claim state.
 *
 * GAS NOTE: opening the provider's on-chain settlement channel is a real
 * Base Sepolia transaction and needs Base Sepolia ETH, which the devnet
 * faucet's `/api/base-sepolia/request` route drips on a best-effort basis
 * (`"eth":{"dripped":false,"reason":"faucet ETH balance below reserve+drip"}`
 * when the faucet's OWN reserve is low — observed while developing this
 * script). If `ToonClient.openChannel()` fails with `ChannelFundingError`
 * ("no gas on evm"), the faucet's reserve is the thing to refill (or supply
 * an already-gassed `FACTORY_JOB_PROOF_PROVIDER_MNEMONIC`), not a bug here.
 */
import {
  ToonClient,
  fundWallet,
  generateMnemonic,
  deriveFullIdentity,
  type ClaimStateResult,
} from '@toon-protocol/client';
import { ClientJobDeliveryPort } from '../src/factory-job-delivery-client.js';
import {
  decryptIncrementArtifact,
  payIncrementOffer,
} from '../src/factory-job-pay.js';

const PROXY_URL =
  process.env['FACTORY_JOB_PROOF_PROXY_URL'] ??
  'https://proxy.devnet.toonprotocol.dev';
const BTP_URL =
  process.env['FACTORY_JOB_PROOF_BTP_URL'] ??
  'wss://proxy.devnet.toonprotocol.dev:443';
const FAUCET_URL =
  process.env['FACTORY_JOB_PROOF_FAUCET_URL'] ??
  'https://faucet.devnet.toonprotocol.dev';
const AMOUNT_USDC = process.env['FACTORY_JOB_PROOF_AMOUNT_USDC'] ?? '10000';
const SKIP_FUND = process.env['FACTORY_JOB_PROOF_SKIP_FUND'] === '1';

// GOTCHA (found running this script against the live devnet, not documented
// anywhere else): `network: 'devnet'`'s own EVM preset computes its chain id
// as `evm:base:84532` (`resolveClientNetwork`'s `evmClientId`, family-qualified),
// but the devnet apex's live kind:10032 announce advertises `evm:84532`
// (unqualified — matching this README's own "Devnet reference" table). The
// two never intersect, so a bare `network: 'devnet'` client can NEVER
// negotiate EVM with the apex — chain negotiation (`negotiateSettlementChain`,
// first mutually-supported chain, `@toon-protocol/core`) always falls through
// to `solana:devnet`, which then needs a natively-funded Solana wallet
// (lamports for channel-account rent) that the faucet's USDC-only route does
// not provide, and the devnet's own SOL-drip route is externally rate-limited
// by Solana's public devnet faucet (observed: HTTP 429, "airdrop limit").
//
// Workaround: opt OUT of the preset (`network: 'custom'`) and hand-wire the
// EVM chain's parameters verbatim from the live announce / this README's
// "Settlement contracts" table below, so `supportedChains` contains ONLY
// `evm:84532` — the announce's own id, guaranteed to intersect.
const EVM_CHAIN = 'evm:84532';
const EVM_RPC_URL = 'https://base-sepolia-rpc.publicnode.com';
const EVM_TOKEN_NETWORK = '0x1E95493fEF46707E034b4a1945f25a8C76A1823D';
const EVM_USDC_TOKEN = '0x49beE1Bca5d15Fb0963117923403F9498119a9Ce';
const EVM_SETTLEMENT_ADDRESS = '0xF29fD62C4848B9573C9b90adbF61b664F386d9CF';

function log(msg: string): void {
  console.log(`[factory-job-proof] ${msg}`);
}

async function resolveIdentity(envVar: string, label: string) {
  const mnemonic = process.env[envVar] ?? generateMnemonic();
  const identity = await deriveFullIdentity(mnemonic);
  log(
    `${label}: evm=${identity.evm.address} nostr=${identity.nostr.pubkey.slice(0, 16)}…` +
      (process.env[envVar] ? ' (from env)' : ' (freshly generated)')
  );
  return { mnemonic, identity };
}

async function fundIfNeeded(label: string, evmAddress: string): Promise<void> {
  if (SKIP_FUND) {
    log(`${label}: FACTORY_JOB_PROOF_SKIP_FUND=1 — skipping faucet drip`);
    return;
  }
  log(`${label}: requesting devnet faucet funds for evm ${evmAddress}…`);
  const evmResult = await fundWallet(FAUCET_URL, evmAddress, 'evm');
  log(`${label}: faucet (evm) responded — ${JSON.stringify(evmResult.response)}`);
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
  log(`OK — ${message}`);
}

async function main(): Promise<void> {
  const provider = await resolveIdentity(
    'FACTORY_JOB_PROOF_PROVIDER_MNEMONIC',
    'provider'
  );
  const buyer = await resolveIdentity('FACTORY_JOB_PROOF_BUYER_MNEMONIC', 'buyer');

  await fundIfNeeded('provider', provider.identity.evm.address);
  await fundIfNeeded('buyer', buyer.identity.evm.address);

  // The provider's own receiving address — this script controls both sides,
  // so it mints the address itself and hands it to the buyer directly,
  // exactly as `docs/factory-job-protocol.md`'s worked example (§7) does,
  // minus the relay leg (that's #52/#53's own tested territory).
  const providerDestination = `g.toon.${provider.identity.nostr.pubkey.slice(0, 16)}`;

  const delivery = new ClientJobDeliveryPort();

  // `network: 'custom'` opts out of the broken devnet preset (see the GOTCHA
  // above) — this is the only chain either identity supports, so negotiation
  // with the apex has exactly one possible outcome.
  const evmOnlyChainConfig = {
    network: 'custom' as const,
    supportedChains: [EVM_CHAIN],
    chainRpcUrls: { [EVM_CHAIN]: EVM_RPC_URL },
    tokenNetworks: { [EVM_CHAIN]: EVM_TOKEN_NETWORK },
    preferredTokens: { [EVM_CHAIN]: EVM_USDC_TOKEN },
    settlementAddresses: { [EVM_CHAIN]: EVM_SETTLEMENT_ADDRESS },
  };

  log('starting provider ToonClient (job-serving over BTP)…');
  const providerClient = new ToonClient({
    mnemonic: provider.mnemonic,
    ...evmOnlyChainConfig,
    proxyUrl: PROXY_URL,
    btpUrl: BTP_URL,
    faucetUrl: FAUCET_URL,
    ilpInfo: {
      pubkey: provider.identity.nostr.pubkey,
      ilpAddress: providerDestination,
      btpEndpoint: BTP_URL,
      assetCode: 'USD',
      assetScale: 6,
    },
    toonEncoder: (e) => new TextEncoder().encode(JSON.stringify(e)),
    toonDecoder: (b) => JSON.parse(new TextDecoder().decode(b)),
    jobHandler: delivery.handleJob,
  });
  await providerClient.start();

  log('starting buyer ToonClient (paid writes over the proxy)…');
  const buyerClient = new ToonClient({
    mnemonic: buyer.mnemonic,
    ...evmOnlyChainConfig,
    proxyUrl: PROXY_URL,
    faucetUrl: FAUCET_URL,
    ilpInfo: {
      pubkey: buyer.identity.nostr.pubkey,
      ilpAddress: 'g.toon.client',
      btpEndpoint: '',
      assetCode: 'USD',
      assetScale: 6,
    },
    toonEncoder: (e) => new TextEncoder().encode(JSON.stringify(e)),
    toonDecoder: (b) => JSON.parse(new TextDecoder().decode(b)),
  });
  await buyerClient.start();

  try {
    const providerChannelId = await providerClient.openChannel();
    log(`provider channel: ${providerChannelId}`);
    const before = await providerClient.getClaimState([providerChannelId]);
    log(`provider claim state BEFORE: ${JSON.stringify(before)}`);
    const beforeEntry = before[0];
    assert(
      beforeEntry?.ok === true,
      'provider claim state read before the run succeeded'
    );
    if (!beforeEntry || beforeEntry.ok !== true) {
      throw new Error('unreachable — asserted above');
    }

    // 1. Provider does the (trivial, one-increment) work and encrypts it.
    const plaintext = new TextEncoder().encode(
      'factory-job-proof increment artifact — issue #56'
    );
    const encrypted = await delivery.encryptArtifact(plaintext);
    log(`encrypted artifact — condition=${encrypted.conditionHex}`);

    // 2. Provider starts waiting for payment BEFORE the buyer can possibly
    //    pay (mirrors production: the provider is always listening first).
    const offerEventId = `factory-job-proof-${Date.now()}`;
    const waitForPayment = delivery.waitForPayment({
      offerEventId,
      conditionHex: encrypted.conditionHex,
      priceUsdc: AMOUNT_USDC,
    });

    // 3. Buyer pays the offer.
    log(`buyer paying increment offer for ${AMOUNT_USDC} micro-USDC…`);
    const payment = await payIncrementOffer(buyerClient, providerDestination, {
      offerEventId,
      conditionHex: encrypted.conditionHex,
      amountUsdc: AMOUNT_USDC,
    });

    const paid = await waitForPayment;
    assert(paid, 'the provider observed the increment as paid');
    assert(payment.paid, 'the buyer observed the PREPARE as accepted');
    if (!payment.paid) throw new Error('unreachable — asserted above');

    // 4. Buyer decrypts using ONLY the revealed fulfillment.
    const decrypted = decryptIncrementArtifact(
      encrypted.ciphertext,
      payment.key,
      encrypted.conditionHex
    );
    assert(
      new TextDecoder().decode(decrypted) === new TextDecoder().decode(plaintext),
      'the buyer decrypted the exact artifact using only the ILP fulfillment'
    );

    // 5. Assert the thesis: credited balance rose, no on-chain settlement.
    const after = await providerClient.getClaimState([providerChannelId]);
    log(`provider claim state AFTER: ${JSON.stringify(after)}`);
    const afterEntry = after[0];
    assert(
      afterEntry?.ok === true,
      'provider claim state read after the run succeeded'
    );
    if (!afterEntry || afterEntry.ok !== true) {
      throw new Error('unreachable — asserted above');
    }

    const availableOf = (entry: Extract<ClaimStateResult, { ok: true }>) =>
      BigInt(entry.available ?? entry.cumulativeClaimed);
    const beforeAvailable = availableOf(beforeEntry);
    const afterAvailable = availableOf(afterEntry);
    assert(
      afterAvailable > beforeAvailable,
      `provider's spendable headroom rose (${beforeAvailable} -> ${afterAvailable})`
    );
    assert(
      beforeEntry.depositTotal === afterEntry.depositTotal,
      `on-chain deposit is unchanged across the run (${beforeEntry.depositTotal}) — no on-chain settlement occurred`
    );

    log('PROOF COMPLETE — one paid factory-job increment, end to end.');
  } finally {
    await providerClient.stop();
    await buyerClient.stop();
  }
}

main().catch((err: unknown) => {
  console.error('[factory-job-proof] FAILED:', err);
  process.exitCode = 1;
});
