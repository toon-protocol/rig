/**
 * Test fixtures for the coordinator (#125) — NOT shipped (only *.test.ts
 * files import it).
 *
 * The #278 read-testkit's mock relay answers a REQ from canned events and
 * sends EOSE; it can never push a LATER event, which is the one thing a
 * coordinator test must do ("a push lands while the coordinator is
 * listening"). {@link makeScriptedRelay} keeps every open subscription and
 * delivers `push()`ed events to the ones whose filter matches, after their
 * EOSE. It also lets a test drop the connection from the relay side to prove
 * reconnect + cursor resume.
 *
 * Also here: a recording fake Publisher whose receipts carry deterministic
 * 64-hex event ids (NIP-C1 job quotes must be hex), and a fake clock whose
 * scheduler the coordinator's timers run on, so no test ever sleeps.
 */

import { filterEvents } from '../cli/read-testkit.js';
import type {
  BlobUpload,
  FeeRates,
  GitObjectUpload,
  Publisher,
  PublishReceipt,
  UploadReceipt,
} from '../publisher.js';
import type { UnsignedEvent } from '../nip34-events.js';
import type {
  NostrEvent,
  NostrFilter,
  WebSocketFactory,
  WebSocketLike,
} from '../remote-state.js';
import type { Scheduler } from './relay-subscription.js';

// ---------------------------------------------------------------------------
// Scripted relay
// ---------------------------------------------------------------------------

type Listener = (event: unknown) => void;

interface OpenSubscription {
  subId: string;
  filter: NostrFilter;
  eoseSent: boolean;
}

export class ScriptedSocket implements WebSocketLike {
  readyState = 0;
  readonly subscriptions = new Map<string, OpenSubscription>();
  private listeners = new Map<string, Listener[]>();

  constructor(
    readonly url: string,
    private readonly relay: ScriptedRelayInternals
  ) {
    queueMicrotask(() => {
      if (this.readyState === 0) {
        this.readyState = 1;
        this.emit('open', {});
      }
    });
  }

  addEventListener(type: string, listener: (event: never) => void): void {
    const existing = this.listeners.get(type) ?? [];
    existing.push(listener as Listener);
    this.listeners.set(type, existing);
  }

  emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  send(data: string): void {
    const msg = JSON.parse(data) as unknown[];
    this.relay.sentFrames.push(msg);
    if (msg[0] === 'REQ') {
      const subId = msg[1] as string;
      const filter = (msg[2] ?? {}) as NostrFilter;
      const sub: OpenSubscription = { subId, filter, eoseSent: false };
      this.subscriptions.set(subId, sub);
      const events = filterEvents(this.relay.store, filter);
      queueMicrotask(() => {
        if (this.readyState !== 1 || !this.subscriptions.has(subId)) return;
        for (const event of events) {
          this.emit('message', {
            data: JSON.stringify(['EVENT', subId, event]),
          });
        }
        sub.eoseSent = true;
        this.emit('message', { data: JSON.stringify(['EOSE', subId]) });
      });
    } else if (msg[0] === 'CLOSE') {
      this.subscriptions.delete(msg[1] as string);
    } else if (msg[0] === 'EVENT') {
      // A client-side publish (not used by the coordinator, which pays
      // through the Publisher) — acknowledge so nothing hangs.
      const ev = msg[1] as NostrEvent;
      this.emit('message', { data: JSON.stringify(['OK', ev.id, true, '']) });
    }
  }

  /** Client-initiated close. */
  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.subscriptions.clear();
    this.emit('close', {});
  }

  /** Relay-initiated drop (server went away). */
  dropFromServer(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.subscriptions.clear();
    this.emit('close', { code: 1006 });
  }

  /** Deliver a live event to every open subscription it matches (post-EOSE). */
  deliver(event: NostrEvent): boolean {
    let delivered = false;
    if (this.readyState !== 1) return false;
    for (const sub of this.subscriptions.values()) {
      if (!sub.eoseSent) continue;
      if (filterEvents([event], sub.filter).length === 0) continue;
      this.emit('message', {
        data: JSON.stringify(['EVENT', sub.subId, event]),
      });
      delivered = true;
    }
    return delivered;
  }
}

interface ScriptedRelayInternals {
  store: NostrEvent[];
  sentFrames: unknown[][];
}

export interface ScriptedRelay {
  factory: WebSocketFactory;
  /** Add canned events (answered to future REQs; NOT pushed live). */
  serve(events: NostrEvent[]): void;
  /** Add an event AND push it live to every matching open subscription. */
  push(event: NostrEvent): boolean;
  /** Drop every open socket from the relay side. */
  dropConnection(): void;
  /** Every socket ever created, in order. */
  sockets: ScriptedSocket[];
  /** Every frame clients sent (REQ / CLOSE / EVENT). */
  sentFrames: unknown[][];
  /** The canned + pushed events. */
  store: NostrEvent[];
  /** Currently open sockets. */
  openSockets(): ScriptedSocket[];
}

