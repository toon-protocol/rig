import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router';
import { afterEach, describe, it, expect, vi, beforeEach } from 'vitest';
import type { RepoContext } from '@/app/repo-layout';
import type { CiRun, CiJobResult } from '../nip-c1-parsers.js';

vi.mock('@/hooks/use-ci-runs', () => ({
  useCiRuns: vi.fn(),
  useCiRun: vi.fn(),
}));
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

import { ActionsPage } from '@/app/pages/actions-page';
import { RunDetailPage } from '@/app/pages/run-detail-page';
import { useCiRuns, useCiRun } from '@/hooks/use-ci-runs';

const mockUseCiRuns = vi.mocked(useCiRuns);
const mockUseCiRun = vi.mocked(useCiRun);

// No `globals: true` in this package's vitest config, so RTL's automatic
// cleanup does not run — unmount between tests explicitly.
afterEach(() => cleanup());

const OWNER_HEX = 'ab'.repeat(32);
const COORD = '12'.repeat(32);
const COMMIT = '9a'.repeat(20);

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

function run(overrides: Partial<CiRun> = {}): CiRun {
  return {
    runId: 'run-1',
    coordinator: COORD,
    trigger: {
      repoAddr: `30617:${OWNER_HEX}:demo`,
      commit: COMMIT,
      workflow: { path: '.github/workflows/ci.yml', sha256: 'f0'.repeat(32) },
      reason: 'push',
      ref: 'refs/heads/main',
    },
    status: 'concluded',
    conclusion: 'success',
    inProgress: [],
    createdAt: 1700000000,
    startedAt: 1700000010,
    jobs: [
      { eventId: '88'.repeat(32), relayUrl: '', pubkey: COORD, jobId: 'build' },
    ],
    trust: 'maintainer-directed',
    current: true,
    ...overrides,
  };
}

function job(overrides: Partial<CiJobResult> = {}): CiJobResult {
  return {
    eventId: '88'.repeat(32),
    pubkey: COORD,
    createdAt: 1700000020,
    trigger: run().trigger,
    progressAddress: `39842:${COORD}:run-1`,
    coordinator: COORD,
    runId: 'run-1',
    jobId: 'build',
    name: 'Build',
    conclusion: 'success',
    logsUrl: 'http://localhost:3000/raw/tx-log',
    logTail: '[log-tail omitted=120]\nnpm run build\ndone',
    artifacts: [
      {
        url: 'http://localhost:3000/raw/tx-art',
        filename: 'dist/index.js',
        name: 'dist',
      },
    ],
    startedAt: 1700000010,
    exitCode: 0,
    runsOn: ['ubuntu-latest'],
    ...overrides,
  };
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path=":owner/:repo" element={<Outlet context={CONTEXT} />}>
          <Route path="actions" element={<ActionsPage />} />
          <Route path="actions/:runId" element={<RunDetailPage />} />
        </Route>
      </Routes>
    </MemoryRouter>
  );
}

function ciRunsResult(
  runs: CiRun[],
  loading = false
): ReturnType<typeof useCiRuns> {
  return {
    runs,
    runsForCommit: () => [],
    runsForPr: () => [],
    controls: [],
    loading,
    error: null,
  };
}

