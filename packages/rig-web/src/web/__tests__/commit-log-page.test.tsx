/**
 * CommitLogPage CI status dots (rig#132): a commit with current runs shows
 * the dot; a repo with no CI events renders the row exactly as before.
 */

import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router';
import { afterEach, describe, it, expect, vi, beforeEach } from 'vitest';
import type { RepoContext } from '@/app/repo-layout';
import type { CommitLogEntry } from '../commit-walker.js';
import type { CiRun } from '../nip-c1-parsers.js';

vi.mock('@/hooks/use-commit-log', () => ({ useCommitLog: vi.fn() }));
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

import { CommitLogPage } from '@/app/pages/commit-log-page';
import { useCommitLog } from '@/hooks/use-commit-log';
import { useCiRuns } from '@/hooks/use-ci-runs';

const mockUseCommitLog = vi.mocked(useCommitLog);
const mockUseCiRuns = vi.mocked(useCiRuns);

afterEach(() => cleanup());

const OWNER_HEX = 'ab'.repeat(32);
const MAINTAINER = 'cd'.repeat(32);
const COORD = '12'.repeat(32);
const SHA = '9a'.repeat(20);
const OTHER_SHA = '7b'.repeat(20);

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
    maintainers: [MAINTAINER],
  },
  refs: {
    repoId: 'demo',
    refs: new Map([['refs/heads/main', SHA]]),
    arweaveMap: new Map(),
  },
  owner: 'npub1owner',
  repo: 'demo',
};

function entry(sha: string, message: string): CommitLogEntry {
  return {
    sha,
    commit: {
      treeSha: '11'.repeat(20),
      parentShas: [],
      author: 'Alice <alice@example.com> 1700000000 +0000',
      committer: 'Alice <alice@example.com> 1700000000 +0000',
      message: `${message}\n\nbody`,
    },
  };
}

function run(overrides: Partial<CiRun> = {}): CiRun {
  return {
    runId: 'run-1',
    coordinator: COORD,
    trigger: {
      repoAddr: `30617:${OWNER_HEX}:demo`,
      commit: SHA,
      workflow: { path: '.github/workflows/ci.yml', sha256: 'f0'.repeat(32) },
      reason: 'push',
      ref: 'refs/heads/main',
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
  byCommit: Record<string, CiRun[]>
): ReturnType<typeof useCiRuns> {
  return {
    runs: Object.values(byCommit).flat(),
    runsForCommit: (sha: string) => byCommit[sha] ?? [],
    runsForPr: () => [],
    controls: [],
    loading: false,
    error: null,
  };
}

function renderCommits() {
  return render(
    <MemoryRouter initialEntries={['/npub1owner/demo/commits']}>
      <Routes>
        <Route path=":owner/:repo" element={<Outlet context={CONTEXT} />}>
          <Route path="commits" element={<CommitLogPage />} />
          <Route path="commits/:ref" element={<CommitLogPage />} />
        </Route>
      </Routes>
    </MemoryRouter>
  );
}

describe('[P1] CommitLogPage CI status dots', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseCommitLog.mockReturnValue({
      entries: [entry(SHA, 'feat: add thing'), entry(OTHER_SHA, 'chore: tidy')],
      loading: false,
      hasMore: false,
      error: null,
    });
  });

  it('shows a dot on the commit that has current runs and none on the others', () => {
    mockUseCiRuns.mockReturnValue(ciRuns({ [SHA]: [run()] }));
    const { container } = renderCommits();
    expect(mockUseCiRuns).toHaveBeenCalledWith('npub1owner', 'demo', [
      MAINTAINER,
    ]);
    const dot = screen.getByRole('link', { name: 'CI passing' });
    expect(dot).toHaveAttribute('href', '/npub1owner/demo/actions/run-1');
    expect(container.querySelectorAll('[data-ci-status]')).toHaveLength(1);
    // The dot sits in the row of the commit it belongs to.
    expect(dot.closest('li')).toHaveTextContent('feat: add thing');
    expect(dot.closest('li')).not.toHaveTextContent('chore: tidy');
  });

  it('pulses for an in-progress run and turns red for a failed one', () => {
    mockUseCiRuns.mockReturnValue(
      ciRuns({
        [SHA]: [run({ status: 'in_progress', conclusion: undefined })],
        [OTHER_SHA]: [
          run({
            runId: 'run-2',
            conclusion: 'failure',
            trigger: { ...run().trigger, commit: OTHER_SHA },
          }),
        ],
      })
    );
    renderCommits();
    expect(
      screen.getByRole('link', { name: 'CI in progress' })
    ).toHaveAttribute('data-ci-status', 'pending');
    expect(screen.getByRole('link', { name: 'CI failing' })).toHaveAttribute(
      'data-ci-status',
      'failure'
    );
  });

  it('renders a repo with no CI events exactly as before: no dot, same links and buttons', () => {
    mockUseCiRuns.mockReturnValue(ciRuns({}));
    const { container } = renderCommits();
    expect(container.querySelector('[data-ci-status]')).toBeNull();
    expect(screen.queryByRole('link', { name: /^CI / })).toBeNull();
    // Per row: the message link, the short-sha link, the browse-tree link,
    // and the copy button — nothing else.
    const firstRow = screen
      .getByRole('link', { name: 'feat: add thing' })
      .closest('li');
    if (!firstRow) throw new Error('row not rendered');
    expect(firstRow.querySelectorAll('a')).toHaveLength(3);
    expect(firstRow.querySelectorAll('button')).toHaveLength(1);
    expect(screen.getByRole('link', { name: SHA.slice(0, 7) })).toHaveAttribute(
      'href',
      `/npub1owner/demo/commit/${SHA}`
    );
  });
});
