/**
 * PRListPage CI status dots (rig#132): a PR shows the dot for runs rooted at
 * its event, else for its tip commit; a repo with no CI events renders the
 * row exactly as before.
 */

import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router';
import { afterEach, describe, it, expect, vi, beforeEach } from 'vitest';
import type { RepoContext } from '@/app/repo-layout';
import type { PRMetadata } from '../nip34-parsers.js';
import type { CiRun } from '../nip-c1-parsers.js';

vi.mock('@/hooks/use-prs', () => ({ usePRs: vi.fn() }));
vi.mock('@/hooks/use-ci-runs', () => ({ useCiRuns: vi.fn() }));
vi.mock('@/hooks/use-profile-cache', () => ({
  useProfileCache: () => ({
    getDisplayName: (pk: string) => `user-${pk.slice(0, 4)}`,
    requestProfiles: vi.fn(),
    version: 0,
  }),
}));
vi.mock('@/hooks/use-rig-config', () => ({
  useRigConfig: () => ({
    relayUrl: 'ws://localhost:7100',
    repoFilter: undefined,
    owner: undefined,
  }),
}));

import { PRListPage, prCiRuns } from '@/app/pages/pr-list-page';
import { usePRs } from '@/hooks/use-prs';
import { useCiRuns } from '@/hooks/use-ci-runs';

const mockUsePRs = vi.mocked(usePRs);
const mockUseCiRuns = vi.mocked(useCiRuns);

afterEach(() => cleanup());

const OWNER_HEX = 'ab'.repeat(32);
const AUTHOR = 'cd'.repeat(32);
const COORD = '12'.repeat(32);
const TIP = '9a'.repeat(20);
const LAST = '7b'.repeat(20);
const PR_ID = '55'.repeat(32);
const OTHER_PR_ID = '66'.repeat(32);

const CONTEXT: RepoContext = {
  metadata: {
    repoId: 'demo',
    name: 'demo',
    description: '',
    ownerPubkey: OWNER_HEX,
    defaultBranch: 'main',
    eventId: 'evt',
    cloneUrls: [],
    webUrls: [],
    maintainers: [],
  },
  refs: null,
  owner: 'npub1owner',
  repo: 'demo',
};

function pr(overrides: Partial<PRMetadata> = {}): PRMetadata {
  return {
    eventId: PR_ID,
    title: 'Add thing',
    content: '',
    authorPubkey: AUTHOR,
    createdAt: 1700000000,
    commitShas: [TIP],
    baseBranch: 'main',
    status: 'open',
    sourceKind: 1617,
    ...overrides,
  };
}

function run(overrides: Partial<CiRun> = {}): CiRun {
  return {
    runId: 'run-1',
    coordinator: COORD,
    trigger: {
      repoAddr: `30617:${OWNER_HEX}:demo`,
      commit: TIP,
      workflow: { path: '.github/workflows/ci.yml', sha256: 'f0'.repeat(32) },
      reason: 'pull_request',
      pr: {
        prEventId: PR_ID,
        prAuthor: AUTHOR,
        prKind: 1617,
        sourceEventId: PR_ID,
        sourceAuthor: AUTHOR,
        sourceKind: 1617,
      },
    },
    status: 'concluded',
    conclusion: 'success',
    inProgress: [],
    createdAt: 1700000000,
    jobs: [],
    trust: 'maintainer-directed',
    current: true,
    ...overrides,
  };
}

function ciRuns(
  byPr: Record<string, CiRun[]>,
  byCommit: Record<string, CiRun[]> = {}
): ReturnType<typeof useCiRuns> {
  return {
    runs: [...Object.values(byPr).flat(), ...Object.values(byCommit).flat()],
    runsForCommit: (sha: string) => byCommit[sha] ?? [],
    runsForPr: (id: string) => byPr[id] ?? [],
    controls: [],
    loading: false,
    error: null,
  };
}

function renderPulls() {
  return render(
    <MemoryRouter initialEntries={['/npub1owner/demo/pulls']}>
      <Routes>
        <Route path=":owner/:repo" element={<Outlet context={CONTEXT} />}>
          <Route path="pulls" element={<PRListPage />} />
        </Route>
      </Routes>
    </MemoryRouter>
  );
}

describe('prCiRuns', () => {
  it('prefers runs rooted at the PR event, then the tip commit, then the last patch commit', () => {
    const rooted = [run()];
    const byTip = [run({ runId: 'tip' })];
    const byLast = [run({ runId: 'last' })];
    const runsForCommit = (sha: string) =>
      sha === TIP ? byTip : sha === LAST ? byLast : [];
    expect(prCiRuns(pr(), () => rooted, runsForCommit)).toBe(rooted);
    expect(prCiRuns(pr(), () => [], runsForCommit)).toBe(byTip);
    expect(
      prCiRuns(
        pr({ sourceKind: 1618, tipCommit: TIP, commitShas: [] }),
        () => [],
        runsForCommit
      )
    ).toBe(byTip);
    expect(
      prCiRuns(
        pr({ commitShas: ['11'.repeat(20), LAST] }),
        () => [],
        runsForCommit
      )
    ).toBe(byLast);
    expect(prCiRuns(pr({ commitShas: [] }), () => [], runsForCommit)).toEqual(
      []
    );
  });
});

describe('[P1] PRListPage CI status dots', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUsePRs.mockReturnValue({
      prs: [pr(), pr({ eventId: OTHER_PR_ID, title: 'Fix other' })],
      loading: false,
      error: null,
    });
  });

  it('shows the dot for the PR whose event roots a run and links to that run', () => {
    mockUseCiRuns.mockReturnValue(ciRuns({ [PR_ID]: [run()] }));
    const { container } = renderPulls();
    expect(mockUseCiRuns).toHaveBeenCalledWith('npub1owner', 'demo', []);
    const dot = screen.getByRole('link', { name: 'CI passing' });
    expect(dot).toHaveAttribute('href', '/npub1owner/demo/actions/run-1');
    expect(container.querySelectorAll('[data-ci-status]')).toHaveLength(1);
    expect(dot.closest('tr')).toHaveTextContent('Add thing');
    expect(dot.closest('tr')).not.toHaveTextContent('Fix other');
  });

  it('falls back to runs for the PR tip commit when none quote the PR event', () => {
    const pushRun = run({
      conclusion: 'failure',
      trigger: { ...run().trigger, pr: undefined, reason: 'push' },
    });
    mockUseCiRuns.mockReturnValue(ciRuns({}, { [TIP]: [pushRun] }));
    renderPulls();
    // Both PRs share the tip in this fixture, so both rows get the dot.
    const dots = screen.getAllByRole('link', { name: 'CI failing' });
    expect(dots).toHaveLength(2);
    expect(dots[0]).toHaveAttribute('data-ci-status', 'failure');
  });

  it('renders a repo with no CI events exactly as before: no dot, title and status intact', () => {
    mockUseCiRuns.mockReturnValue(ciRuns({}));
    const { container } = renderPulls();
    expect(container.querySelector('[data-ci-status]')).toBeNull();
    expect(screen.queryByRole('link', { name: /^CI / })).toBeNull();
    const row = screen.getByRole('link', { name: 'Add thing' }).closest('tr');
    if (!row) throw new Error('row not rendered');
    expect(row.querySelectorAll('a')).toHaveLength(1);
    expect(row).toHaveTextContent('Open');
    expect(row).toHaveTextContent('→ main');
    expect(row).toHaveTextContent(`by user-${AUTHOR.slice(0, 4)}`);
  });
});
