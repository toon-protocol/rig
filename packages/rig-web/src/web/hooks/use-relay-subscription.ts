import { useEffect, useState } from 'react';
import { subscribeRelay } from '../relay-client.js';
import type { NostrEvent, NostrFilter } from '../nip34-parsers.js';

interface UseRelaySubscriptionResult {
  events: NostrEvent[];
  /** True until the relay has sent EOSE for the initial backlog. */
  loading: boolean;
  error: Error | null;
}

/** Identity of a replaceable event: (kind, pubkey, d) for 30000-39999. */
function replaceableKey(event: NostrEvent): string | null {
  if (event.kind < 30000 || event.kind >= 40000) return null;
  const d = event.tags.find((t) => t[0] === 'd')?.[1] ?? '';
  return `${event.kind}:${event.pubkey}:${d}`;
}

/**
 * Like `useRelay`, but the REQ stays open after EOSE so events the relay
 * pushes later land in state (rig#125: a coordinator's kind:39842 progress
 * marker is replaced as jobs start and finish, and the Actions view should
 * follow it live). Regular events are deduplicated by id; addressable events
 * are replaced by (kind, pubkey, d), newest `created_at` wins, so a stale
 * replacement the relay hands back late cannot overwrite a newer one.
 */
export function useRelaySubscription(
  relayUrl: string,
  filter: NostrFilter | null
): UseRelaySubscriptionResult {
  const [events, setEvents] = useState<NostrEvent[]>([]);
  const [loading, setLoading] = useState(!!filter);
  const [error, setError] = useState<Error | null>(null);

  const filterJson = filter ? JSON.stringify(filter) : null;

  useEffect(() => {
    if (!filterJson) {
      setEvents([]);
      setLoading(false);
      return;
    }
    const parsed = JSON.parse(filterJson) as NostrFilter;
    setEvents([]);
    setLoading(true);
    setError(null);

    const byId = new Map<string, NostrEvent>();
    const byAddress = new Map<string, NostrEvent>();

    const sub = subscribeRelay(
      relayUrl,
      parsed,
      (event) => {
        const address = replaceableKey(event);
        if (address) {
          const prev = byAddress.get(address);
          if (prev && prev.created_at >= event.created_at) return;
          if (prev) byId.delete(prev.id);
          byAddress.set(address, event);
        } else if (byId.has(event.id)) {
          return;
        }
        byId.set(event.id, event);
        setEvents([...byId.values()]);
      },
      () => setLoading(false),
      {
        onError: (err) => {
          setError(err);
          setLoading(false);
        },
      }
    );

    return () => {
      sub.close();
    };
  }, [relayUrl, filterJson]);

  return { events, loading, error };
}
