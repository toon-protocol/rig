import { describe, it, expect, vi } from 'vitest';
import { executeFactoryJob, type FactoryJobHooks } from './factory-job-execute.js';
import type { JobDeliveryPort } from './factory-job-delivery.js';
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
  { id: '2', title: 'fix B', branch: 'sandcastle/issue-2' },
];

/** A fake Publisher that assigns incrementing fake event ids / tx ids. */
function fakePublisher(): Publisher & {
  publishedEvents: UnsignedEvent[];
  uploadedBodies: Buffer[];
} {
  const publishedEvents: UnsignedEvent[] = [];
  const uploadedBodies: Buffer[] = [];
  let eventCounter = 0;
  let txCounter = 0;

  return {
    publishedEvents,
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
      event: UnsignedEvent,
      _relayUrls: string[]
    ): Promise<PublishReceipt> {
      publishedEvents.push(event);
      eventCounter += 1;
      return { eventId: `event${eventCounter}`, feePaid: 0n };
    },
  };
}

/** A fake JobDeliveryPort — deterministic "encryption" and configurable payment. */
function fakeDelivery(payDecisions: boolean[] = []): JobDeliveryPort {
  let call = 0;
  return {
    async encryptArtifact(bytes) {
      return {
        ciphertext: bytes,
        ciphertextSha256: `sha-${bytes.length}`,
        conditionHex: `cond-${bytes.length}`,
      };
    },
    async waitForPayment() {
      const decision = payDecisions[call] ?? true;
      call += 1;
      return decision;
    },
  };
}

function fakeHooks(overrides: Partial<FactoryJobHooks> = {}): FactoryJobHooks {
  return {
    plan: vi.fn(async () => ({
      tickets: TICKETS,
      artifact: new TextEncoder().encode('the plan'),
    })),
    implement: vi.fn(async (ticket) =>
      new TextEncoder().encode(`diff for ${ticket.id}`)
    ),
    review: vi.fn(async () => new TextEncoder().encode('merged PR')),
    ...overrides,
  };
}

