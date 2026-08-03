import { describe, it, expect } from 'vitest';
import {
  FACTORY_JOB_FEEDBACK_KIND,
  FACTORY_JOB_RESULT_KIND,
  buildIncrementOfferEvent,
  buildNarrationEvent,
  buildQuoteEvent,
  buildResultEvent,
  parseFactoryJobRequest,
  type FactoryJobRequest,
  type RelayEvent,
} from './factory-job-events.js';
import type { IncrementSpec } from './factory-job-plan.js';

const BUYER_PUBKEY =
  '55c2a467881059a942fdc6908b041273885b8720bfa8fcf2f5f9c20a73b0964d';
const REQUEST_EVENT_ID =
  'deadbeef1234567890abcdef1234567890abcdef1234567890abcdef12345678';
const QUOTE_EVENT_ID =
  'aaaabbbb1234567890abcdef1234567890abcdef1234567890abcdef123456ab';

const JOB: FactoryJobRequest = {
  requestEventId: REQUEST_EVENT_ID,
  buyerPubkey: BUYER_PUBKEY,
  brief: 'implement thread-focus-mode anchor deflake',
  bidMicroUsdc: '5000000',
  repo: 'toon-protocol/buzz',
  target: 'buzz#56',
};

const SCHEDULE: IncrementSpec[] = [
  { n: 1, of: 3, milestone: 'plan', priceUsdc: '500000' },
  {
    n: 2,
    of: 3,
    milestone: 'implement',
    priceUsdc: '4000000',
    ticket: { id: '1', title: 'fix deflake', branch: 'sandcastle/issue-1' },
  },
  { n: 3, of: 3, milestone: 'review', priceUsdc: '500000' },
];

describe('parseFactoryJobRequest', () => {
  const rawEvent: RelayEvent = {
    id: REQUEST_EVENT_ID,
    pubkey: BUYER_PUBKEY,
    content: '',
    tags: [
      ['i', 'implement thread-focus-mode anchor deflake', 'text'],
      ['bid', '5000000', 'usdc'],
      ['param', 'repo', 'toon-protocol/buzz'],
      ['param', 'target', 'buzz#56'],
      ['param', 'constraints', 'no new deps'],
      ['output', 'application/json'],
    ],
  };

  it('extracts brief, bid, and repeatable param tags', () => {
    const job = parseFactoryJobRequest(rawEvent);

    expect(job.requestEventId).toBe(REQUEST_EVENT_ID);
    expect(job.buyerPubkey).toBe(BUYER_PUBKEY);
    expect(job.brief).toBe('implement thread-focus-mode anchor deflake');
    expect(job.bidMicroUsdc).toBe('5000000');
    expect(job.repo).toBe('toon-protocol/buzz');
    expect(job.target).toBe('buzz#56');
    expect(job.constraints).toBe('no new deps');
    expect(job.outputMime).toBe('application/json');
  });

  it('omits optional fields entirely when their tags are absent', () => {
    const job = parseFactoryJobRequest({
      id: REQUEST_EVENT_ID,
      pubkey: BUYER_PUBKEY,
      content: '',
      tags: [
        ['i', 'a brief', 'text'],
        ['bid', '1', 'usdc'],
      ],
    });

    expect(job.repo).toBeUndefined();
    expect(job.target).toBeUndefined();
    expect(job.constraints).toBeUndefined();
    expect(job.outputMime).toBeUndefined();
  });

  it('throws when the brief ("i", ..., "text") tag is missing', () => {
    expect(() =>
      parseFactoryJobRequest({
        id: REQUEST_EVENT_ID,
        pubkey: BUYER_PUBKEY,
        content: '',
        tags: [['bid', '1', 'usdc']],
      })
    ).toThrow(/brief/);
  });

  it('throws when the bid tag is missing', () => {
    expect(() =>
      parseFactoryJobRequest({
        id: REQUEST_EVENT_ID,
        pubkey: BUYER_PUBKEY,
        content: '',
        tags: [['i', 'a brief', 'text']],
      })
    ).toThrow(/bid/);
  });
});

describe('buildQuoteEvent (kind:7000 status:quote)', () => {
  it('carries the root e-tag, buyer p-tag, and status:quote', () => {
    const event = buildQuoteEvent(JOB, SCHEDULE);

    expect(event.kind).toBe(FACTORY_JOB_FEEDBACK_KIND);
    expect(event.tags).toEqual(
      expect.arrayContaining([
        ['e', REQUEST_EVENT_ID, '', 'root'],
        ['p', BUYER_PUBKEY],
        ['status', 'quote'],
      ])
    );
  });

  it('serializes the schedule as {increments: [{n, of, milestone, priceUsdc}]}', () => {
    const event = buildQuoteEvent(JOB, SCHEDULE);
    const content = JSON.parse(event.content) as {
      increments: {
        n: number;
        of: number;
        milestone: string;
        priceUsdc: string;
      }[];
    };

    expect(content.increments).toEqual([
      { n: 1, of: 3, milestone: 'plan', priceUsdc: '500000' },
      { n: 2, of: 3, milestone: 'implement', priceUsdc: '4000000' },
      { n: 3, of: 3, milestone: 'review', priceUsdc: '500000' },
    ]);
  });

  it('sums to no more than the bid', () => {
    const event = buildQuoteEvent(JOB, SCHEDULE);
    const content = JSON.parse(event.content) as {
      increments: { priceUsdc: string }[];
    };
    const sum = content.increments.reduce(
      (acc, i) => acc + BigInt(i.priceUsdc),
      0n
    );

    expect(sum <= BigInt(JOB.bidMicroUsdc)).toBe(true);
  });
});

