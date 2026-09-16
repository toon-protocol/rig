import { Link } from 'react-router';
import { cn } from '@/lib/utils';
import {
  aggregateRunStatus,
  type CiAggregateStatus,
  type CiConclusion,
  type CiProgressStatus,
  type CiRun,
} from '../nip-c1-parsers.js';

/** Dot colour per aggregate status; yellow pulses while anything still runs. */
const DOT_CLASS: Record<CiAggregateStatus, string> = {
  success: 'bg-success',
  failure: 'bg-destructive',
  pending: 'animate-pulse bg-yellow-500 dark:bg-yellow-400',
  neutral: 'bg-muted-foreground/60',
};

const STATUS_LABEL: Record<CiAggregateStatus, string> = {
  success: 'passing',
  failure: 'failing',
  pending: 'in progress',
  neutral: 'neutral',
};

/** Human label for one run's state (used by the tooltip and the pages). */
export function describeRunState(
  run: Pick<CiRun, 'status' | 'conclusion'>
): string {
  if (run.status !== 'concluded')
    return run.status === 'queued' ? 'queued' : 'in progress';
  return (run.conclusion ?? 'concluded').replace(/_/g, ' ');
}

/**
 * Colour classes for a single conclusion/status badge, shared by the Actions
 * list and the run page so a "failure" badge looks the same everywhere.
 */
export function conclusionBadgeClass(
  status: CiProgressStatus,
  conclusion: CiConclusion | undefined
): string {
  if (status !== 'concluded')
    return 'bg-yellow-500/15 text-yellow-700 dark:text-yellow-300';
  switch (conclusion) {
    case 'success':
      return 'bg-success/15 text-success-emphasis';
    case 'failure':
    case 'timed_out':
    case 'startup_failure':
    case 'cancelled':
      return 'bg-destructive/15 text-destructive';
    default:
      return 'bg-muted text-muted-foreground';
  }
}

interface CiStatusDotProps {
  /** Current runs for one commit or PR; nothing renders when empty. */
  runs: readonly CiRun[];
  owner: string;
  repo: string;
  className?: string;
}

/**
 * The small CI status circle on commit and PR rows (rig#125): green passing,
 * red failing, pulsing yellow while a run is queued or in progress, grey for
 * a neutral/skipped outcome. Renders NOTHING for a commit without runs, so
 * repos with no coordinator look exactly as they did before. Links to the run
 * page when there is exactly one run, else to the Actions tab.
 */
export function CiStatusDot({
  runs,
  owner,
  repo,
  className,
}: CiStatusDotProps) {
  const status = aggregateRunStatus(runs);
  if (status === null) return null;

  const count = runs.length;
  const detail = runs
    .map((r) => `${r.trigger.workflow.path}: ${describeRunState(r)}`)
    .join('\n');
  const title = `CI ${STATUS_LABEL[status]} — ${count} run${count === 1 ? '' : 's'}\n${detail}`;
  const single = runs[0];
  const to =
    count === 1 && single
      ? `/${owner}/${repo}/actions/${single.runId}`
      : `/${owner}/${repo}/actions`;

  return (
    <Link
      to={to}
      title={title}
      aria-label={`CI ${STATUS_LABEL[status]}`}
      data-ci-status={status}
      className={cn('inline-flex shrink-0 items-center', className)}
    >
      <span
        aria-hidden="true"
        className={cn('block h-2.5 w-2.5 rounded-full', DOT_CLASS[status])}
      />
    </Link>
  );
}
