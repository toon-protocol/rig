import { Badge } from '@/components/ui/badge';
import { conclusionBadgeClass } from '@/components/ci-status-dot';
import type { CiRunJob } from '../nip-c1-parsers.js';

/**
 * What one job's state is called on screen (rig#190). The three states a run
 * reveals read differently on purpose: an empty pane under "not started" is
 * a job waiting its turn, and under "in progress" a job whose output has not
 * arrived — never the same thing.
 */
export function jobStateLabel(job: Pick<CiRunJob, 'state' | 'result'>): string {
  switch (job.state) {
    case 'pending':
      return 'not started';
    case 'running':
      return 'in progress';
    default:
      return (job.result?.conclusion ?? 'concluded').replace(/_/g, ' ');
  }
}

function badgeClass(job: Pick<CiRunJob, 'state' | 'result'>): string {
  switch (job.state) {
    case 'pending':
      return 'border border-dashed bg-transparent text-muted-foreground';
    case 'running':
      return `animate-pulse ${conclusionBadgeClass('in_progress', undefined)}`;
    default:
      return conclusionBadgeClass('concluded', job.result?.conclusion);
  }
}

/** The state badge shown for a job on the run page and on its own page. */
export function JobStateBadge({
  job,
  className = '',
}: {
  job: Pick<CiRunJob, 'state' | 'result'>;
  className?: string;
}) {
  return (
    <Badge
      data-job-state={job.state}
      className={`text-[10px] ${badgeClass(job)} ${className}`}
    >
      {jobStateLabel(job)}
    </Badge>
  );
}