describe('executeFactoryJob', () => {
  it('completes a job that pays every increment', async () => {
    const publisher = fakePublisher();
    const delivery = fakeDelivery();
    const hooks = fakeHooks();

    const result = await executeFactoryJob({
      job: JOB,
      requestEvent: REQUEST_EVENT,
      hooks,
      publisher,
      delivery,
      relayUrls: ['wss://relay.example'],
    });

    expect(result.outcome).toBe('completed');
    expect(result.totalIncrements).toBe(4); // plan + 2 tickets + review
    expect(result.reachedIncrement).toBe(4);

    // quote + 4 offers + result = 6 published events
    expect(publisher.publishedEvents).toHaveLength(6);
    expect(publisher.publishedEvents[0]?.tags).toEqual(
      expect.arrayContaining([['status', 'quote']])
    );
    const statuses = publisher.publishedEvents.map(
      (e) => e.tags.find((t) => t[0] === 'status')?.[1]
    );
    expect(statuses).toEqual(['quote', 'partial', 'partial', 'partial', 'partial', undefined]);

    const last = publisher.publishedEvents[publisher.publishedEvents.length - 1];
    expect(last?.tags).toEqual(expect.arrayContaining([['outcome', 'completed']]));
  });

  it('runs implement once per ticket, never lumping them into one increment', async () => {
    const publisher = fakePublisher();
    const delivery = fakeDelivery();
    const hooks = fakeHooks();

    await executeFactoryJob({
      job: JOB,
      requestEvent: REQUEST_EVENT,
      hooks,
      publisher,
      delivery,
      relayUrls: [],
    });

    expect(hooks.implement).toHaveBeenCalledTimes(2);
    expect(hooks.implement).toHaveBeenNthCalledWith(1, TICKETS[0]);
    expect(hooks.implement).toHaveBeenNthCalledWith(2, TICKETS[1]);
  });

  it('halts on the first unpaid increment (abandoned-buyer) and does no further work', async () => {
    const publisher = fakePublisher();
    // plan (1) paid, first implement increment (2) NOT paid.
    const delivery = fakeDelivery([true, false]);
    const hooks = fakeHooks();

    const result = await executeFactoryJob({
      job: JOB,
      requestEvent: REQUEST_EVENT,
      hooks,
      publisher,
      delivery,
      relayUrls: [],
    });

    expect(result.outcome).toBe('abandoned-buyer');
    expect(result.reachedIncrement).toBe(1); // plan was paid; increment 2 was not
    expect(result.totalIncrements).toBe(4);
    // Only ticket 1's implement should have run — ticket 2 and review never start.
    expect(hooks.implement).toHaveBeenCalledTimes(1);
    expect(hooks.review).not.toHaveBeenCalled();

    // quote + plan offer + implement-1 offer + result = 4 events, no i-tag on the result.
    expect(publisher.publishedEvents).toHaveLength(4);
    const resultEvent = publisher.publishedEvents[3];
    expect(resultEvent?.tags.some((t) => t[0] === 'i')).toBe(false);
  });

  it('halts as abandoned-buyer if increment 1 (plan) itself is never paid', async () => {
    const publisher = fakePublisher();
    const delivery = fakeDelivery([false]);
    const hooks = fakeHooks();

    const result = await executeFactoryJob({
      job: JOB,
      requestEvent: REQUEST_EVENT,
      hooks,
      publisher,
      delivery,
      relayUrls: [],
    });

    expect(result.outcome).toBe('abandoned-buyer');
    expect(result.reachedIncrement).toBe(0);
    expect(hooks.implement).not.toHaveBeenCalled();
  });

  it('halts as abandoned-provider when a hook throws mid-job, without retrying', async () => {
    const publisher = fakePublisher();
    const delivery = fakeDelivery();
    const hooks = fakeHooks({
      implement: vi.fn(async (ticket) => {
        if (ticket.id === '2') throw new Error('sandbox crashed');
        return new TextEncoder().encode('diff for 1');
      }),
    });

    const result = await executeFactoryJob({
      job: JOB,
      requestEvent: REQUEST_EVENT,
      hooks,
      publisher,
      delivery,
      relayUrls: [],
    });

    expect(result.outcome).toBe('abandoned-provider');
    expect(result.reachedIncrement).toBe(2); // plan + ticket 1 were paid
    expect(hooks.review).not.toHaveBeenCalled();
  });

  it('propagates a plan-phase failure without publishing any event', async () => {
    const publisher = fakePublisher();
    const delivery = fakeDelivery();
    const hooks = fakeHooks({
      plan: vi.fn(async () => {
        throw new Error('could not read the repo');
      }),
    });

    await expect(
      executeFactoryJob({
        job: JOB,
        requestEvent: REQUEST_EVENT,
        hooks,
        publisher,
        delivery,
        relayUrls: [],
      })
    ).rejects.toThrow('could not read the repo');

    expect(publisher.publishedEvents).toHaveLength(0);
  });

  it('never reuses an encryption condition across increments', async () => {
    const publisher = fakePublisher();
    const delivery: JobDeliveryPort = {
      async encryptArtifact(bytes) {
        return {
          ciphertext: bytes,
          ciphertextSha256: `sha-${Math.random()}`,
          conditionHex: `cond-${Math.random()}`,
        };
      },
      async waitForPayment() {
        return true;
      },
    };
    const hooks = fakeHooks();

    await executeFactoryJob({
      job: JOB,
      requestEvent: REQUEST_EVENT,
      hooks,
      publisher,
      delivery,
      relayUrls: [],
    });

    const conditions = publisher.publishedEvents
      .map((e) => e.tags.find((t) => t[0] === 'condition')?.[1])
      .filter((c): c is string => c !== undefined);

    expect(new Set(conditions).size).toBe(conditions.length);
  });

  it('throws a clear error when the publisher cannot upload blobs', async () => {
    const publisher = fakePublisher();
    delete (publisher as { uploadBlob?: unknown }).uploadBlob;
    const delivery = fakeDelivery();
    const hooks = fakeHooks();

    await expect(
      executeFactoryJob({
        job: JOB,
        requestEvent: REQUEST_EVENT,
        hooks,
        publisher,
        delivery,
        relayUrls: [],
      })
    ).rejects.toThrow(/uploadBlob/);
  });
});