describe('[P1] ActionsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows a quiet empty card when the repo has no runs', () => {
    mockUseCiRuns.mockReturnValue(ciRunsResult([]));
    renderAt('/npub1owner/demo/actions');
    expect(screen.getByText('No workflow runs yet')).toBeInTheDocument();
  });

  it('renders skeletons while loading', () => {
    mockUseCiRuns.mockReturnValue(ciRunsResult([], true));
    const { container } = renderAt('/npub1owner/demo/actions');
    expect(
      container.querySelectorAll('[data-slot="skeleton"]').length
    ).toBeGreaterThan(0);
  });

  it('lists runs newest first with conclusion, workflow, reason, commit, coordinator and trust', () => {
    mockUseCiRuns.mockReturnValue(
      ciRunsResult([
        run({
          runId: 'run-2',
          createdAt: 1700000100,
          status: 'in_progress',
          conclusion: undefined,
          inProgress: ['build'],
          trust: 'no-known-context',
          reason: undefined,
        } as never),
        run(),
      ])
    );
    renderAt('/npub1owner/demo/actions');
    const rows = screen.getAllByRole('link', { name: /ci\.yml/ });
    expect(rows[0]).toHaveAttribute('href', '/npub1owner/demo/actions/run-2');
    expect(rows[1]).toHaveAttribute('href', '/npub1owner/demo/actions/run-1');
    expect(screen.getByText('in progress')).toBeInTheDocument();
    expect(screen.getByText('success')).toBeInTheDocument();
    expect(screen.getAllByText('push').length).toBe(2);
    expect(
      screen.getAllByRole('link', { name: COMMIT.slice(0, 7) })[0]
    ).toHaveAttribute('href', `/npub1owner/demo/commit/${COMMIT}`);
    expect(screen.getAllByText(`user-${COORD.slice(0, 4)}`).length).toBe(2);
    expect(screen.getByText('maintainer-directed')).toBeInTheDocument();
    expect(screen.getByText('no-known-context')).toBeInTheDocument();
    expect(screen.getAllByText('main').length).toBe(2);
  });

  it('links a pull_request run to its PR', () => {
    const prId = '55'.repeat(32);
    mockUseCiRuns.mockReturnValue(
      ciRunsResult([
        run({
          trigger: {
            ...run().trigger,
            reason: 'pull_request',
            ref: undefined,
            pr: {
              prEventId: prId,
              prAuthor: 'cd'.repeat(32),
              prKind: 1617,
              sourceEventId: prId,
              sourceAuthor: 'cd'.repeat(32),
              sourceKind: 1617,
            },
          },
        }),
      ])
    );
    renderAt('/npub1owner/demo/actions');
    expect(screen.getByRole('link', { name: /pull request/i })).toHaveAttribute(
      'href',
      `/npub1owner/demo/pulls/${prId}`
    );
  });
});

describe('[P1] RunDetailPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the run header, each job with conclusion, timings, log tail and links', () => {
    mockUseCiRun.mockReturnValue({
      run: run(),
      jobs: [job()],
      loading: false,
      error: null,
    });
    renderAt('/npub1owner/demo/actions/run-1');
    expect(screen.getByRole('heading', { name: 'ci' })).toHaveAttribute(
      'title',
      '.github/workflows/ci.yml'
    );
    expect(screen.getByText('Build')).toBeInTheDocument();
    // One badge for the run, one for its job.
    expect(
      screen.getAllByText('success', { selector: '[data-slot="badge"]' })
    ).toHaveLength(2);
    expect(screen.getByText(/exit code 0/i)).toBeInTheDocument();
    expect(screen.getByText(/npm run build/)).toBeInTheDocument();
    const logs = screen.getByRole('link', { name: /full log/i });
    expect(logs).toHaveAttribute('href', 'http://localhost:3000/raw/tx-log');
    expect(logs).toHaveAttribute('rel', 'noreferrer');
    expect(screen.getByRole('link', { name: 'dist/index.js' })).toHaveAttribute(
      'href',
      'http://localhost:3000/raw/tx-art'
    );
    expect(screen.getByText('maintainer-directed')).toBeInTheDocument();
  });

  it('lists a pending job from the progress marker before its result arrives', () => {
    mockUseCiRun.mockReturnValue({
      run: run({
        status: 'in_progress',
        conclusion: undefined,
        inProgress: ['build', 'test'],
        jobs: [],
      }),
      jobs: [],
      loading: false,
      error: null,
    });
    renderAt('/npub1owner/demo/actions/run-1');
    expect(screen.getByText('build')).toBeInTheDocument();
    expect(screen.getByText('test')).toBeInTheDocument();
    expect(screen.getAllByText('in progress').length).toBeGreaterThanOrEqual(2);
  });

  it('says so when the run is unknown', () => {
    mockUseCiRun.mockReturnValue({
      run: null,
      jobs: [],
      loading: false,
      error: null,
    });
    renderAt('/npub1owner/demo/actions/nope');
    expect(screen.getByText('Run not found.')).toBeInTheDocument();
  });
});
