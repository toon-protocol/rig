/**
 * Integration test (#56): runs `executeFactoryJob` with the REAL
 * `ClientJobDeliveryPort` (provider) and the REAL `payIncrementOffer` /
 * `decryptIncrementArtifact` (buyer) wired to each other through a fake
 * connector that does nothing but forward a paying PREPARE to the
 * provider's `JobHandler` — exactly what a real connector's
 * server-originated BTP MESSAGE (toon-client#493/#494) does. Only the
 * relay (event publish) and Arweave (blob upload) legs are faked, the same
 * way `factory-job-execute.test.ts` fakes them for the pure-logic tests.
 *
 * This proves the encrypt → upload → offer → pay → fulfil → decrypt chain
 * end to end with the actual `@toon-protocol/client` hashlock helpers doing
 * the crypto — the one thing #52's `fakeDelivery()` test double could never
 * prove, since it never encrypts or fulfils anything for real.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { executeFactoryJob, type FactoryJobHooks } from './factory-job-execute.js';
import type { JobDeliveryPort, OfferedIncrement } from './factory-job-delivery.js';
import { ClientJobDeliveryPort } from './factory-job-delivery-client.js';
import {
  decryptIncrementArtifact,
  payIncrementOffer,
  type SwapPacketSender,
} from './factory-job-pay.js';
import type {
  BlobUpload,
  FeeRates,
  GitObjectUpload,
  Publisher,
  PublishReceipt,
  UploadReceipt,
} from './publisher.js';
import type { UnsignedEvent } from './nip34-events.js';
import type { FactoryJobRequest, RelayEvent } from './factory-job-events.js';
import type { FactoryTicket } from './factory-job-plan.js';

const BUYER_PUBKEY =
  '55c2a467881059a942fdc6908b041273885b8720bfa8fcf2f5f9c20a73b0964d';
const REQUEST_EVENT_ID =
  'deadbeef1234567890abcdef1234567890abcdef1234567890abcdef12345678';
const PROVIDER_DESTINATION = 'g.toon.provider';

const JOB: FactoryJobRequest = {
  requestEventId: REQUEST_EVENT_ID,
  buyerPubkey: BUYER_PUBKEY,
  brief: 'implement thread-focus-mode anchor deflake',
  bidMicroUsdc: '3000000',
  repo: 'toon-protocol/buzz',
};

const REQUEST_EVENT: RelayEvent = {
  id: REQUEST_EVENT_ID,
  pubkey: BUYER_PUBKEY,
  content: '',
  tags: [
    ['i', JOB.brief, 'text'],
    ['bid', JOB.bidMicroUsdc, 'usdc'],
  ],
};

const TICKETS: FactoryTicket[] = [
  { id: '1', title: 'fix A', branch: 'sandcastle/issue-1' },
];

function fakePublisher(): Publisher & { uploadedBodies: Buffer[] } {
  const uploadedBodies: Buffer[] = [];
  let eventCounter = 0;
  let txCounter = 0;
  return {
    uploadedBodies,
    async getFeeRates(): Promise<FeeRates> {
      return { uploadFee: 0n, eventFee: 0n };
    },
    async uploadGitObject(_upload: GitObjectUpload): Promise<UploadReceipt> {
      throw new Error('uploadGitObject should not be called by executeFactoryJob');
    },
    async uploadBlob(upload: BlobUpload): Promise<UploadReceipt> {
      uploadedBodies.push(upload.body);
      txCounter += 1;
      return { txId: `arTx${txCounter}`, feePaid: 0n };
    },
    async publishEvent(
      _event: UnsignedEvent,
      _relayUrls: string[]
    ): Promise<PublishReceipt> {
      eventCounter += 1;
      return { eventId: `event${eventCounter}`, feePaid: 0n };
    },
  };
}

/** Forwards a paying PREPARE straight to the provider's job handler. */
function connectorRoutingTo(port: ClientJobDeliveryPort): SwapPacketSender {
  return {
    async sendSwapPacket(params) {
      try {
        const answer = await port.handleJob({
          amount: params.amount,
          destination: params.destination,
          executionCondition: params.executionCondition ?? new Uint8Array(32),
          expiresAt: new Date(Date.now() + 30_000),
          data: params.toonData,
        });
        return {
          accepted: true,
          fulfillment: Buffer.from(answer.fulfillment).toString('base64'),
        };
      } catch (err) {
        return {
          accepted: false,
          code: 'F99',
          message: (err as Error).message,
        };
      }
    },
  };
}