describe('buildIncrementOfferEvent (kind:7000 status:partial)', () => {
  const implementIncrement = SCHEDULE.find((s) => s.milestone === 'implement');
  if (!implementIncrement) throw new Error('fixture SCHEDULE has no implement increment');

  const offer = buildIncrementOfferEvent({
    job: JOB,
    parentEventId: QUOTE_EVENT_ID,
    increment: implementIncrement,
    artifact: {
      arweaveTxId: 'arTx1',
      ciphertextSha256: 'a'.repeat(64),
      conditionHex: 'b'.repeat(64),
    },
  });

  it('carries root + reply e-tags, increment, artifact ref, amount, and condition', () => {
    expect(offer.kind).toBe(FACTORY_JOB_FEEDBACK_KIND);
    expect(offer.tags).toEqual(
      expect.arrayContaining([
        ['e', REQUEST_EVENT_ID, '', 'root'],
        ['e', QUOTE_EVENT_ID, '', 'reply'],
        ['p', BUYER_PUBKEY],
        ['status', 'partial'],
        ['increment', '2', '3'],
        ['i', 'arTx1', 'url'],
        ['i', 'a'.repeat(64), 'text', '', 'hash'],
        ['amount', '4000000', 'usdc'],
        ['condition', 'b'.repeat(64)],
      ])
    );
  });

  it("MUST NOT be mistaken for narration — status is never 'processing'", () => {
    const statusTag = offer.tags.find((t) => t[0] === 'status');
    expect(statusTag?.[1]).toBe('partial');
  });
});

describe('buildNarrationEvent (kind:7000 status:processing)', () => {
  it('carries content but no amount/condition/artifact tags (§6)', () => {
    const event = buildNarrationEvent({
      job: JOB,
      parentEventId: QUOTE_EVENT_ID,
      message: 'Increment 2 (implement): 3 of 4 tickets landed, running the gate now.',
    });

    expect(event.kind).toBe(FACTORY_JOB_FEEDBACK_KIND);
    expect(event.content).toBe(
      'Increment 2 (implement): 3 of 4 tickets landed, running the gate now.'
    );
    expect(event.tags).toEqual(
      expect.arrayContaining([
        ['e', REQUEST_EVENT_ID, '', 'root'],
        ['e', QUOTE_EVENT_ID, '', 'reply'],
        ['p', BUYER_PUBKEY],
        ['status', 'processing'],
      ])
    );
    expect(event.tags.some((t) => t[0] === 'amount')).toBe(false);
    expect(event.tags.some((t) => t[0] === 'condition')).toBe(false);
    expect(event.tags.some((t) => t[0] === 'i')).toBe(false);
  });
});

describe('buildResultEvent (kind:6097)', () => {
  const requestEvent: RelayEvent = {
    id: REQUEST_EVENT_ID,
    pubkey: BUYER_PUBKEY,
    content: '',
    tags: [
      ['i', JOB.brief, 'text'],
      ['bid', JOB.bidMicroUsdc, 'usdc'],
    ],
  };

  it('outcome:"completed" carries the final artifact i-tag and full request', () => {
    const event = buildResultEvent({
      job: JOB,
      requestEvent,
      lastEventId: 'lastOfferId',
      outcome: 'completed',
      reachedIncrement: 3,
      totalIncrements: 3,
      finalArtifact: { arweaveTxId: 'arTxFinal' },
    });

    expect(event.kind).toBe(FACTORY_JOB_RESULT_KIND);
    expect(event.tags).toEqual(
      expect.arrayContaining([
        ['e', REQUEST_EVENT_ID, '', 'root'],
        ['e', 'lastOfferId', '', 'reply'],
        ['p', BUYER_PUBKEY],
        ['outcome', 'completed'],
        ['increment', '3', '3'],
        ['i', 'arTxFinal', 'url'],
      ])
    );
    const requestTag = event.tags.find((t) => t[0] === 'request');
    expect(JSON.parse(requestTag?.[1] ?? '{}')).toEqual(requestEvent);
  });

  it('outcome:"abandoned-buyer" carries no i-tag (no final artifact)', () => {
    const event = buildResultEvent({
      job: JOB,
      requestEvent,
      lastEventId: 'lastOfferId',
      outcome: 'abandoned-buyer',
      reachedIncrement: 1,
      totalIncrements: 3,
    });

    expect(event.tags.some((t) => t[0] === 'i')).toBe(false);
    expect(event.tags).toEqual(
      expect.arrayContaining([['outcome', 'abandoned-buyer'], ['increment', '1', '3']])
    );
  });

  it('outcome:"abandoned-provider" carries no i-tag either', () => {
    const event = buildResultEvent({
      job: JOB,
      requestEvent,
      lastEventId: 'lastOfferId',
      outcome: 'abandoned-provider',
      reachedIncrement: 0,
      totalIncrements: 3,
    });

    expect(event.tags.some((t) => t[0] === 'i')).toBe(false);
  });
});
