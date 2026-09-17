import { useEffect, useState } from 'react';
import { readJobLog, type JobLog } from '../job-log.js';
import { storeLinkHref } from '../gateway-preference.js';

export interface UseJobLogResult {
  /** Null until a log has been read (or when the job has none). */
  log: JobLog | null;
  loading: boolean;
  error: Error | null;
}

/**
 * The durable job log behind a Job Result's `logs` URL (rig#190).
 *
 * Reading is bounded by {@link readJobLog}'s ceiling, so opening a job never
 * hands the browser an unbounded download. A job with no `logs` URL is not an
 * error: nothing is fetched and the caller renders a job without a log.
 * The URL is a Coordinator's claim about where the bytes are, so it is used
 * as published, with only the excluded testnet gateway re-pointed — the same
 * rule that decides what the "Full log" link points at.
 */
export function useJobLog(logsUrl: string | undefined): UseJobLogResult {
  const [log, setLog] = useState<JobLog | null>(null);
  const [loading, setLoading] = useState(logsUrl !== undefined);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    setLog(null);
    setError(null);
    if (logsUrl === undefined) {
      setLoading(false);
      return;
    }
    const abort = new AbortController();
    let cancelled = false;
    setLoading(true);
    readJobLog(storeLinkHref(logsUrl), { signal: abort.signal })
      .then((result) => {
        if (cancelled) return;
        setLog(result);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err : new Error(String(err)));
        setLoading(false);
      });
    return () => {
      cancelled = true;
      abort.abort();
    };
  }, [logsUrl]);

  return { log, loading, error };
}
