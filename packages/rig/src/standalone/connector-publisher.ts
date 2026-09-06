/**
 * The paid write path on `@toon-protocol/client` 2.x — a {@link Publisher}
 * that pays a TOON connector per request.
 *
 * Everything a paid command needs comes from one connector URL: the client
 * reads the node's own `GET /ilp` (addresses, prices, settlement chains,
 * sealing key — connector ADR 0050), opens or adopts a payment channel, and
 * pays each request with a signed claim. There is no relay to discover peers
 * on (kind:10032 was removed by ADR 0046) and no topology to negotiate: a
 * destination is a route the node prices, and `send()` pays what the route
 * costs — including the per-kibibyte part of an ADR 0065 schedule, which the
 * client works out from the sealed payload so this publisher never has to.
 *
 * Three request shapes, all ordinary paid POSTs:
 *
 *  1. `publishEvent` — a NIP-34 event signed with the OWNER's Nostr key,
 *     sent as `{ event }` to the publish route; the relay answers
 *     `{ eventId, storedAt, payment? }`.
 *  2. `uploadGitObject` / `uploadBlob` — a kind:5094 store job carrying the
 *     bytes base64 in an `i` tag; the store answers the Arweave tx id.
 *  3. `submitStoreJob` — a kind:5095 / 5096 job with `param` tags; the
 *     DVM's answer comes back as data, refusal included (ADR 0020: an answer
 *     is an answer, and the payer was charged for it).
 *
 * The store route may terminate on a different node than the one addressed
 * (the edge forwards it). Then the payload must be sealed to THAT node's
 * identity — `sealTo` — and, when the store node holds its own channel, paid
 * through its own client. Both are options here; the common single-node case
 * needs neither.
 */

import { finalizeEvent } from 'nostr-tools/pure';
import { contentTypeForPath, DEFAULT_CONTENT_TYPE } from '../mime.js';
import type { UnsignedEvent } from '../nip34-events.js';
import {
  uploadChargeFor,
  type BlobUpload,
  type FeeRates,
  type GitObjectUpload,
  type PublishReceipt,
  type Publisher,
  type StoreJobRequest,
  type StoreJobResponse,
  type UploadReceipt,
} from '../publisher.js';

// ---------------------------------------------------------------------------
// The slice of ToonClient this publisher drives (structural, so tests mock it)
// ---------------------------------------------------------------------------

/** A paid request, as `ToonClient.send` takes it. */
export interface PaidRequest {
  method?: string;
  target?: string;
  headers?: Record<string, string> | [string, string][];
  body?: string | Uint8Array | object;
}

export interface PaidSendOptions {
  /** The terminating connector's `GET /ilp` URL or raw key, on a forwarded route. */
  sealTo?: string | Uint8Array;
  timeoutMs?: number;
}

export interface PaidFulfilled {
  fulfilled: true;
  status: number;
  body: Uint8Array;
  /** What this request paid; absent on a route priced at zero. */
  claim?: { amount: bigint };
}

export interface PaidRefused {
  fulfilled: false;
  code: string;
  message: string;
  refusedBy?: string;
}

export type PaidSendResult = PaidFulfilled | PaidRefused;

/** The route terms a connector publishes: a base price and an optional slope. */
export interface RouteTerms {
  price: bigint;
  pricePerKib?: bigint;
}

/** The slice of `ToonClient` (2.x) this publisher needs. */
export interface PaidClientLike {
  send(
    destination: string,
    request: PaidRequest,
    options?: PaidSendOptions
  ): Promise<PaidSendResult>;
  /** The node's terms for a destination, or `null` when it prices no such route. */
  routePrice(destination: string): Promise<RouteTerms | null>;
}

/** One leg of the write path: who pays, where to, and whom to seal to. */
export interface PaidLeg {
  client: PaidClientLike;
  destination: string;
  sealTo?: string | Uint8Array;
}

