import { useState, useMemo, useEffect } from 'react';
import { useOutletContext, Link } from 'react-router';
import { Search, Plus } from 'lucide-react';
import type { RepoContext } from '@/app/repo-layout';
import { usePRs } from '@/hooks/use-prs';
import { useCiRuns } from '@/hooks/use-ci-runs';
import { CiStatusDot } from '@/components/ci-status-dot';
import { useProfileCache } from '@/hooks/use-profile-cache';
import { formatRelativeDate } from '../../date-utils.js';
import { OpenCloseToggle } from '@/components/open-close-toggle';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import {
  Table,
  TableBody,
  TableCell,
  TableRow,
} from '@/components/ui/table';
import type { PRMetadata } from '../../nip34-parsers.js';
import type { CiRun } from '../../nip-c1-parsers.js';

const STATUS_BADGE: Record<string, { variant: 'default' | 'secondary' | 'destructive' | 'outline'; label: string }> = {
  open: { variant: 'default', label: 'Open' },
  applied: { variant: 'secondary', label: 'Merged' },
  closed: { variant: 'destructive', label: 'Closed' },
  draft: { variant: 'outline', label: 'Draft' },
};

/**
 * Where "how do I use the rig CLI?" is documented (mirrors CloneInstructions).
 */
const RIG_CLI_DOCS_URL =
  'https://github.com/toon-protocol/toon-client/tree/main/packages/rig#readme';

/**
 * "New pull request" affordance: rig has no web creation form (PRs are
 * published with `rig pr create`, a paid write carrying a real
 * `git format-patch` range), so this is a hand-off popover rather than a fake
 * form.
 */
function NewPRPopover() {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="success" size="sm" className="gap-1.5">
          <Plus aria-hidden="true" className="h-3.5 w-3.5" />
          New pull request
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[26rem] max-w-[calc(100vw-2rem)] p-4" align="end">
        <div className="space-y-3">
          <div className="space-y-1">
            <h3 className="text-sm font-semibold">Pull requests are published with the rig CLI</h3>
            <p className="text-xs text-muted-foreground">
              There's no web form — publishing a patch (kind:1617) is a paid write that
              carries a real <code className="font-mono">git format-patch</code> range,
              from your terminal.
            </p>
          </div>
          <pre className="overflow-x-auto rounded-md border bg-muted/50 p-3 font-mono text-xs leading-relaxed">
            {'rig pr create --title "<title>" --range <range>'}
          </pre>
          <p className="text-xs text-muted-foreground">
            See the{' '}
            <a
              href={RIG_CLI_DOCS_URL}
              target="_blank"
              rel="noreferrer"
              className="underline underline-offset-2 hover:text-foreground"
            >
              rig CLI docs
            </a>
            .
          </p>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/**
 * The CI runs to show for a PR: those whose NIP-22 context roots at the PR
 * event, else those for its tip commit (a kind:1618 `c` tip, or the last
 * commit of a kind:1617 series).
 */
export function prCiRuns(
  pr: Pick<PRMetadata, 'eventId' | 'tipCommit' | 'commitShas'>,
  runsForPr: (prEventId: string) => CiRun[],
  runsForCommit: (sha: string) => CiRun[]
): CiRun[] {
  const byPr = runsForPr(pr.eventId);
  if (byPr.length > 0) return byPr;
  const tip = pr.tipCommit ?? pr.commitShas[pr.commitShas.length - 1];
  return tip ? runsForCommit(tip) : [];
}

export function PRListPage() {
  const { metadata, owner, repo } = useOutletContext<RepoContext>();
  const { prs, loading, error } = usePRs(owner, metadata.repoId, metadata.maintainers);
  const { getDisplayName, requestProfiles } = useProfileCache();
  const [filter, setFilter] = useState<'open' | 'closed'>('open');
  // CI status per PR (rig#125): runs rooted at the PR event, else at its tip.
  const { runsForPr, runsForCommit } = useCiRuns(owner, metadata.repoId, metadata.maintainers);

  useEffect(() => {
    if (prs.length > 0) {
      requestProfiles(prs.map((p) => p.authorPubkey));
    }
  }, [prs, requestProfiles]);

  const openCount = useMemo(() => prs.filter((p) => p.status === 'open' || p.status === 'draft').length, [prs]);
  const closedCount = useMemo(() => prs.filter((p) => p.status === 'closed' || p.status === 'applied').length, [prs]);
  const filtered = useMemo(() => {
    if (filter === 'open') return prs.filter((p) => p.status === 'open' || p.status === 'draft');
    return prs.filter((p) => p.status === 'closed' || p.status === 'applied');
  }, [prs, filter]);

  if (error) {
    return <div className="text-destructive-foreground">Failed to load pull requests: {error.message}</div>;
  }

  if (loading) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-10 w-48" />
        {Array.from({ length: 5 }, (_, i) => (
          <Skeleton key={i} className="h-12 w-full" />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <div className="relative min-w-0 flex-1">
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
          />
          <input
            type="text"
            readOnly
            value={`is:${filter}`}
            aria-label="Pull request filter (use the Open/Closed toggle below to change it)"
            title="Full-text filtering isn't available yet — use the Open/Closed toggle below."
            className="h-9 w-full rounded-md border bg-background pl-8 pr-3 text-sm text-muted-foreground shadow-xs outline-none"
          />
        </div>
        <NewPRPopover />
      </div>

      <div className="rounded-md border">
        <OpenCloseToggle
          openCount={openCount}
          closedCount={closedCount}
          value={filter}
          onChange={setFilter}
        />

        {filtered.length === 0 ? (
          <div className="py-8 text-center text-muted-foreground">
            No {filter === 'open' ? 'open' : 'closed'} pull requests found.
          </div>
        ) : (
          <Table>
            <TableBody>
              {filtered.map((pr) => {
                // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                const badge = STATUS_BADGE[pr.status] ?? STATUS_BADGE['open']!;
                return (
                  <TableRow key={pr.eventId}>
                    <TableCell className="w-8 py-3 pl-3 pr-0 align-top">
                      {pr.status === 'open' || pr.status === 'draft' ? (
                        <svg className="mt-0.5 h-4 w-4 text-success" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                          <circle cx="8" cy="8" r="7" stroke="currentColor" strokeWidth="1" fill="none" />
                        </svg>
                      ) : (
                        <svg className="mt-0.5 h-4 w-4 text-purple-600 dark:text-purple-400" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                          <circle cx="8" cy="8" r="5" />
                        </svg>
                      )}
                    </TableCell>
                    <TableCell className="py-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <Link
                          to={`/${owner}/${repo}/pulls/${pr.eventId}`}
                          className="font-semibold hover:text-primary hover:underline"
                        >
                          {pr.title}
                        </Link>
                        <Badge variant={badge.variant} className="text-[10px]">
                          {badge.label}
                        </Badge>
                        <CiStatusDot
                          runs={prCiRuns(pr, runsForPr, runsForCommit)}
                          owner={owner}
                          repo={repo}
                        />
                        <span className="text-xs text-muted-foreground">
                          → {pr.baseBranch}
                        </span>
                      </div>
                      <div className="mt-0.5 text-xs text-muted-foreground">
                        opened {formatRelativeDate(pr.createdAt)} by {getDisplayName(pr.authorPubkey)}
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </div>
    </div>
  );
}
