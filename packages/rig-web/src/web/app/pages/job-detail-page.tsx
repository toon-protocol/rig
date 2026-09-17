import { useEffect, useMemo } from 'react';
import { Link, useOutletContext, useParams } from 'react-router';
import type { RepoContext } from '@/app/repo-layout';
import { useCiRun } from '@/hooks/use-ci-runs';
import { useJobLog } from '@/hooks/use-job-log';
import { useLiveLogTail } from '@/hooks/use-live-log-tail';
import { useProfileCache } from '@/hooks/use-profile-cache';
import { TrustBadge, workflowLabel } from '@/app/pages/actions-page';
import { JobStateBadge } from '@/components/job-state-badge';
import { LiveTailPane, RunnerChannelPane } from '@/components/live-tail-pane';
import { Skeleton } from '@/components/ui/skeleton';
import { formatByteSize, type JobLog } from '../../job-log.js';
import {
  formatClock,
  formatDuration,
  formatRelativeDate,
} from '../../date-utils.js';
import { hexToNpub } from '../../npub.js';
import { storeLinkHref } from '../../gateway-preference.js';
import {
  deriveRunJobs,
  type CiLogTail,
  type CiRun,
  type CiRunJob,
} from '../../nip-c1-parsers.js';

/** The link from a run to one of its jobs. Job ids are the workflow's own. */
export function jobPageHref(
  owner: string,
  repo: string,
  runId: string,
  jobId: string
): string {
  return `/${owner}/${repo}/actions/${encodeURIComponent(runId)}/jobs/${encodeURIComponent(jobId)}`;
}

/**
 * A job that has not started. Said plainly, because the difference between
 * this and a running job with nothing to show yet is the whole reason a job
 * has a page.
 */
function PendingPane() {
  return (
    <section className="rounded-md border border-dashed bg-muted/20 p-6 text-sm text-muted-foreground">
      This job has not started yet. The coordinator lists it in this run; it has
      produced no output.
    </section>
  );
}

/**
 * A job the run is executing (rig#194).
 *
 * With a live tail on the relay this is the job's recent output, replaced as
 * the coordinator publishes; with none — an old coordinator, an expired
 * event — it is the plain statement it was before, because the absence of a
 * live event is never an error. Either way the durable job log is published
 * when the run concludes, and it is the record.
 */
function RunningPane({ tail }: { tail?: CiLogTail }) {
  if (!tail) {
    return (
      <section className="rounded-md border bg-muted/20 p-6 text-sm text-muted-foreground">
        This job is running. Its job log is published when the run concludes.
      </section>
    );
  }
  return (
    <LiveTailPane
      testId="live-job-tail"
      label="Live tail"
      note="the most recent output of this job"
      channel={tail}
      empty="(no output yet)"
    />
  );
}

/** What the page says about a log it did not show in full. */
function TruncationNotice({ log }: { log: JobLog }) {
  if (!log.truncated) return null;
  const shown = formatByteSize(log.bytesRead);
  return (
    <p
      data-testid="job-log-truncated"
      className="border-t bg-yellow-500/10 px-4 py-2 text-xs text-yellow-800 dark:text-yellow-300"
    >
      {log.totalBytes !== undefined
        ? `Showing the first ${shown} of this ${formatByteSize(log.totalBytes)} job log — ${formatByteSize(log.totalBytes - log.bytesRead)} is not shown.`
        : `Showing the first ${shown} of this job log — the store did not say how much more there is.`}{' '}
      Open the full log to read the rest.
    </p>
  );
}

/** The excerpt the Job Result itself carries, with what precedes it named. */
function LogTailPane({ job }: { job: CiRunJob }) {
  const result = job.result;
  if (!result) return null;
  return (
    <div>
      <pre className="max-h-[32rem] overflow-auto bg-muted/20 p-4 font-mono text-xs leading-relaxed text-foreground">
        {result.logTail || '(no log tail)'}
      </pre>
      {result.logOmittedBytes > 0 && (
        <p className="border-t px-4 py-2 text-xs text-muted-foreground">
          This is the tail of the job log:{' '}
          {formatByteSize(result.logOmittedBytes)} of earlier output comes
          before it.
        </p>
      )}
    </div>
  );
}

