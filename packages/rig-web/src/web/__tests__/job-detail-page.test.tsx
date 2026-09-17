import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router';
import { afterEach, describe, it, expect, vi, beforeEach } from 'vitest';
import type { RepoContext } from '@/app/repo-layout';
import type { CiJobResult, CiRun } from '../nip-c1-parsers.js';
import { PREFERRED_GATEWAY } from '../gateway-preference.js';
import { JOB_LOG_CEILING_BYTES } from '../job-log.js';

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

import { JobDetailPage } from '@/app/pages/job-detail-page';
import { RunDetailPage } from '@/app/pages/run-detail-page';
import { useCiRun } from '@/hooks/use-ci-runs';

const mockUseCiRun = vi.mocked(useCiRun);

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const OWNER_HEX = 'ab'.repeat(32);
const COORD = '12'.repeat(32);
const COMMIT = '9a'.repeat(20);
const LOGS_URL = 'http://localhost:3000/raw/tx-log';

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
    conclusion: 'failure',
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
    conclusion: 'failure',
    logsUrl: LOGS_URL,
    logTail: 'error: it broke',
    logOmittedBytes: 4096,
    artifacts: [],
    startedAt: 1700000010,
    exitCode: 1,
    runsOn: ['ubuntu-latest'],
    ...overrides,
  };
}

interface FakeLogOptions {
  status?: number;
  contentLength?: number;
}

/** A store serving `chunks` for every fetch, one chunk per read. */
function stubStore(chunks: string[], opts: FakeLogOptions = {}) {
  const encoder = new TextEncoder();
  const total =
    opts.contentLength ??
    chunks.reduce((n, c) => n + encoder.encode(c).byteLength, 0);
  const fetchImpl = vi.fn(() =>
    Promise.resolve({
      ok: (opts.status ?? 200) < 400,
      status: opts.status ?? 200,
      statusText: 'Test',
      headers: {
        get: (name: string) =>
          name.toLowerCase() === 'content-length' ? String(total) : null,
      },
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
          controller.close();
        },
      }),
      arrayBuffer: () =>
        Promise.resolve(encoder.encode(chunks.join('')).buffer),
    } as unknown as Response)
  );
  vi.stubGlobal('fetch', fetchImpl);
  return fetchImpl;
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path=":owner/:repo" element={<Outlet context={CONTEXT} />}>
          <Route path="actions/:runId" element={<RunDetailPage />} />
          <Route
            path="actions/:runId/jobs/:jobId"
            element={<JobDetailPage />}
          />
        </Route>
      </Routes>
    </MemoryRouter>
  );
}

const JOB_PATH = '/npub1owner/demo/actions/run-1/jobs/build';