export interface ConnectorPublisherOptions {
  /** Pays the publish route and signs nothing — the Nostr key below signs. */
  publish: PaidLeg;
  /** Pays the store route (often the same client as `publish`). */
  store: PaidLeg;
  /** The owner's Nostr secret key: signs every event this publisher sends. */
  nostrSecretKey: Uint8Array;
  /**
   * A configured per-event fee. Informational floor only: the connector's
   * published price for the publish route wins when it is higher, and the
   * client pays that price whatever this says.
   */
  eventFee?: bigint;
  /** Per-packet timeout for uploads (the store's Arweave round trip). */
  uploadTimeoutMs?: number;
  warn?(line: string): void;
}

export class ConnectorPublishError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConnectorPublishError';
  }
}

const ARWEAVE_TX_ID_REGEX = /^[A-Za-z0-9_-]{43}$/;

function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function describeRefusal(result: PaidRefused): string {
  const by = result.refusedBy ? ` by the ${result.refusedBy}` : '';
  return `${result.code}${by}: ${result.message}`;
}

/**
 * Read the Arweave tx id out of a store's kind:5094 answer.
 *
 * The store answers one of two ways — `{ txId }` as JSON, or the bare id
 * base64 in `data` — and refuses with `{ accept: false, error }`. A non-2xx
 * status is a refusal too; both are thrown, because an upload without an id
 * is an upload that did not happen (even though the packet was paid for).
 */