/**
 * Wraps the real `ClientJobDeliveryPort` so every `waitForPayment` also
 * drives a real buyer-side `payIncrementOffer` against it — standing in for
 * the buyer, a separate process in production, reacting to the published
 * offer. Records each increment's revealed key so the test can assert the
 * decrypt step independently of `executeFactoryJob`'s own bookkeeping.
 */
function withAutoPayingBuyer(
  port: ClientJobDeliveryPort,
  connector: SwapPacketSender,
  revealedKeys: Map<string, Uint8Array>
): JobDeliveryPort {
  return {
    encryptArtifact: (bytes) => port.encryptArtifact(bytes),
    async waitForPayment(offer: OfferedIncrement): Promise<boolean> {
      // Arm the port BEFORE the buyer can possibly pay — mirrors production,
      // where the provider always starts waiting before a buyer's PREPARE
      // can arrive over the network.
      const armed = port.waitForPayment(offer);
      const payment = payIncrementOffer(connector, PROVIDER_DESTINATION, {
        offerEventId: offer.offerEventId,
        conditionHex: offer.conditionHex,
        amountUsdc: offer.priceUsdc,
      });
      const paid = await armed;
      const result = await payment;
      if (result.paid) revealedKeys.set(offer.offerEventId, result.key);
      return paid;
    },
  };
}

function fakeHooks(): FactoryJobHooks {
  return {
    plan: async () => ({
      tickets: TICKETS,
      artifact: new TextEncoder().encode('the plan document'),
    }),
    implement: async (ticket) => ({
      artifact: new TextEncoder().encode(`diff for ${ticket.id}`),
    }),
    review: async () => ({
      artifact: new TextEncoder().encode('the merged PR'),
    }),
  };
}

describe('executeFactoryJob with the real ClientJobDeliveryPort', () => {
  it('completes one paid increment end to end: encrypt -> upload -> offer -> pay -> fulfil -> decrypt', async () => {
    const port = new ClientJobDeliveryPort();
    const connector = connectorRoutingTo(port);
    const revealedKeys = new Map<string, Uint8Array>();
    const delivery = withAutoPayingBuyer(port, connector, revealedKeys);
    const publisher = fakePublisher();

    const execution = await executeFactoryJob({
      job: JOB,
      requestEvent: REQUEST_EVENT,
      hooks: fakeHooks(),
      publisher,
      delivery,
      relayUrls: ['wss://relay.example'],
    });

    expect(execution.outcome).toBe('completed');
    expect(execution.reachedIncrement).toBe(execution.totalIncrements);
    // plan, implement x1, review
    expect(execution.totalIncrements).toBe(3);
    expect(revealedKeys.size).toBe(3);

    // The buyer's key never travels except as the ILP fulfillment: decrypt
    // each uploaded ciphertext with its revealed key (increments run one at
    // a time, so upload order and reveal order line up) and confirm it
    // matches exactly what the provider encrypted.
    const expectedPlaintexts = [
      'the plan document',
      'diff for 1',
      'the merged PR',
    ];
    const keys = [...revealedKeys.values()];
    expect(keys).toHaveLength(3);
    keys.forEach((key, i) => {
      const ciphertext = publisher.uploadedBodies[i];
      if (!ciphertext) throw new Error(`missing uploaded ciphertext at index ${i}`);
      // `condition = sha256(key)` (§4.2) — recomputed here only to exercise
      // decryptIncrementArtifact's own condition-verification path.
      const conditionHex = createHash('sha256').update(key).digest('hex');
      const plaintext = decryptIncrementArtifact(ciphertext, key, conditionHex);
      expect(new TextDecoder().decode(plaintext)).toBe(expectedPlaintexts[i]);
    });
  });

  it('halts abandoned-buyer when the connector refuses to pay the first increment', async () => {
    const port = new ClientJobDeliveryPort({ paymentTimeoutMs: 20 });
    const neverPays: SwapPacketSender = {
      async sendSwapPacket() {
        return { accepted: false, code: 'F99', message: 'buyer walked away' };
      },
    };
    const revealedKeys = new Map<string, Uint8Array>();
    const delivery = withAutoPayingBuyer(port, neverPays, revealedKeys);
    const publisher = fakePublisher();

    const execution = await executeFactoryJob({
      job: JOB,
      requestEvent: REQUEST_EVENT,
      hooks: fakeHooks(),
      publisher,
      delivery,
      relayUrls: ['wss://relay.example'],
    });

    expect(execution.outcome).toBe('abandoned-buyer');
    expect(execution.reachedIncrement).toBe(0);
    expect(revealedKeys.size).toBe(0);
  });
});
