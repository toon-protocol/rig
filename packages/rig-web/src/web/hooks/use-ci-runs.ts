import { useCallback, useMemo } from 'react';
import { useRigConfig } from './use-rig-config.js';
import { useRelay } from './use-relay.js';
import { useRelaySubscription } from './use-relay-subscription.js';
import { npubToHex } from '../npub.js';
import {
  buildCiRuns,
  parseCiJobResult,
  parseCiServiceControl,
  type CiJobResult,
  type CiRun,
  type CiServiceControl,
} from '../nip-c1-parsers.js';
import {
  buildCiControlsFilter,
  buildCiJobResultsFilter,
  buildCiRunsFilter,
} from '../relay-client.js';
import type { NostrFilter } from '../nip34-parsers.js';

export interface UseCiRunsResult {
  /** Every run for the repo, newest first, trust attached. */
  runs: CiRun[];
  /** Current runs (newest attempt per coordinator+workflow) for one commit. */
  runsForCommit: (sha: string) => CiRun[];
  /** Current runs whose PR context roots at this PR event id. */
  runsForPr: (prEventId: string) => CiRun[];
  controls: CiServiceControl[];
  loading: boolean;
  error: Error | null;
}

function ownerToHexOrNull(owner: string): string | null {
  try {
    return owner.startsWith('npub1') ? npubToHex(owner) : owner;
  } catch {
    return null;
  }
}

const EMPTY: CiRun[] = [];

/**
 * A repo's CI runs (rig#125): kind:9842 results + kind:39842 progress
 * markers over ONE live subscription (so an in-flight run updates as the
 * coordinator replaces its marker), plus the kind:9843/9844 Service
 * Request/Stop history that {@link buildCiRuns} turns into a trust level.
 * Exactly two relay round trips; a repo with no CI events costs nothing more.
 */
export function useCiRuns(
  owner: string,
  repoId: string,
  maintainers: string[] = []
): UseCiRunsResult {
  const { relayUrl } = useRigConfig();
  const ownerHex = useMemo(() => ownerToHexOrNull(owner), [owner]);

  const authorized = useMemo(() => {
    const set = new Set<string>(maintainers.map((m) => m.toLowerCase()));
    if (ownerHex) set.add(ownerHex.toLowerCase());
    return set;
  }, [ownerHex, maintainers]);

  const runsFilter = useMemo<NostrFilter | null>(
    () => (ownerHex ? buildCiRunsFilter(ownerHex, repoId) : null),
    [ownerHex, repoId]
  );
  const controlsFilter = useMemo<NostrFilter | null>(
    () => (ownerHex ? buildCiControlsFilter(ownerHex, repoId) : null),
    [ownerHex, repoId]
  );

  const { events: runEvents, loading: runsLoading, error: runsError } = useRelaySubscription(
    relayUrl,
    runsFilter
  );
  const { events: controlEvents, loading: controlsLoading } = useRelay(relayUrl, controlsFilter);

  const controls = useMemo(() => {
    const out: CiServiceControl[] = [];
    for (const ev of controlEvents) {
      const parsed = parseCiServiceControl(ev);
      if (parsed) out.push(parsed);
    }
    return out;
  }, [controlEvents]);

  const runs = useMemo(
    () => buildCiRuns(runEvents, { authorized, controls }),
    [runEvents, authorized, controls]
  );

  const byCommit = useMemo(() => {
    const map = new Map<string, CiRun[]>();
    for (const run of runs) {
      if (!run.current) continue;
      const list = map.get(run.trigger.commit) ?? [];
      list.push(run);
      map.set(run.trigger.commit, list);
    }
    return map;
  }, [runs]);

  const byPr = useMemo(() => {
    const map = new Map<string, CiRun[]>();
    for (const run of runs) {
      if (!run.current || !run.trigger.pr) continue;
      const list = map.get(run.trigger.pr.prEventId) ?? [];
      list.push(run);
      map.set(run.trigger.pr.prEventId, list);
    }
    return map;
  }, [runs]);

  const runsForCommit = useCallback((sha: string) => byCommit.get(sha) ?? EMPTY, [byCommit]);
  const runsForPr = useCallback((prEventId: string) => byPr.get(prEventId) ?? EMPTY, [byPr]);

  return {
    runs,
    runsForCommit,
    runsForPr,
    controls,
    loading: runsLoading || controlsLoading,
    error: runsError,
  };
}

export interface UseCiRunResult {
  run: CiRun | null;
  /** Job Results (9841) quoting this run's progress address, by job id. */
  jobs: CiJobResult[];
  loading: boolean;
  error: Error | null;
}

/** One run plus its Job Results (rig#125 run page). */
export function useCiRun(
  owner: string,
  repoId: string,
  runId: string,
  maintainers: string[] = []
): UseCiRunResult {
  const { relayUrl } = useRigConfig();
  const ownerHex = useMemo(() => ownerToHexOrNull(owner), [owner]);
  const { runs, loading: runsLoading, error } = useCiRuns(owner, repoId, maintainers);

  const run = useMemo(() => runs.find((r) => r.runId === runId) ?? null, [runs, runId]);

  const jobsFilter = useMemo<NostrFilter | null>(
    () => (ownerHex && run ? buildCiJobResultsFilter(ownerHex, repoId) : null),
    [ownerHex, repoId, run]
  );
  const { events: jobEvents, loading: jobsLoading } = useRelaySubscription(relayUrl, jobsFilter);

  const jobs = useMemo(() => {
    if (!run) return [];
    const address = `39842:${run.coordinator}:${run.runId}`;
    const out: CiJobResult[] = [];
    for (const ev of jobEvents) {
      const parsed = parseCiJobResult(ev);
      if (parsed && parsed.progressAddress === address) out.push(parsed);
    }
    return out.sort((a, b) => (a.startedAt ?? a.createdAt) - (b.startedAt ?? b.createdAt));
  }, [jobEvents, run]);

  return { run, jobs, loading: runsLoading || (run !== null && jobsLoading), error };
}
