import { useEffect, useMemo } from 'react';
import { Link, useOutletContext } from 'react-router';
import type { RepoContext } from '@/app/repo-layout';
import { useCiRuns } from '@/hooks/use-ci-runs';
import { useProfileCache } from '@/hooks/use-profile-cache';
import {
  conclusionBadgeClass,
  describeRunState,
} from '@/components/ci-status-dot';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { formatRelativeDate } from '../../date-utils.js';
import { hexToNpub } from '../../npub.js';
import { shortRefName } from '@/lib/ref-utils';
import type { CiRun, CiTrustLevel } from '../../nip-c1-parsers.js';

/** Where "how do I run CI on TOON?" is documented (mirrors the PR popover). */
const RIG_CI_DOCS_URL =
  'https://github.com/toon-protocol/rig/tree/main/packages/rig#readme';

const TRUST_CLASS: Record<CiTrustLevel, string> = {
  'maintainer-directed': 'border-success/40 text-success-emphasis',
  'operationally-associated': 'border-primary/40 text-primary',
  'seen-in-network': 'border-border text-muted-foreground',
  'no-known-context': 'border-dashed border-border text-muted-foreground',
};

const TRUST_TITLE: Record<CiTrustLevel, string> = {
  'maintainer-directed':
    'A maintainer asked this coordinator to run the repo (Service Request on record).',
  'operationally-associated':
    'A maintainer had a standing Service Request with this coordinator when it ran.',
  'seen-in-network':
    'The coordinator is a maintainer, or someone requested service from it.',
  'no-known-context':
    'Nothing ties this coordinator to the repo’s maintainers.',
};

/** Trust-level pill, shared by the Actions list and the run page. */
export function TrustBadge({ level }: { level: CiTrustLevel }) {
  return (
    <Badge
      variant="outline"
      className={`text-[10px] ${TRUST_CLASS[level]}`}
      title={TRUST_TITLE[level]}
    >
      {level}
    </Badge>
  );
}

/** Workflow-state pill (queued / in progress / conclusion). */
export function RunStateBadge({
  run,
}: {
  run: Pick<CiRun, 'status' | 'conclusion'>;
}) {
  return (
    <Badge
      className={`text-[10px] ${conclusionBadgeClass(run.status, run.conclusion)}`}
    >
      {describeRunState(run)}
    </Badge>
  );
}

/** Short workflow label: the file name without directory or extension. */
export function workflowLabel(path: string): string {
  const base = path.split('/').pop() ?? path;
  return base.replace(/\.ya?ml$/i, '');
}

/** What triggered the run, as a compact link (branch, PR, or "manual"). */
function TriggerContext({
  run,
  owner,
  repo,
}: {
  run: CiRun;
  owner: string;
  repo: string;
}) {
  if (run.trigger.pr) {
    return (
      <Link
        to={`/${owner}/${repo}/pulls/${run.trigger.pr.prEventId}`}
        className="font-mono text-xs text-muted-foreground hover:text-primary hover:underline"
      >
        pull request {run.trigger.pr.prEventId.slice(0, 8)}
      </Link>
    );
  }
  if (run.trigger.ref) {
    return (
      <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground">
        {shortRefName(run.trigger.ref)}
      </span>
    );
  }
  return null;
}

function RunRow({
  run,
  owner,
  repo,
}: {
  run: CiRun;
  owner: string;
  repo: string;
}) {
  const { getDisplayName } = useProfileCache();
  const coordinatorNpub = hexToNpub(run.coordinator);
  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <Link
            to={`/${owner}/${repo}/actions/${run.runId}`}
            className="font-semibold text-foreground hover:text-primary hover:underline"
            title={run.trigger.workflow.path}
          >
            {run.trigger.workflow.path}
          </Link>
          <RunStateBadge run={run} />
          {!run.current && (
            <Badge
              variant="outline"
              className="text-[10px] text-muted-foreground"
            >
              superseded
            </Badge>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span>{run.trigger.reason}</span>
          <TriggerContext run={run} owner={owner} repo={repo} />
          <Link
            to={`/${owner}/${repo}/commit/${run.trigger.commit}`}
            className="rounded-md border px-1.5 py-0.5 font-mono hover:bg-muted hover:text-foreground"
          >
            {run.trigger.commit.slice(0, 7)}
          </Link>
          <span>{formatRelativeDate(run.startedAt ?? run.createdAt)}</span>
        </div>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1 text-xs">
        <Link
          to={`/${coordinatorNpub}`}
          className="text-muted-foreground hover:text-primary hover:underline"
        >
          {getDisplayName(run.coordinator)}
        </Link>
        <TrustBadge level={run.trust} />
      </div>
    </li>
  );
}

export function ActionsPage() {
  const { metadata, owner, repo } = useOutletContext<RepoContext>();
  const { runs, loading, error } = useCiRuns(
    owner,
    metadata.repoId,
    metadata.maintainers
  );
  const { requestProfiles } = useProfileCache();

  const coordinators = useMemo(
    () => [...new Set(runs.map((r) => r.coordinator))],
    [runs]
  );
  useEffect(() => {
    if (coordinators.length > 0) requestProfiles(coordinators);
  }, [coordinators, requestProfiles]);

  if (error) {
    return (
      <div className="text-destructive-foreground">
        Failed to load workflow runs: {error.message}
      </div>
    );
  }

  if (loading && runs.length === 0) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 5 }, (_, i) => (
          <Skeleton key={i} className="h-12 w-full" />
        ))}
      </div>
    );
  }

  if (runs.length === 0) {
    return (
      <div className="rounded-md border bg-muted/30 p-8 text-center">
        <p className="font-medium text-foreground">No workflow runs yet</p>
        <p className="mt-1 text-sm text-muted-foreground">
          A maintainer can ask a coordinator to run this repo&apos;s workflows
          with{' '}
          <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">
            rig ci request
          </code>
          . See the{' '}
          <a
            href={RIG_CI_DOCS_URL}
            target="_blank"
            rel="noreferrer"
            className="underline underline-offset-2 hover:text-foreground"
          >
            rig CLI docs
          </a>
          .
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="rounded-md border">
        <div className="flex items-center gap-2 rounded-t-md border-b bg-muted/40 px-4 py-2 text-sm">
          <span className="font-semibold text-foreground">{runs.length}</span>
          <span className="text-muted-foreground">
            workflow run{runs.length === 1 ? '' : 's'}
          </span>
        </div>
        <ul className="divide-y">
          {runs.map((run) => (
            <RunRow
              key={`${run.coordinator}:${run.runId}`}
              run={run}
              owner={owner}
              repo={repo}
            />
          ))}
        </ul>
      </div>
    </div>
  );
}
