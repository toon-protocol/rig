/**
 * A long-lived relay subscription that survives drops (#235): the live half of
 * `rig inbox --follow`. One call follows one relay — it opens a REQ per filter,
 * hands every EVENT to `onEvent`, relays a NOTICE to `onError` and keeps going,
 * and when the connection errors or closes, or the relay answers CLOSED, it
 * reports to `onError`, waits a backoff, and reconnects, until `signal` aborts.
 * The backoff resets only once a relay has answered with EOSE, so a relay that
 * accepts and then drops at once still backs off. Filters are rebuilt per
 * connection so a reconnect can resume from a newer `since` than the first
 * attempt used.
 */

import type {
  NostrEvent,
  NostrFilter,
  WebSocketFactory,
  WebSocketLike,
} from '../remote-state.js';
import { decodeEventPayload } from '../remote-state.js';

const WS_OPEN = 1;
/** A socket that has not opened by then counts as a failed connection. */
const CONNECT_TIMEOUT_MS = 10_000;

export interface FollowRelayOptions {
  url: string;
  /** Filters for this connection (called again on every reconnect). */
  filters: () => NostrFilter[];
  webSocketFactory: WebSocketFactory;
  onEvent: (event: NostrEvent, url: string) => void;
  /** A connection problem; the follower keeps going after reporting it. */
  onError: (message: string) => void;
  signal: AbortSignal;
  /** Delay before reconnect attempt `n` (1-based), in ms. */
  backoffMs: (attempt: number) => number;
}

/** Default reconnect backoff: 1s doubling to a 30s ceiling. */
export function defaultBackoffMs(attempt: number): number {
  return Math.min(30_000, 1000 * 2 ** Math.max(0, attempt - 1));
}

/**
 * Resolves when the connection ends (error, close, or abort). `onSubscribed`
 * fires once the relay has answered a REQ with EOSE.
 */
function connectOnce(
  opts: FollowRelayOptions,
  onSubscribed: () => void
): Promise<string | null> {
  return new Promise((resolve) => {
    let ws: WebSocketLike;
    let done = false;
    let subscribed = false;
    const subIds: string[] = [];
    // eslint-disable-next-line prefer-const -- assigned after `finish` is defined
    let connectTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (reason: string | null): void => {
      if (done) return;
      done = true;
      clearTimeout(connectTimer);
      opts.signal.removeEventListener('abort', onAbort);
      try {
        if (ws.readyState === WS_OPEN) {
          for (const id of subIds) ws.send(JSON.stringify(['CLOSE', id]));
        }
        ws.close();
      } catch {
        // Ignore close errors
      }
      resolve(reason);
    };
    const onAbort = (): void => finish(null);

    try {
      ws = opts.webSocketFactory(opts.url);
    } catch (err) {
      resolve(`failed to connect to ${opts.url}: ${String(err)}`);
      return;
    }
    opts.signal.addEventListener('abort', onAbort);
    connectTimer = setTimeout(
      () => finish(`timed out connecting to ${opts.url}`),
      CONNECT_TIMEOUT_MS
    );

    ws.addEventListener('open', () => {
      clearTimeout(connectTimer);
      opts.filters().forEach((filter, i) => {
        const subId = `follow-${Date.now()}-${i}-${Math.random().toString(36).slice(2, 8)}`;
        subIds.push(subId);
        ws.send(JSON.stringify(['REQ', subId, filter]));
      });
    });
    ws.addEventListener('message', (msgEvent: { data?: unknown }) => {
      try {
        const msg = JSON.parse(String(msgEvent.data)) as unknown[];
        if (msg[0] === 'EVENT' && msg[2] !== undefined) {
          const event = decodeEventPayload(msg[2]);
          if (event) opts.onEvent(event, opts.url);
        } else if (
          msg[0] === 'EOSE' &&
          !subscribed &&
          subIds.includes(msg[1] as string)
        ) {
          subscribed = true;
          onSubscribed();
        } else if (msg[0] === 'CLOSED' && subIds.includes(msg[1] as string)) {
          const why =
            typeof msg[2] === 'string' && msg[2] ? msg[2] : 'no reason';
          finish(`${opts.url} closed the subscription: ${why}`);
        } else if (msg[0] === 'NOTICE') {
          opts.onError(`notice from ${opts.url}: ${String(msg[1])}`);
        }
      } catch {
        // Ignore unparseable frames
      }
    });
    ws.addEventListener('error', (event: { message?: unknown }) => {
      const detail =
        typeof event === 'object' && event !== null && 'message' in event
          ? String(event.message)
          : 'unknown';
      finish(`websocket error on ${opts.url}: ${detail}`);
    });
    ws.addEventListener('close', () => {
      finish(`connection to ${opts.url} closed`);
    });
  });
}

/** Follow one relay until `signal` aborts, reconnecting with backoff. */
export async function followRelay(opts: FollowRelayOptions): Promise<void> {
  let attempt = 0;
  while (!opts.signal.aborted) {
    const reason = await connectOnce(opts, () => {
      attempt = 0;
    });
    if (opts.signal.aborted) return;
    opts.onError(reason ?? `connection to ${opts.url} ended`);
    attempt += 1;
    await new Promise<void>((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        opts.signal.removeEventListener('abort', done);
        resolve();
      };
      const timer = setTimeout(done, opts.backoffMs(attempt));
      opts.signal.addEventListener('abort', done);
    });
  }
}