export function makeScriptedRelay(): ScriptedRelay {
  const internals: ScriptedRelayInternals = { store: [], sentFrames: [] };
  const sockets: ScriptedSocket[] = [];
  return {
    factory: (url) => {
      const socket = new ScriptedSocket(url, internals);
      sockets.push(socket);
      return socket;
    },
    serve(events) {
      internals.store.push(...events);
    },
    push(event) {
      internals.store.push(event);
      let delivered = false;
      for (const socket of sockets) {
        if (socket.deliver(event)) delivered = true;
      }
      return delivered;
    },
    dropConnection() {
      for (const socket of sockets) socket.dropFromServer();
    },
    sockets,
    sentFrames: internals.sentFrames,
    store: internals.store,
    openSockets: () => sockets.filter((s) => s.readyState === 1),
  };
}

// ---------------------------------------------------------------------------
// Fake publisher
// ---------------------------------------------------------------------------

/** Deterministic 64-hex event id for the n-th published event. */
export function fakeEventId(n: number): string {
  return 'e'.repeat(60) + n.toString(16).padStart(4, '0');
}

export interface PublishedEvent {
  event: UnsignedEvent;
  relayUrls: string[];
  eventId: string;
}

export interface UploadedBlob extends BlobUpload {
  txId: string;
}

export interface FakePublisher extends Publisher {
  publishedEvents: PublishedEvent[];
  uploadedBlobs: UploadedBlob[];
  feeRates: FeeRates;
  /** When set, `getFeeRates` throws with this message. */
  feeRatesError: string | null;
  /** Events of one kind, in publish order. */
  ofKind(kind: number): PublishedEvent[];
  /** Turn a published (unsigned) event into the signed shape a relay serves. */
  asRelayEvent(published: PublishedEvent, pubkey: string): NostrEvent;
}

export function fakePublisher(): FakePublisher {
  const publishedEvents: PublishedEvent[] = [];
  const uploadedBlobs: UploadedBlob[] = [];
  let eventCounter = 0;
  let txCounter = 0;
  const publisher: FakePublisher = {
    publishedEvents,
    uploadedBlobs,
    feeRates: { uploadFee: 1100n, uploadPerKib: 10n, eventFee: 1n },
    feeRatesError: null,
    async getFeeRates() {
      if (publisher.feeRatesError !== null)
        throw new Error(publisher.feeRatesError);
      return publisher.feeRates;
    },
    async uploadGitObject(_upload: GitObjectUpload): Promise<UploadReceipt> {
      throw new Error('the coordinator never uploads git objects');
    },
    async uploadBlob(upload: BlobUpload): Promise<UploadReceipt> {
      txCounter += 1;
      const txId = `tx-${txCounter}`;
      uploadedBlobs.push({ ...upload, txId });
      return { txId, feePaid: publisher.feeRates.uploadFee };
    },
    async publishEvent(
      event: UnsignedEvent,
      relayUrls: string[]
    ): Promise<PublishReceipt> {
      eventCounter += 1;
      const eventId = fakeEventId(eventCounter);
      publishedEvents.push({ event, relayUrls, eventId });
      return { eventId, feePaid: publisher.feeRates.eventFee };
    },
    ofKind(kind) {
      return publishedEvents.filter((p) => p.event.kind === kind);
    },
    asRelayEvent(published, pubkey) {
      return {
        id: published.eventId,
        pubkey,
        created_at: published.event.created_at,
        kind: published.event.kind,
        tags: published.event.tags,
        content: published.event.content,
        sig: 'f0'.repeat(64),
      };
    },
  };
  return publisher;
}

// ---------------------------------------------------------------------------
// Fake clock + scheduler
// ---------------------------------------------------------------------------

interface FakeTimer {
  id: number;
  at: number;
  fn: () => void;
}

export interface FakeClock {
  /** Unix seconds. */
  now(): number;
  /** Advance by `ms`, firing due timers in order. */
  advance(ms: number): void;
  /** Timers waiting to fire. */
  pending(): number;
  scheduler: Scheduler;
}

export function fakeClock(startSeconds = 1_800_000_000): FakeClock {
  let nowMs = startSeconds * 1000;
  let nextId = 1;
  let timers: FakeTimer[] = [];
  const scheduler: Scheduler = {
    setTimeout(fn, ms) {
      const timer: FakeTimer = {
        id: nextId++,
        at: nowMs + Math.max(0, ms),
        fn,
      };
      timers.push(timer);
      return timer.id;
    },
    clearTimeout(handle) {
      timers = timers.filter((t) => t.id !== handle);
    },
  };
  return {
    now: () => Math.floor(nowMs / 1000),
    advance(ms) {
      const target = nowMs + ms;
      for (;;) {
        const due = timers
          .filter((t) => t.at <= target)
          .sort((a, b) => a.at - b.at || a.id - b.id);
        const next = due[0];
        if (!next) break;
        timers = timers.filter((t) => t.id !== next.id);
        nowMs = Math.max(nowMs, next.at);
        next.fn();
      }
      nowMs = target;
    },
    pending: () => timers.length,
    scheduler,
  };
}

/** Let queued microtasks and I/O callbacks run (no timers involved). */
export function flush(rounds = 5): Promise<void> {
  let p = Promise.resolve();
  for (let i = 0; i < rounds; i++) {
    p = p.then(() => new Promise<void>((resolve) => setImmediate(resolve)));
  }
  return p;
}

/**
 * Poll `condition` (real I/O such as git child processes cannot be flushed
 * with microtasks alone). Rejects after `timeoutMs` with `label`.
 */
export async function waitFor(
  condition: () => boolean,
  label = 'condition',
  timeoutMs = 10_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline)
      throw new Error(`timed out waiting for ${label}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}