/**
 * The durable job log of a concluded job, read back from the store (rig#190).
 *
 * A job with no `logs` URL is a job without a log, not an error: the excerpt
 * on its Job Result is all there is, and the pane says so.
 */
function JobLogPane({ job }: { job: CiRunJob }) {
  const result = job.result;
  const { log, loading, error } = useJobLog(result?.logsUrl);

  if (!result) {
    return (
      <section className="rounded-md border bg-muted/20 p-6 text-sm text-muted-foreground">
        This job concluded; waiting for its job result to arrive on the relay.
      </section>
    );
  }

  return (
    <section className="rounded-md border">
      <header className="flex flex-wrap items-center gap-3 border-b bg-muted/40 px-4 py-2 text-xs">
        <span className="font-semibold text-foreground">Job log</span>
        {result.logsUrl ? (
          <a
            href={storeLinkHref(result.logsUrl)}
            target="_blank"
            rel="noreferrer"
            className="text-primary underline-offset-2 hover:underline"
          >
            Full log
          </a>
        ) : (
          <span className="text-muted-foreground">
            No job log was uploaded for this job — the excerpt below is all the
            coordinator published.
          </span>
        )}
      </header>
      {!result.logsUrl && <LogTailPane job={job} />}
      {result.logsUrl && loading && (
        <div className="space-y-2 p-4">
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="h-4 w-5/6" />
        </div>
      )}
      {result.logsUrl && error && (
        <div>
          <p className="border-b bg-destructive/10 px-4 py-2 text-xs text-destructive">
            Could not read the job log from the store: {error.message}
          </p>
          <LogTailPane job={job} />
        </div>
      )}
      {log && (
        <div>
          <pre className="max-h-[32rem] overflow-auto bg-muted/20 p-4 font-mono text-xs leading-relaxed text-foreground">
            {log.text || '(the job log is empty)'}
          </pre>
          <TruncationNotice log={log} />
        </div>
      )}
      {result.artifacts.length > 0 && (
        <footer className="flex flex-wrap items-center gap-2 border-t px-4 py-2 text-xs text-muted-foreground">
          Artifacts:{' '}
          {result.artifacts.map((artifact, i) => (
            <span key={artifact.url}>
              {i > 0 && ', '}
              <a
                href={storeLinkHref(artifact.url)}
                target="_blank"
                rel="noreferrer"
                title={
                  artifact.name ? `artifact "${artifact.name}"` : undefined
                }
                className="font-mono text-primary underline-offset-2 hover:underline"
              >
                {artifact.filename || artifact.url}
              </a>
            </span>
          ))}
        </footer>
      )}
    </section>
  );
}

