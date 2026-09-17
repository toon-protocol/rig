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
import { describeRunState } from '@/components/ci-status-dot';
import { JobStateBadge } from '@/components/job-state-badge';
import { jobPageHref } from '@/app/pages/job-detail-page';
import { Skeleton } from '@/components/ui/skeleton';
import {
  formatClock,
  formatDuration,
  formatRelativeDate,
} from '../../date-utils.js';
import { hexToNpub } from '../../npub.js';
import { shortRefName } from '@/lib/ref-utils';
import { storeLinkHref } from '../../gateway-preference.js';
import {
  deriveRunJobs,
  type CiRun,
  type CiRunJob,
} from '../../nip-c1-parsers.js';

/** One job of the run: linked to its own page, whatever state it is in. */
function JobCard({
  job,
  owner,
  repo,
  runId,
}: {
  job: CiRunJob;
  owner: string;
  repo: string;
  runId: string;
}) {
  const result = job.result;
  const duration =
    result &&
    result.startedAt !== undefined &&
    result.createdAt >= result.startedAt
      ? formatDuration(result.createdAt - result.startedAt)
      : null;
  return (
    <section
      data-job-id={job.jobId}
      className={`rounded-md border ${job.state === 'pending' ? 'border-dashed' : ''}`}
    >
      <header className="flex flex-wrap items-center gap-2 border-b bg-muted/40 px-4 py-2">
        <h3 className="font-semibold text-foreground">
          <Link
            to={jobPageHref(owner, repo, runId, job.jobId)}
            className="hover:text-primary hover:underline"
          >
            {job.label}
          </Link>
        </h3>
        {job.label !== job.jobId && (
          <span className="font-mono text-xs text-muted-foreground">
            {job.jobId}
          </span>
        )}
        <JobStateBadge job={job} />
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
        <span className="ml-auto text-xs text-muted-foreground">
          {result?.queuedAt !== undefined && (
            <span title={formatClock(result.queuedAt)}>
              queued {formatRelativeDate(result.queuedAt)} ·{' '}
            </span>
          )}
          {result?.startedAt !== undefined && (
            <span title={formatClock(result.startedAt)}>
              started {formatRelativeDate(result.startedAt)}
            </span>
          )}
          {duration && <span> · {duration}</span>}
        </span>
      </header>
      {result ? (
        <pre className="max-h-96 overflow-auto bg-muted/20 p-4 font-mono text-xs leading-relaxed text-foreground">
          {result.logTail || '(no log tail)'}
        </pre>
      ) : (
        <p className="px-4 py-3 text-sm text-muted-foreground">
          {job.state === 'running'
            ? 'Running — its job log is published when the run concludes.'
            : job.state === 'pending'
              ? 'Not started yet.'
              : 'Concluded; waiting for its job result to arrive on the relay.'}
        </p>
      )}
      <footer className="flex flex-wrap items-center gap-3 border-t px-4 py-2 text-xs">
        <Link
          to={jobPageHref(owner, repo, runId, job.jobId)}
          className="text-primary underline-offset-2 hover:underline"
        >
          Job details
        </Link>
        {result &&
          (result.logsUrl ? (
            <a
              href={storeLinkHref(result.logsUrl)}
              target="_blank"
              rel="noreferrer"
              className="text-primary underline-offset-2 hover:underline"
            >
              Full log
            </a>
          ) : (
            <span className="text-muted-foreground">No full log uploaded</span>
          ))}
        {result && result.artifacts.length > 0 && (
          <span className="text-muted-foreground">
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
          </span>
        )}
      </footer>
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

  // Every job of the run, from its first in_progress marker onward — the
  // `in-progress` tag lists a job that has not started as readily as one that
  // is executing, so the state comes from deriveRunJobs, not from the tag.
  const runJobs = deriveRunJobs(run, jobs);

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
        {runJobs.map((job) => (
          <JobCard
            key={job.jobId}
            job={job}
            owner={owner}
            repo={repo}
            runId={run.runId}
          />
        ))}
        {runJobs.length === 0 && (
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
