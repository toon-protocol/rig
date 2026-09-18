import { useMemo } from 'react';
import { useRigConfig } from './use-rig-config.js';
import { useRelaySubscription } from './use-relay-subscription.js';
import { buildCiLiveLogTailFilter } from '../relay-client.js';
import {
  parseCiLiveLogTail,
  type CiLiveLogTail,
  type CiRun,
} from '../nip-c1-parsers.js';
import type { NostrFilter } from '../nip34-parsers.js';

/** What the page needs of a run to address its tail. */
export type LiveLogTailRun = Pick<CiRun, 'runId' | 'coordinator' | 'status'>;

/**
 * The live log tail of ONE run (rig#194, ADR-0002).
 *
 * The subscription is scoped to the run being viewed and opened only while
 * that run is unfinished, so browsing the repo's run list never pulls log
 * bytes and a concluded run stops asking for a view it has outgrown: the
 * durable job log is the record from that moment on. The REQ stays open, so
 * each replacement the coordinator publishes re-renders the pane without a
 * reload, and because the kind is addressable the relay answers with the
 * latest version immediately rather than with an empty pane.
 *
 * Absence is NEVER an error: an old coordinator, an expired event or a run
 * that concluded long ago simply yields `null`, and the caller renders a
 * perfectly normal run.
 */
export function useLiveLogTail(
  run: LiveLogTailRun | null
): CiLiveLogTail | null {
  const { relayUrl } = useRigConfig();

  const filter = useMemo<NostrFilter | null>(
    () =>
      run && run.status !== 'concluded'
        ? buildCiLiveLogTailFilter(run.coordinator, run.runId)
        : null,
    [run]
  );

  const { events } = useRelaySubscription(relayUrl, filter);

  return useMemo(() => {
    let newest: CiLiveLogTail | null = null;
    for (const event of events) {
      const parsed = parseCiLiveLogTail(event);
      if (!parsed) continue;
      if (!newest || parsed.createdAt > newest.createdAt) newest = parsed;
    }
    return newest;
  }, [events]);
}