function JobHeader({
  job,
  run,
  owner,
  repo,
}: {
  job: CiRunJob;
  run: CiRun;
  owner: string;
  repo: string;
}) {
  const { getDisplayName } = useProfileCache();
  const result = job.result;
  const duration =
    result &&
    result.startedAt !== undefined &&
    result.createdAt >= result.startedAt
      ? formatDuration(result.createdAt - result.startedAt)
      : null;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-xl font-semibold">{job.label}</h2>
        <JobStateBadge job={job} />
        {job.label !== job.jobId && (
          <span className="font-mono text-xs text-muted-foreground">
            {job.jobId}
          </span>
        )}
        {result?.exitCode !== undefined && (
          <span className="text-xs text-muted-foreground">
            exit code {result.exitCode}
          </span>
        )}
        {result && result.runsOn.length > 0 && (
          <span className="text-xs text-muted-foreground">
            on {result.runsOn.join(', ')}
          </span>
        )}
      </div>
      <p className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
        <Link
          to={`/${owner}/${repo}/actions/${run.runId}`}
          className="hover:text-primary hover:underline"
          title={run.trigger.workflow.path}
        >
          {workflowLabel(run.trigger.workflow.path)}
        </Link>
        <span>·</span>
        <span>{run.trigger.reason}</span>
        <Link
          to={`/${owner}/${repo}/commit/${run.trigger.commit}`}
          className="rounded-md border px-1.5 py-0.5 font-mono text-xs hover:bg-muted hover:text-foreground"
        >
          {run.trigger.commit.slice(0, 7)}
        </Link>
        <TrustBadge level={run.trust} />
      </p>
      <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span>
          coordinator{' '}
          <Link
            to={`/${hexToNpub(run.coordinator)}`}
            className="text-foreground hover:text-primary hover:underline"
          >
            {getDisplayName(run.coordinator)}
          </Link>
        </span>
        {result?.queuedAt !== undefined && (
          <span title={formatClock(result.queuedAt)}>
            · queued {formatRelativeDate(result.queuedAt)}
          </span>
        )}
        {result?.startedAt !== undefined && (
          <span title={formatClock(result.startedAt)}>
            · started {formatRelativeDate(result.startedAt)}
          </span>
        )}
        {duration && <span>· took {duration}</span>}
        <span className="font-mono">· run {run.runId}</span>
      </p>
    </div>
  );
}

/**
 * One job of one run (rig#190): its identity, its state, and — once the run
 * concludes — its durable job log. Addressed by the run id and the job id,
 * both of which the coordinator fixes for the life of the run, so the link a
 * maintainer sends a colleague keeps pointing at the job that broke.
 */
export function JobDetailPage() {
  const { runId = '', jobId = '' } = useParams();
  const { metadata, owner, repo } = useOutletContext<RepoContext>();
  const { run, jobs, loading, error } = useCiRun(
    owner,
    metadata.repoId,
    runId,
    metadata.maintainers
  );
  const { requestProfiles } = useProfileCache();
  // Scoped to THIS run and opened only while it is unfinished: the actions
  // list never asks for log bytes, and a concluded run converges on its
  // durable job log rather than on the last thing the tail happened to catch.
  const liveTail = useLiveLogTail(run);

  useEffect(() => {
    if (run) requestProfiles([run.coordinator]);
  }, [run, requestProfiles]);

  const job = useMemo(() => {
    if (!run) return null;
    // A live tail is per-job evidence of execution: a job that has printed
    // something has demonstrably started. With no tail on the relay there is
    // no such evidence and the run-level reading stands.
    const opts = liveTail
      ? { startedJobIds: liveTail.jobs.map((j) => j.jobId) }
      : {};
    return (
      deriveRunJobs(run, jobs, opts).find((j) => j.jobId === jobId) ?? null
    );
  }, [run, jobs, jobId, liveTail]);

  if (error) {
    return (
      <div className="text-destructive-foreground">
        Failed to load the run: {error.message}
      </div>
    );
  }

  if (loading && !run) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-3/4" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }

  if (!run) {
    return <div className="text-muted-foreground">Run not found.</div>;
  }

  if (!job) {
    return (
      <div className="space-y-4">
        <Link
          to={`/${owner}/${repo}/actions/${run.runId}`}
          className="text-xs text-muted-foreground hover:text-primary hover:underline"
        >
          ← Back to the run
        </Link>
        <div className="text-muted-foreground">
          This run has no job called <span className="font-mono">{jobId}</span>.
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <Link
        to={`/${owner}/${repo}/actions/${run.runId}`}
        className="text-xs text-muted-foreground hover:text-primary hover:underline"
      >
        ← Back to the run
      </Link>
      <JobHeader job={job} run={run} owner={owner} repo={repo} />
      {job.state === 'pending' && <PendingPane />}
      {job.state === 'running' && (
        <RunningPane
          tail={liveTail?.jobs.find((entry) => entry.jobId === job.jobId)}
        />
      )}
      {job.state === 'concluded' && <JobLogPane job={job} />}
      {liveTail?.runner && <RunnerChannelPane channel={liveTail.runner} />}
    </div>
  );
}