export function extractArweaveTxId(status: number, body: Uint8Array): string {
  const text = decodeUtf8(body);
  if (status < 200 || status >= 300) {
    throw new ConnectorPublishError(
      `the store answered HTTP ${String(status)}${text ? ` - ${text}` : ''}`
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    if (ARWEAVE_TX_ID_REGEX.test(text.trim())) return text.trim();
    throw new ConnectorPublishError(
      `the store's answer was not valid JSON: ${JSON.stringify(text.slice(0, 200))}`
    );
  }
  const answer = (parsed ?? {}) as {
    accept?: unknown;
    error?: unknown;
    txId?: unknown;
    data?: unknown;
    result?: unknown;
  };
  if (answer.accept === false) {
    const reason = typeof answer.error === 'string' ? `: ${answer.error}` : '';
    throw new ConnectorPublishError(
      `upload refused by the store (accept:false)${reason}`
    );
  }
  if (
    typeof answer.txId === 'string' &&
    ARWEAVE_TX_ID_REGEX.test(answer.txId)
  ) {
    return answer.txId;
  }
  const nested = answer.result as { txId?: unknown } | undefined;
  if (
    nested &&
    typeof nested.txId === 'string' &&
    ARWEAVE_TX_ID_REGEX.test(nested.txId)
  ) {
    return nested.txId;
  }
  if (typeof answer.data === 'string' && answer.data.length > 0) {
    const decoded = Buffer.from(answer.data, 'base64').toString('utf8');
    if (ARWEAVE_TX_ID_REGEX.test(decoded)) return decoded;
  }
  throw new ConnectorPublishError(
    `the store's answer carried no Arweave tx id: ${JSON.stringify(text.slice(0, 200))}`
  );
}

// ---------------------------------------------------------------------------
// The publisher
// ---------------------------------------------------------------------------

export class ConnectorPublisher implements Publisher {
  private readonly publish: PaidLeg;
  private readonly store: PaidLeg;
  private readonly nostrSecretKey: Uint8Array;
  private readonly configuredEventFee: bigint;
  private readonly uploadTimeoutMs: number | undefined;
  private readonly warn: (line: string) => void;
  private rates: Promise<FeeRates> | undefined;

  constructor(options: ConnectorPublisherOptions) {
    this.publish = options.publish;
    this.store = options.store;
    this.nostrSecretKey = options.nostrSecretKey;
    this.configuredEventFee = options.eventFee ?? 0n;
    this.uploadTimeoutMs = options.uploadTimeoutMs;
    this.warn = options.warn ?? (() => undefined);
  }

  /** Where events go, and where objects go. */
  get destinations(): { publish: string; store: string } {
    return { publish: this.publish.destination, store: this.store.destination };
  }

  /**
   * The two routes' published terms, read once per publisher. A route the
   * node does not price is a configuration error and says which knob to fix.
   */
  getFeeRates(): Promise<FeeRates> {
    this.rates ??= this.readFeeRates();
    return this.rates;
  }

  private async readFeeRates(): Promise<FeeRates> {
    const [publishTerms, storeTerms] = await Promise.all([
      this.publish.client.routePrice(this.publish.destination),
      this.store.client.routePrice(this.store.destination),
    ]);
    if (!publishTerms) {
      throw new ConnectorPublishError(
        `the connector prices no route for the publish destination ${this.publish.destination} ` +
          '(set publishDestination / TOON_CLIENT_PUBLISH_DESTINATION to one of its GET /ilp routes)'
      );
    }
    if (!storeTerms) {
      throw new ConnectorPublishError(
        `the connector prices no route for the store destination ${this.store.destination} ` +
          '(set storeDestination / TOON_CLIENT_STORE_DESTINATION to one of its GET /ilp routes)'
      );
    }
    if (
      publishTerms.pricePerKib !== undefined &&
      publishTerms.pricePerKib > 0n
    ) {
      this.warn(
        `rig: the publish route ${this.publish.destination} meters by size ` +
          `(${String(publishTerms.pricePerKib)}/KiB); the per-event estimate shows its base price only`
      );
    }
    const eventFee =
      this.configuredEventFee > publishTerms.price
        ? this.configuredEventFee
        : publishTerms.price;
    return {
      uploadFee: storeTerms.price,
      ...(storeTerms.pricePerKib !== undefined && storeTerms.pricePerKib > 0n
        ? { uploadPerKib: storeTerms.pricePerKib }
        : {}),
      eventFee,
    };
  }

  private sign(template: UnsignedEvent) {
    return finalizeEvent(
      {
        kind: template.kind,
        content: template.content,
        tags: template.tags,
        created_at: template.created_at,
      },
      this.nostrSecretKey
    );
  }

  /** One paid kind:5094 write; returns the tx id and what the claim spent. */
  private async storeWrite(
    tags: string[][],
    bodyBytes: number,
    what: string
  ): Promise<UploadReceipt> {
    const rates = await this.getFeeRates();
    const estimate = uploadChargeFor(rates, bodyBytes);
    const event = this.sign({
      kind: 5094,
      content: '',
      created_at: nowSeconds(),
      tags: [...tags, ['bid', estimate.toString(), 'usdc']],
    });
    const result = await this.store.client.send(
      this.store.destination,
      { body: { event } },
      {
        ...(this.store.sealTo !== undefined
          ? { sealTo: this.store.sealTo }
          : {}),
        ...(this.uploadTimeoutMs !== undefined
          ? { timeoutMs: this.uploadTimeoutMs }
          : {}),
      }
    );
    if (!result.fulfilled) {
      throw new ConnectorPublishError(
        `${what} rejected — ${describeRefusal(result)}`
      );
    }
    let txId: string;
    try {
      txId = extractArweaveTxId(result.status, result.body);
    } catch (err) {
      throw new ConnectorPublishError(
        `${what}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    return { txId, feePaid: result.claim?.amount ?? estimate };
  }

  async uploadGitObject(upload: GitObjectUpload): Promise<UploadReceipt> {
    // No size gate (#102): the store route prices per KiB, so a body above
    // FREE_TIER_MAX_ITEM_BYTES is a paid upload rather than a refusal.
    const contentType =
      upload.type === 'blob'
        ? contentTypeForPath(upload.path)
        : DEFAULT_CONTENT_TYPE;
    return this.storeWrite(
      [
        ['i', upload.body.toString('base64'), 'blob'],
        ['output', contentType],
        ['Git-SHA', upload.sha],
        ['Git-Type', upload.type],
        ['Repo', upload.repoId],
      ],
      upload.body.length,
      `git-object upload (${upload.sha})`
    );
  }

  async uploadBlob(upload: BlobUpload): Promise<UploadReceipt> {
    // No size gate (#102), matching uploadGitObject: the store route prices
    // per KiB, so a blob above FREE_TIER_MAX_ITEM_BYTES costs more rather than
    // being refused.
    return this.storeWrite(
      [
        ['i', upload.body.toString('base64'), 'blob'],
        ['output', upload.contentType],
        ...(upload.repoId ? [['Repo', upload.repoId]] : []),
      ],
      upload.body.length,
      'blob upload'
    );
  }

  /**
   * One NIP-90 job to the store node's DVM, over the paid path. A refusal is
   * returned, not thrown: `accept: false` and a non-2xx status are the
   * answer's content, and the payer was charged for the answer (ADR 0020).
   */
  async submitStoreJob(request: StoreJobRequest): Promise<StoreJobResponse> {
    const rates = await this.getFeeRates();
    const fee = rates.uploadFee;
    const event = this.sign({
      kind: request.kind,
      content: '',
      created_at: nowSeconds(),
      tags: [
        ...request.params.map(([key, value]) => ['param', key, value]),
        ['bid', fee.toString(), 'usdc'],
      ],
    });
    const result = await this.store.client.send(
      this.store.destination,
      { body: { event } },
      this.store.sealTo !== undefined ? { sealTo: this.store.sealTo } : {}
    );
    if (!result.fulfilled) {
      throw new ConnectorPublishError(
        `kind:${String(request.kind)} job rejected — ${describeRefusal(result)}`
      );
    }
    const text = decodeUtf8(result.body);
    let body: {
      accept?: unknown;
      code?: unknown;
      message?: unknown;
      result?: unknown;
    };
    try {
      body = JSON.parse(text) as typeof body;
    } catch {
      throw new ConnectorPublishError(
        `kind:${String(request.kind)} job answer was not valid JSON ` +
          `(HTTP ${String(result.status)}): ${JSON.stringify(text.slice(0, 200))}`
      );
    }
    return {
      status: result.status,
      accept: body.accept === true,
      ...(typeof body.code === 'string' ? { code: body.code } : {}),
      ...(typeof body.message === 'string' ? { message: body.message } : {}),
      ...(body.result !== null && typeof body.result === 'object'
        ? { result: body.result as Record<string, unknown> }
        : {}),
      feePaid: result.claim?.amount ?? fee,
    };
  }

  /**
   * Sign the event with the owner's key and pay to publish it. `relayUrls`
   * is the seam's plural surface: this publisher routes to one configured
   * destination, so more than one relay is refused rather than half-done.
   */
  async publishEvent(
    event: UnsignedEvent,
    relayUrls: string[]
  ): Promise<PublishReceipt> {
    if (relayUrls.length > 1) {
      throw new ConnectorPublishError(
        `multi-relay publish is not supported (got ${String(relayUrls.length)} relays) — ` +
          'the connector publisher routes to a single publish destination'
      );
    }
    const rates = await this.getFeeRates();
    const signed = this.sign(event);
    const result = await this.publish.client.send(
      this.publish.destination,
      { body: { event: signed } },
      this.publish.sealTo !== undefined ? { sealTo: this.publish.sealTo } : {}
    );
    if (!result.fulfilled) {
      throw new ConnectorPublishError(
        `publish rejected (kind ${String(event.kind)}) — ${describeRefusal(result)}`
      );
    }
    if (result.status < 200 || result.status >= 300) {
      throw new ConnectorPublishError(
        `publish (kind ${String(event.kind)}): the relay answered HTTP ${String(result.status)} - ${decodeUtf8(result.body)}`
      );
    }
    let eventId = signed.id;
    try {
      const answer = JSON.parse(decodeUtf8(result.body)) as {
        eventId?: unknown;
      };
      if (typeof answer.eventId === 'string' && answer.eventId)
        eventId = answer.eventId;
    } catch {
      // A 2xx without a JSON body still stored the event we signed.
    }
    return { eventId, feePaid: result.claim?.amount ?? rates.eventFee };
  }
}
