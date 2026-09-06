import { getPublicKey, verifyEvent } from 'nostr-tools/pure';
import { describe, expect, it } from 'vitest';
import { FREE_TIER_MAX_ITEM_BYTES } from '../objects.js';
import {
  estimateSealedUploadBytes,
  uploadChargeFor,
  UPLOAD_ENVELOPE_OVERHEAD_BYTES,
} from '../publisher.js';
import {
  ConnectorPublisher,
  extractArweaveTxId,
  type PaidClientLike,
  type PaidRequest,
  type PaidSendOptions,
  type PaidSendResult,
  type RouteTerms,
} from './connector-publisher.js';

const SECRET = new Uint8Array(32).fill(7);
const OWNER = getPublicKey(SECRET);
const TX = 'A'.repeat(43);

interface SentCall {
  destination: string;
  request: PaidRequest;
  options: PaidSendOptions | undefined;
}

/** A client that prices two routes and answers every send from a script. */
function fakeClient(args: {
  prices: Record<string, RouteTerms | null>;
  answer: (call: SentCall) => PaidSendResult;
}): PaidClientLike & { calls: SentCall[] } {
  const calls: SentCall[] = [];
  return {
    calls,
    async routePrice(destination) {
      return destination in args.prices ? args.prices[destination]! : null;
    },
    async send(destination, request, options) {
      const call = { destination, request, options };
      calls.push(call);
      return args.answer(call);
    },
  };
}

const ok = (
  body: unknown,
  extra: { status?: number; amount?: bigint } = {}
): PaidSendResult => ({
  fulfilled: true,
  status: extra.status ?? 200,
  body: new TextEncoder().encode(
    typeof body === 'string' ? body : JSON.stringify(body)
  ),
  ...(extra.amount !== undefined ? { claim: { amount: extra.amount } } : {}),
});

const sentEvent = (call: SentCall) =>
  (
    call.request.body as {
      event: {
        kind: number;
        tags: string[][];
        pubkey: string;
        id: string;
        sig: string;
        content: string;
        created_at: number;
      };
    }
  ).event;

function publisherWith(
  client: PaidClientLike,
  storeClient = client,
  sealTo?: string
) {
  return new ConnectorPublisher({
    publish: { client, destination: 'g.node.relay' },
    store: {
      client: storeClient,
      destination: 'g.node.store',
      ...(sealTo ? { sealTo } : {}),
    },
    nostrSecretKey: SECRET,
  });
}

describe('uploadChargeFor', () => {
  it('a flat route costs its base price whatever the size', () => {
    expect(uploadChargeFor({ uploadFee: 1000n, eventFee: 1n }, 0)).toBe(1000n);
    expect(uploadChargeFor({ uploadFee: 1000n, eventFee: 1n }, 90_000)).toBe(
      1000n
    );
    expect(
      uploadChargeFor(
        { uploadFee: 1000n, uploadPerKib: 0n, eventFee: 1n },
        90_000
      )
    ).toBe(1000n);
  });

  it('a metered route adds the slope per started KiB of the sealed payload, counted from one', () => {
    const rates = { uploadFee: 1000n, uploadPerKib: 30n, eventFee: 1n };
    // An empty body still seals to the envelope overhead: one KiB started.
    expect(estimateSealedUploadBytes(0)).toBe(UPLOAD_ENVELOPE_OVERHEAD_BYTES);
    expect(uploadChargeFor(rates, 0)).toBe(1030n);
    // 3000 raw bytes → 4000 base64 + overhead = 4704 sealed → ⌊4704/1024⌋+1 = 5 KiB.
    expect(estimateSealedUploadBytes(3000)).toBe(
      4000 + UPLOAD_ENVELOPE_OVERHEAD_BYTES
    );
    expect(uploadChargeFor(rates, 3000)).toBe(1000n + 30n * 5n);
  });
});

describe('extractArweaveTxId', () => {
  const bytes = (s: string) => new TextEncoder().encode(s);
  it('reads the id from `txId`, `result.txId`, base64 `data`, or a bare body', () => {
    expect(extractArweaveTxId(200, bytes(JSON.stringify({ txId: TX })))).toBe(
      TX
    );
    expect(
      extractArweaveTxId(200, bytes(JSON.stringify({ result: { txId: TX } })))
    ).toBe(TX);
    expect(
      extractArweaveTxId(
        200,
        bytes(JSON.stringify({ data: Buffer.from(TX).toString('base64') }))
      )
    ).toBe(TX);
    expect(extractArweaveTxId(200, bytes(TX))).toBe(TX);
  });
  it('throws on a refusal, a non-2xx, or an answer without an id', () => {
    expect(() =>
      extractArweaveTxId(
        200,
        bytes(JSON.stringify({ accept: false, error: 'too big' }))
      )
    ).toThrow(/accept:false.*too big/);
    expect(() => extractArweaveTxId(402, bytes('pay up'))).toThrow(
      /HTTP 402 - pay up/
    );
    expect(() =>
      extractArweaveTxId(200, bytes(JSON.stringify({ ok: true })))
    ).toThrow(/no Arweave tx id/);
    expect(() => extractArweaveTxId(200, bytes('<html>'))).toThrow(
      /not valid JSON/
    );
  });
});

