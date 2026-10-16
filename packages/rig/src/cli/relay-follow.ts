/**
 * A long-lived relay subscription that survives drops (#235): the live half of
 * `rig inbox --follow`. One call follows one relay — it opens a REQ per filter,
 * hands every EVENT to `onEvent`, and when the connection errors or closes it
 * reports to `onError`, waits a backoff, and reconnects, until `signal` aborts.
 * Filters are rebuilt per connection so a reconnect can resume from a newer
 * `since` than the first attempt used.
 */

import type {
  NostrEvent,
  NostrFilter,
  WebSocketFactory,
  WebSocketLike,
} from '../remote-state.js';
import { decodeEventPayload } from '../remote-state.js';

const WS_OPEN = 1;

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

/** Resolves when the connection ends (error, close, or abort). */
function connectOnce(
  opts: FollowRelayOptions,
  onOpen: () => void
): Promise<string | null> {
  return new Promise((resolve) => {
    let ws: WebSocketLike;
    let done = false;
    const subIds: string[] = [];
    const finish = (reason: string | null): void => {
      if (done) return;
      done = true;
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

    ws.addEventListener('open', () => {
      onOpen();
      opts.filters().forEach((filter, i) => {
        const subId = `inbox-${Date.now()}-${i}-${Math.random().toString(36).slice(2, 8)}`;
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
