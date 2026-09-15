import { useEffect } from 'react';
import { Link, useOutletContext, useParams } from 'react-router';
import type { RepoContext } from '@/app/repo-layout';
import { useCiRun } from '@/hooks/use-ci-runs';
import { useProfileCache } from '@/hooks/use-profile-cache';
import {
  RunStateBadge,
  TrustBadge,
  workflowLabel,
} from '@/app/pages/actions-page';
import {
  conclusionBadgeClass,
  describeRunState,
} from '@/components/ci-status-dot';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { formatRelativeDate } from '../../date-utils.js';
import { hexToNpub } from '../../npub.js';
import { shortRefName } from '@/lib/ref-utils';
import type { CiJobResult, CiRun } from '../../nip-c1-parsers.js';

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m < 60) return `${m}m ${s}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function formatClock(ts: number): string {
  return new Date(ts * 1000).toLocaleString();
}

/** One finished job: its Job Result with timings, log tail, logs + artifacts. */
function JobCard({ job }: { job: CiJobResult }) {
  const duration =
    job.startedAt !== undefined && job.createdAt >= job.startedAt
      ? formatDuration(job.createdAt - job.startedAt)
      : null;
  return (
    <section className="rounded-md border">
      <header className="flex flex-wrap items-center gap-2 border-b bg-muted/40 px-4 py-2">
        <h3 className="font-semibold text-foreground">
          {job.name ?? job.jobId}
        </h3>
        {job.name && job.name !== job.jobId && (
          <span className="font-mono text-xs text-muted-foreground">
            {job.jobId}
          </span>
        )}
        <Badge
          className={`text-[10px] ${conclusionBadgeClass('concluded', job.conclusion)}`}
        >
          {job.conclusion.replace(/_/g, ' ')}
        </Badge>
        {job.exitCode !== undefined && (
          <span className="text-xs text-muted-foreground">
            exit code {job.exitCode}
          </span>
        )}
        {job.runsOn.length > 0 && (
          <span className="text-xs text-muted-foreground">
            on {job.runsOn.join(', ')}
          </span>
        )}
        <span className="ml-auto text-xs text-muted-foreground">
          {job.queuedAt !== undefined && (
            <span title={formatClock(job.queuedAt)}>
              queued {formatRelativeDate(job.queuedAt)} ·{' '}
            </span>
          )}
          {job.startedAt !== undefined && (
            <span title={formatClock(job.startedAt)}>
              started {formatRelativeDate(job.startedAt)}
            </span>
          )}
          {duration && <span> · {duration}</span>}
        </span>
      </header>
      <pre className="max-h-96 overflow-auto bg-muted/20 p-4 font-mono text-xs leading-relaxed text-foreground">
        {job.logTail || '(no log tail)'}
      </pre>
      <footer className="flex flex-wrap items-center gap-3 border-t px-4 py-2 text-xs">
        {job.logsUrl ? (
          <a
            href={job.logsUrl}
            target="_blank"
            rel="noreferrer"
            className="text-primary underline-offset-2 hover:underline"
          >
            Full log
          </a>
        ) : (
          <span className="text-muted-foreground">No full log uploaded</span>
        )}
        {job.artifacts.length > 0 && (
          <span className="text-muted-foreground">
            Artifacts:{' '}
            {job.artifacts.map((artifact, i) => (
              <span key={artifact.url}>
                {i > 0 && ', '}
                <a
                  href={artifact.url}
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
          </span>
        )}
      </footer>
    </section>
  );
}

/** A job named by the progress marker whose Job Result has not arrived yet. */
function PendingJob({ jobId, running }: { jobId: string; running: boolean }) {
  return (
    <section className="flex items-center gap-2 rounded-md border border-dashed px-4 py-3">
      <span className="font-semibold text-foreground">{jobId}</span>
      <Badge
        className={`text-[10px] ${conclusionBadgeClass(running ? 'in_progress' : 'queued', undefined)}`}
      >
        {running ? 'in progress' : 'pending'}
      </Badge>
    </section>
  );
}

function RunHeader({
  run,
  owner,
  repo,
}: {
  run: CiRun;
  owner: string;
  repo: string;
}) {
  const { getDisplayName } = useProfileCache();
  const duration =
    run.status === 'concluded' &&
    run.startedAt !== undefined &&
    run.createdAt >= run.startedAt
      ? formatDuration(run.createdAt - run.startedAt)
      : null;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-xl font-semibold" title={run.trigger.workflow.path}>
          {workflowLabel(run.trigger.workflow.path)}
        </h2>
        <RunStateBadge run={run} />
        <TrustBadge level={run.trust} />
      </div>
      <p className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
        <span className="font-mono text-xs">{run.trigger.workflow.path}</span>
        <span>·</span>
        <span>{run.trigger.reason}</span>
        {run.trigger.ref && (
          <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
            {shortRefName(run.trigger.ref)}
          </span>
        )}
        {run.trigger.pr && (
          <Link
            to={`/${owner}/${repo}/pulls/${run.trigger.pr.prEventId}`}
            className="font-mono text-xs hover:text-primary hover:underline"
          >
            pull request {run.trigger.pr.prEventId.slice(0, 8)}
          </Link>
        )}
        <Link
          to={`/${owner}/${repo}/commit/${run.trigger.commit}`}
          className="rounded-md border px-1.5 py-0.5 font-mono text-xs hover:bg-muted hover:text-foreground"
        >
          {run.trigger.commit.slice(0, 7)}
        </Link>
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
        {run.queuedAt !== undefined && (
          <span title={formatClock(run.queuedAt)}>
            · queued {formatRelativeDate(run.queuedAt)}
          </span>
        )}
        {run.startedAt !== undefined && (
          <span title={formatClock(run.startedAt)}>
            · started {formatRelativeDate(run.startedAt)}
          </span>
        )}
        {duration && <span>· took {duration}</span>}
        {run.queue !== undefined && run.status === 'queued' && (
          <span>
            · {run.queue} round{run.queue === 1 ? '' : 's'} ahead
          </span>
        )}
        {run.provenance && (
          <span className="font-mono">
            · via {run.provenance.kind} {run.provenance.eventId.slice(0, 8)}
          </span>
        )}
        <span className="font-mono">· run {run.runId}</span>
      </p>
    </div>
  );
}

export function RunDetailPage() {
  const { runId = '' } = useParams();
  const { metadata, owner, repo } = useOutletContext<RepoContext>();
  const { run, jobs, loading, error } = useCiRun(
    owner,
    metadata.repoId,
    runId,
    metadata.maintainers
  );
  const { requestProfiles } = useProfileCache();

  useEffect(() => {
    if (run) requestProfiles([run.coordinator]);
  }, [run, requestProfiles]);

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

  const resulted = new Set(jobs.map((j) => j.jobId));
  const pendingIds = [
    ...run.inProgress,
    ...run.jobs.map((q) => q.jobId),
  ].filter((id, i, all) => !resulted.has(id) && all.indexOf(id) === i);

  return (
    <div className="space-y-4">
      <Link
        to={`/${owner}/${repo}/actions`}
        className="text-xs text-muted-foreground hover:text-primary hover:underline"
      >
        ← All workflow runs
      </Link>
      <RunHeader run={run} owner={owner} repo={repo} />
      <div className="space-y-3">
        {jobs.map((job) => (
          <JobCard key={job.eventId} job={job} />
        ))}
        {pendingIds.map((id) => (
          <PendingJob
            key={id}
            jobId={id}
            running={run.inProgress.includes(id)}
          />
        ))}
        {jobs.length === 0 && pendingIds.length === 0 && (
          <div className="rounded-md border bg-muted/30 p-6 text-center text-sm text-muted-foreground">
            {run.status === 'concluded'
              ? `The run concluded ${describeRunState(run)} without publishing any job results.`
              : 'Waiting for the coordinator to start jobs…'}
          </div>
        )}
      </div>
    </div>
  );
}