describe('ConnectorPublisher', () => {
  it('reads both routes once and floors the event fee at the publish price', async () => {
    const client = fakeClient({
      prices: {
        'g.node.relay': { price: 1000n },
        'g.node.store': { price: 900n, pricePerKib: 30n },
      },
      answer: () => ok({}),
    });
    const publisher = new ConnectorPublisher({
      publish: { client, destination: 'g.node.relay' },
      store: { client, destination: 'g.node.store' },
      nostrSecretKey: SECRET,
      eventFee: 5n,
    });
    const rates = await publisher.getFeeRates();
    expect(rates).toEqual({
      uploadFee: 900n,
      uploadPerKib: 30n,
      eventFee: 1000n,
    });
    expect(await publisher.getFeeRates()).toBe(rates);
  });

  it('a route the node does not price names the knob to fix', async () => {
    const client = fakeClient({
      prices: { 'g.node.relay': { price: 1n }, 'g.node.store': null },
      answer: () => ok({}),
    });
    await expect(publisherWith(client).getFeeRates()).rejects.toThrow(
      /no route for the store destination g\.node\.store.*TOON_CLIENT_STORE_DESTINATION/
    );
  });

  it('uploads a git object as a signed kind:5094 job and returns the tx id and the claim', async () => {
    const client = fakeClient({
      prices: {
        'g.node.relay': { price: 1n },
        'g.node.store': { price: 900n, pricePerKib: 30n },
      },
      answer: () => ok({ txId: TX }, { amount: 960n }),
    });
    const publisher = publisherWith(client);
    const body = Buffer.from('hello world');
    const receipt = await publisher.uploadGitObject({
      sha: 'abc',
      type: 'blob',
      body,
      repoId: 'demo',
      path: 'index.html',
    });
    expect(receipt).toEqual({ txId: TX, feePaid: 960n });
    const call = client.calls[0]!;
    expect(call.destination).toBe('g.node.store');
    expect(call.options).toEqual({});
    const event = sentEvent(call);
    expect(event.kind).toBe(5094);
    expect(event.pubkey).toBe(OWNER);
    expect(verifyEvent(event)).toBe(true);
    expect(event.tags).toEqual([
      ['i', body.toString('base64'), 'blob'],
      ['output', 'text/html'],
      ['Git-SHA', 'abc'],
      ['Git-Type', 'blob'],
      ['Repo', 'demo'],
      [
        'bid',
        uploadChargeFor(
          { uploadFee: 900n, uploadPerKib: 30n, eventFee: 1n },
          body.length
        ).toString(),
        'usdc',
      ],
    ]);
  });

  it('a raw blob carries its content type and no git tags; the estimate stands in when the route is free', async () => {
    const client = fakeClient({
      prices: { 'g.node.relay': { price: 1n }, 'g.node.store': { price: 0n } },
      answer: () => ok({ txId: TX }),
    });
    const receipt = await publisherWith(client).uploadBlob({
      body: Buffer.from('{}'),
      contentType: 'application/x.arweave-manifest+json',
    });
    expect(receipt).toEqual({ txId: TX, feePaid: 0n });
    expect(sentEvent(client.calls[0]!).tags).toEqual([
      ['i', Buffer.from('{}').toString('base64'), 'blob'],
      ['output', 'application/x.arweave-manifest+json'],
      ['bid', '0', 'usdc'],
    ]);
  });

  it('seals the store leg to the terminating node and pays it through its own client', async () => {
    const edge = fakeClient({
      prices: { 'g.node.relay': { price: 1n } },
      answer: () => ok({ eventId: 'x' }),
    });
    const store = fakeClient({
      prices: { 'g.node.store': { price: 900n } },
      answer: () => ok({ txId: TX }),
    });
    const publisher = publisherWith(edge, store, 'https://store.example/ilp');
    await publisher.uploadBlob({
      body: Buffer.from('x'),
      contentType: 'text/plain',
    });
    expect(edge.calls).toHaveLength(0);
    expect(store.calls[0]!.options).toEqual({
      sealTo: 'https://store.example/ilp',
    });
  });

  it("a REJECT is thrown with the connector's code; a store refusal is thrown with its reason", async () => {
    const refused = fakeClient({
      prices: {
        'g.node.relay': { price: 1n },
        'g.node.store': { price: 900n },
      },
      answer: () => ({
        fulfilled: false,
        code: 'F03',
        message: 'underpaid',
        refusedBy: 'edge',
      }),
    });
    await expect(
      publisherWith(refused).uploadBlob({
        body: Buffer.from('x'),
        contentType: 'text/plain',
      })
    ).rejects.toThrow(/blob upload rejected — F03 by the edge: underpaid/);
    const noId = fakeClient({
      prices: {
        'g.node.relay': { price: 1n },
        'g.node.store': { price: 900n },
      },
      answer: () => ok({ accept: false, error: 'free tier exhausted' }),
    });
    await expect(
      publisherWith(noId).uploadGitObject({
        sha: 's',
        type: 'blob',
        body: Buffer.from('x'),
        repoId: 'r',
      })
    ).rejects.toThrow(
      /git-object upload \(s\): upload refused by the store \(accept:false\): free tier exhausted/
    );
  });

  // #102: this used to refuse anything over a hard 95 KiB cap before paying.
  // The store route prices per KiB, so a large blob is a more expensive upload
  // rather than a refusal — it must reach the client and come back with a txId.
  it('uploads a blob above the free-tier ceiling instead of refusing it', async () => {
    const client = fakeClient({
      prices: {
        'g.node.relay': { price: 1n },
        'g.node.store': { price: 900n },
      },
      answer: () => ok({ txId: TX }),
    });
    const receipt = await publisherWith(client).uploadBlob({
      body: Buffer.alloc(FREE_TIER_MAX_ITEM_BYTES + 1),
      contentType: 'text/plain',
    });
    expect(receipt.txId).toBe(TX);
    expect(client.calls.length).toBeGreaterThan(0);
  });

  it("publishes an event signed by the owner as {event} and reads the relay's eventId", async () => {
    const client = fakeClient({
      prices: {
        'g.node.relay': { price: 1000n },
        'g.node.store': { price: 900n },
      },
      answer: (call) =>
        ok({ eventId: sentEvent(call).id, storedAt: 1 }, { amount: 1000n }),
    });
    const publisher = publisherWith(client);
    const receipt = await publisher.publishEvent(
      {
        kind: 30617,
        content: '',
        tags: [['d', 'demo']],
        created_at: 1_700_000_000,
      },
      ['wss://relay.example']
    );
    const call = client.calls[0]!;
    expect(call.destination).toBe('g.node.relay');
    const event = sentEvent(call);
    expect(event.kind).toBe(30617);
    expect(event.pubkey).toBe(OWNER);
    expect(verifyEvent(event)).toBe(true);
    expect(receipt).toEqual({ eventId: event.id, feePaid: 1000n });
  });

  it('a relay 4xx behind a FULFILL is a failed publish', async () => {
    const client = fakeClient({
      prices: {
        'g.node.relay': { price: 1000n },
        'g.node.store': { price: 900n },
      },
      answer: () => ok({ error: 'Invalid event signature' }, { status: 422 }),
    });
    await expect(
      publisherWith(client).publishEvent(
        { kind: 1, content: '', tags: [], created_at: 1 },
        ['wss://relay.example']
      )
    ).rejects.toThrow(/HTTP 422 - .*Invalid event signature/);
  });

  it('refuses a multi-relay publish rather than half-doing it', async () => {
    const client = fakeClient({
      prices: { 'g.node.relay': { price: 1n }, 'g.node.store': { price: 1n } },
      answer: () => ok({}),
    });
    await expect(
      publisherWith(client).publishEvent(
        { kind: 1, content: '', tags: [], created_at: 1 },
        ['a', 'b']
      )
    ).rejects.toThrow(/multi-relay/);
    expect(client.calls).toHaveLength(0);
  });

  it('submits a store job as param tags and returns a refusal as data', async () => {
    const client = fakeClient({
      prices: {
        'g.node.relay': { price: 1n },
        'g.node.store': { price: 900n },
      },
      answer: () =>
        ok(
          {
            accept: false,
            code: 'insufficient_ario',
            message: 'need 1833 ARIO',
          },
          { status: 402, amount: 900n }
        ),
    });
    const answer = await publisherWith(client).submitStoreJob({
      kind: 5095,
      params: [
        ['op', 'buy'],
        ['name', 'toon'],
      ],
    });
    expect(answer).toEqual({
      status: 402,
      accept: false,
      code: 'insufficient_ario',
      message: 'need 1833 ARIO',
      feePaid: 900n,
    });
    const event = sentEvent(client.calls[0]!);
    expect(event.kind).toBe(5095);
    expect(event.tags).toEqual([
      ['param', 'op', 'buy'],
      ['param', 'name', 'toon'],
      ['bid', '900', 'usdc'],
    ]);
  });
});
