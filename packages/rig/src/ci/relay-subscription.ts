/**
 * A long-lived NIP-01 subscription (#125): the coordinator's ears.
 *
 * `../remote-state.ts`'s `queryRelay` is a one-shot REQ → EVENT* → EOSE →
 * CLOSE read, which is exactly right for every free read rig does — and
 * exactly wrong for a coordinator that must hear a push the moment it lands.
 * This module keeps ONE socket open per relay with one REQ per filter, keeps
 * delivering EVENTs after EOSE, and reconnects with exponential backoff when
 * the relay drops the connection. On every (re)connect the REQs are re-sent
 * with `since` taken from the caller's cursor getter, so a blip replays only
 * what was missed (user story 13).
 *
 * Built on the same `WebSocketFactory` seam as the rest of rig, so tests
 * drive it with an in-process scripted relay (./ci-testkit.ts) and the
 * reconnect timers go through an injectable scheduler (no real sleeps).
 * Relay payload decoding tolerates the same three encodings queryRelay does
 * (object / double-JSON / TOON); the helper is private there, so it is
 * mirrored here rather than exported from a module this slice does not own.
 */

import { decode as decodeToon } from '@toon-format/toon';
import type {
  NostrEvent,
  NostrFilter,
  WebSocketFactory,
  WebSocketLike,
} from '../remote-state.js';

/** Timer seam so the coordinator and its tests share one clock. */
export interface Scheduler {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const realScheduler: Scheduler = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) =>
    clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export type SubscriptionStatus = 'open' | 'closed' | 'reconnecting' | 'error';

export interface SubscribeRelayOptions {
  url: string;
  /** One REQ per filter; `onEvent` reports which one matched by index. */
  filters: NostrFilter[];
  webSocketFactory: WebSocketFactory;
  onEvent(event: NostrEvent, filterIndex: number): void;
  /** Called once per filter per (re)connect when the relay signals EOSE. */
  onEose?(filterIndex: number): void;
  onStatus?(status: SubscriptionStatus, detail?: string): void;
  /**
   * Cursor getter, evaluated at every (re)connect: when it returns a number
   * every filter is re-sent with that `since` (a filter's own `since` wins
   * when set). Return undefined for a full replay.
   */
  since?: (filterIndex: number) => number | undefined;
  backoff?: { initialMs?: number; maxMs?: number };
  scheduler?: Scheduler;
}

export interface RelaySubscription {
  /** Stop for good: no reconnect, socket closed, no further callbacks. */
  close(): void;
  readonly connected: boolean;
  /** How many times the subscription has (re)connected so far. */
  readonly connections: number;
}

const WS_OPEN = 1;

/** Mirror of remote-state.ts's tolerant EVENT payload decoder. */
export function decodeRelayEvent(payload: unknown): NostrEvent | null {
  if (payload !== null && typeof payload === 'object')
    return payload as NostrEvent;
  if (typeof payload !== 'string') return null;
  try {
    const parsed: unknown = JSON.parse(payload);
    if (parsed !== null && typeof parsed === 'object')
      return parsed as NostrEvent;
  } catch {
    // Not JSON — fall through to TOON
  }
  try {
    return decodeToon(payload) as unknown as NostrEvent;
  } catch {
    return null;
  }
}

/** Open a persistent subscription. Never throws synchronously. */
export function subscribeRelay(opts: SubscribeRelayOptions): RelaySubscription {
  const scheduler = opts.scheduler ?? realScheduler;
  const initialBackoff = opts.backoff?.initialMs ?? 1000;
  const maxBackoff = opts.backoff?.maxMs ?? 60_000;
  const base = `ci-${Math.random().toString(36).slice(2, 8)}`;

  let ws: WebSocketLike | null = null;
  let closed = false;
  let connected = false;
  let connections = 0;
  let backoffMs = initialBackoff;
  let reconnectHandle: unknown = null;
  /** subId → filter index for the CURRENT socket generation. */
  let subIds = new Map<string, number>();

  const status = (s: SubscriptionStatus, detail?: string): void => {
    opts.onStatus?.(s, detail);
  };

  const scheduleReconnect = (detail: string): void => {
    if (closed || reconnectHandle !== null) return;
    connected = false;
    status('reconnecting', detail);
    const delay = backoffMs;
    backoffMs = Math.min(backoffMs * 2, maxBackoff);
    reconnectHandle = scheduler.setTimeout(() => {
      reconnectHandle = null;
      connect();
    }, delay);
  };

  const connect = (): void => {
    if (closed) return;
    const generation = ++connections;
    subIds = new Map();
    let socket: WebSocketLike;
    try {
      socket = opts.webSocketFactory(opts.url);
    } catch (err) {
      scheduleReconnect(
        `connect failed: ${err instanceof Error ? err.message : String(err)}`
      );
      return;
    }
    ws = socket;
    const mine = (): boolean => ws === socket && generation === connections;

    socket.addEventListener('open', () => {
      if (!mine() || closed) return;
      connected = true;
      backoffMs = initialBackoff;
      status('open');
      opts.filters.forEach((filter, index) => {
        const subId = `${base}-${generation}-${index}`;
        subIds.set(subId, index);
        const since = filter.since ?? opts.since?.(index);
        const sent: NostrFilter =
          since !== undefined ? { ...filter, since } : { ...filter };
        socket.send(JSON.stringify(['REQ', subId, sent]));
      });
    });

    socket.addEventListener('message', (msgEvent: { data?: unknown }) => {
      if (!mine() || closed) return;
      let msg: unknown[];
      try {
        msg = JSON.parse(String(msgEvent.data)) as unknown[];
      } catch {
        return;
      }
      if (!Array.isArray(msg) || msg.length < 2) return;
      const index = subIds.get(String(msg[1]));
      if (index === undefined) return;
      if (msg[0] === 'EVENT' && msg[2] !== undefined) {
        const event = decodeRelayEvent(msg[2]);
        if (event) opts.onEvent(event, index);
      } else if (msg[0] === 'EOSE') {
        opts.onEose?.(index);
      } else if (msg[0] === 'CLOSED') {
        // The relay refused/ended this REQ; treat like a dropped socket.
        scheduleReconnect(`relay closed subscription: ${String(msg[2] ?? '')}`);
      }
    });

    socket.addEventListener('error', (event: { message?: unknown }) => {
      if (!mine() || closed) return;
      const detail =
        typeof event === 'object' && event !== null && 'message' in event
          ? String(event.message)
          : 'unknown';
      status('error', detail);
      try {
        socket.close();
      } catch {
        // already closing
      }
      scheduleReconnect(`socket error: ${detail}`);
    });

    socket.addEventListener('close', () => {
      if (!mine() || closed) return;
      scheduleReconnect('socket closed');
    });
  };

  connect();

  return {
    close() {
      if (closed) return;
      closed = true;
      connected = false;
      if (reconnectHandle !== null) {
        scheduler.clearTimeout(reconnectHandle);
        reconnectHandle = null;
      }
      const socket = ws;
      ws = null;
      if (socket) {
        try {
          if (socket.readyState === WS_OPEN) {
            for (const subId of subIds.keys()) {
              socket.send(JSON.stringify(['CLOSE', subId]));
            }
          }
          socket.close();
        } catch {
          // ignore close errors
        }
      }
      status('closed');
    },
    get connected() {
      return connected;
    },
    get connections() {
      return connections;
    },
  };
}