describe('[P1] JobDetailPage (rig#190)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders one job: its identity, its state and its durable job log', async () => {
    const fetchImpl = stubStore(['npm run build\n', 'error: it broke\n']);
    mockUseCiRun.mockReturnValue({
      run: run(),
      jobs: [job()],
      loading: false,
      error: null,
    });
    renderAt(JOB_PATH);

    expect(screen.getByRole('heading', { name: 'Build' })).toBeInTheDocument();
    expect(screen.getByText('build')).toBeInTheDocument();
    expect(screen.getByText('failure')).toBeInTheDocument();
    expect(screen.getByText(/exit code 1/)).toBeInTheDocument();
    expect(screen.getByText(/on ubuntu-latest/)).toBeInTheDocument();
    // The log comes from the Job Result's logs URL, not from the event tail.
    expect(await screen.findByText(/npm run build/)).toBeInTheDocument();
    expect(fetchImpl).toHaveBeenCalledWith(LOGS_URL, expect.anything());
    expect(screen.getByRole('link', { name: /full log/i })).toHaveAttribute(
      'href',
      LOGS_URL
    );
    expect(screen.queryByTestId('job-log-truncated')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'ci' })).toHaveAttribute(
      'href',
      '/npub1owner/demo/actions/run-1'
    );
  });

  it('stops at its own ceiling on an enormous log and says so, and by how much', async () => {
    const chunk = 'x'.repeat(512 * 1024);
    const declared = 9856614; // 9.4 MiB, far past what the page will read
    stubStore([chunk, chunk, chunk, chunk, chunk], {
      contentLength: declared,
    });
    mockUseCiRun.mockReturnValue({
      run: run(),
      jobs: [job()],
      loading: false,
      error: null,
    });
    renderAt(JOB_PATH);

    const notice = await screen.findByTestId('job-log-truncated');
    expect(notice).toHaveTextContent('Showing the first 2 MiB');
    expect(notice).toHaveTextContent('9.4 MiB job log');
    expect(notice).toHaveTextContent('7.4 MiB is not shown');
    // And the ceiling really did bound what the page holds.
    const pre = document.querySelector('pre');
    expect(pre?.textContent?.length).toBe(JOB_LOG_CEILING_BYTES);
  });

  it('renders a job with no logs URL as a job without a log, not an error', async () => {
    const fetchImpl = stubStore(['never fetched']);
    mockUseCiRun.mockReturnValue({
      run: run(),
      jobs: [job({ logsUrl: undefined })],
      loading: false,
      error: null,
    });
    renderAt(JOB_PATH);

    expect(
      await screen.findByText(/No job log was uploaded for this job/)
    ).toBeInTheDocument();
    // The Job Result's own excerpt is all there is — and what precedes it is named.
    expect(screen.getByText(/error: it broke/)).toBeInTheDocument();
    expect(screen.getByText(/4 KiB\s+of earlier output/)).toBeInTheDocument();
    expect(screen.queryByText(/Could not read the job log/)).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('says the store refused and falls back to the excerpt', async () => {
    stubStore([''], { status: 404 });
    mockUseCiRun.mockReturnValue({
      run: run(),
      jobs: [job()],
      loading: false,
      error: null,
    });
    renderAt(JOB_PATH);

    expect(
      await screen.findByText(/Could not read the job log from the store/)
    ).toBeInTheDocument();
    expect(screen.getByText(/error: it broke/)).toBeInTheDocument();
  });

  it('a running job says it is running and fetches nothing', () => {
    const fetchImpl = stubStore(['unused']);
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
    renderAt(JOB_PATH);

    expect(screen.getByText('in progress')).toBeInTheDocument();
    expect(screen.getByText(/This job is running/)).toBeInTheDocument();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('a job of a queued run has not started, and says that rather than showing an empty pane', () => {
    mockUseCiRun.mockReturnValue({
      run: run({
        status: 'queued',
        conclusion: undefined,
        inProgress: ['build', 'test'],
        jobs: [],
      }),
      jobs: [],
      loading: false,
      error: null,
    });
    renderAt(JOB_PATH);

    expect(screen.getByText('not started')).toBeInTheDocument();
    expect(screen.getByText(/has not started yet/)).toBeInTheDocument();
  });

  it('a job whose result has not arrived yet is concluded, waiting for its event', () => {
    mockUseCiRun.mockReturnValue({
      run: run(),
      jobs: [],
      loading: false,
      error: null,
    });
    renderAt(JOB_PATH);

    expect(screen.getByText('concluded')).toBeInTheDocument();
    expect(screen.getByText(/waiting for its job result/)).toBeInTheDocument();
  });

  it('says so when the run has no such job', () => {
    mockUseCiRun.mockReturnValue({
      run: run({ jobs: [] }),
      jobs: [],
      loading: false,
      error: null,
    });
    renderAt('/npub1owner/demo/actions/run-1/jobs/nope');

    expect(screen.getByText(/has no job called/)).toBeInTheDocument();
  });

  it('says so when the run itself is unknown', () => {
    mockUseCiRun.mockReturnValue({
      run: null,
      jobs: [],
      loading: false,
      error: null,
    });
    renderAt(JOB_PATH);

    expect(screen.getByText('Run not found.')).toBeInTheDocument();
  });

  it('re-points a testnet-gateway log to the preferred gateway for the link and the read', async () => {
    const fetchImpl = stubStore(['compiled']);
    mockUseCiRun.mockReturnValue({
      run: run(),
      jobs: [job({ logsUrl: 'https://ar-io.dev/raw/tx-log' })],
      loading: false,
      error: null,
    });
    renderAt(JOB_PATH);

    expect(await screen.findByText('compiled')).toBeInTheDocument();
    expect(fetchImpl).toHaveBeenCalledWith(
      `${PREFERRED_GATEWAY}/raw/tx-log`,
      expect.anything()
    );
    expect(screen.getByRole('link', { name: /full log/i })).toHaveAttribute(
      'href',
      `${PREFERRED_GATEWAY}/raw/tx-log`
    );
  });
});
