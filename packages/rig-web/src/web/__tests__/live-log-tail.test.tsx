/**
 * The live log tail on screen (rig#194, ADR-0002).
 *
 * These tests assert what a viewer sees and what the coordinator is asked
 * for: a job page renders its own job's tail and updates as replacements
 * arrive; a run that has no live event renders as a perfectly normal run;
 * and browsing the run list opens no live tail subscription at all. The
 * relay is faked at `subscribeRelay`, so the real hooks build the real
 * filters and the test can push replacements the way a relay would.
 */
import { act, cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RepoContext } from '@/app/repo-layout';
import type { NostrEvent, NostrFilter } from '../nip34-parsers.js';
import type { CiJobResult, CiRun } from '../nip-c1-parsers.js';
import type * as RelayClient from '../relay-client.js';
import type * as CiRunsModule from '@/hooks/use-ci-runs';

interface FakeSubscription {
  filter: NostrFilter;
  onEvent: (event: NostrEvent) => void;
  onEose: () => void;
  closed: boolean;
}

const relay = vi.hoisted(() => ({ subs: [] as FakeSubscription[] }));

vi.mock('../relay-client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof RelayClient>();
  return {
    ...actual,
    queryRelay: () => Promise.resolve([]),
    subscribeRelay: (
      _url: string,
      filter: NostrFilter,
      onEvent: (event: NostrEvent) => void,
      onEose: () => void
    ) => {
      const sub: FakeSubscription = {
        filter,
        onEvent,
        onEose,
        closed: false,
      };
      relay.subs.push(sub);
      return {
        close: () => {
          sub.closed = true;
        },
      };
    },
  };
});

vi.mock('@/hooks/use-ci-runs', async (importOriginal) => ({
  // The run list's own hook stays REAL: a test that mocks it away cannot
  // show what the list asks the relay for.
  ...(await importOriginal<typeof CiRunsModule>()),
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
import { JobDetailPage } from '@/app/pages/job-detail-page';
import { RunDetailPage } from '@/app/pages/run-detail-page';
import { useCiRun } from '@/hooks/use-ci-runs';
import { CI_LIVE_LOG_TAIL_KIND } from '../nip-c1-parsers.js';

const mockUseCiRun = vi.mocked(useCiRun);

const OWNER_HEX = 'ab'.repeat(32);
const COORD = '12'.repeat(32);
const COMMIT = '9a'.repeat(20);
const RUN_ID = 'run-1';
const CREATED = 1_700_000_100;

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
  owner: OWNER_HEX,
  repo: 'demo',
};

function run(overrides: Partial<CiRun> = {}): CiRun {
  return {
    runId: RUN_ID,
    coordinator: COORD,
    trigger: {
      repoAddr: `30617:${OWNER_HEX}:demo`,
      commit: COMMIT,
      workflow: { path: '.github/workflows/ci.yml', sha256: 'f0'.repeat(32) },
      reason: 'push',
      ref: 'refs/heads/main',
    },
    status: 'in_progress',
    inProgress: ['build', 'test'],
    createdAt: 1_700_000_000,
    startedAt: 1_700_000_010,
    jobs: [],
    trust: 'maintainer-directed',
    current: true,
    ...overrides,
  };
}

function concludedJob(): CiJobResult {
  return {
    eventId: '88'.repeat(32),
    pubkey: COORD,
    createdAt: 1_700_000_200,
    trigger: run().trigger,
    progressAddress: `39842:${COORD}:${RUN_ID}`,
    coordinator: COORD,
    runId: RUN_ID,
    jobId: 'build',
    name: 'Build',
    conclusion: 'success',
    logsUrl: 'http://localhost:3000/raw/tx-log',
    logTail: 'the excerpt on the event',
    logOmittedBytes: 0,
    artifacts: [],
    startedAt: 1_700_000_010,
    exitCode: 0,
    runsOn: [],
  };
}

interface TailBody {
  jobs: { job: string; tail: string; omitted?: number }[];
  runner?: { tail: string; omitted?: number };
}

let eventCounter = 0;
function tailEvent(body: TailBody, createdAt = CREATED): NostrEvent {
  eventCounter += 1;
  return {
    id: eventCounter.toString(16).padStart(64, '0'),
    pubkey: COORD,
    created_at: createdAt,
    kind: CI_LIVE_LOG_TAIL_KIND,
    tags: [
      ['a', `30617:${OWNER_HEX}:demo`],
      ['c', COMMIT],
      ['w', '.github/workflows/ci.yml', 'f0'.repeat(32)],
      ['o', 'push'],
      ['r', 'refs/heads/main'],
      ['d', RUN_ID],
      ['expiration', String(createdAt + 600)],
    ],
    content: JSON.stringify(body),
    sig: 'f0'.repeat(64),
  };
}

/** Every live tail subscription this render opened, in order. */
function tailSubs(): FakeSubscription[] {
  return relay.subs.filter((s) => s.filter.kinds?.includes(39841));
}

/** Deliver a replacement the way a relay pushes one, mid-render. */
function publish(event: NostrEvent) {
  act(() => {
    for (const sub of tailSubs()) {
      if (!sub.closed) sub.onEvent(event);
    }
  });
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path=":owner/:repo" element={<Outlet context={CONTEXT} />}>
          <Route path="actions" element={<ActionsPage />} />
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

const BUILD_PATH = `/${OWNER_HEX}/demo/actions/${RUN_ID}/jobs/build`;
const TEST_PATH = `/${OWNER_HEX}/demo/actions/${RUN_ID}/jobs/test`;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

beforeEach(() => {
  relay.subs.length = 0;
  vi.clearAllMocks();
});

describe('[P1] the job page renders the live tail (rig#194)', () => {
  it('subscribes to this run alone and renders this job’s tail, not another job’s', () => {
    mockUseCiRun.mockReturnValue({
      run: run(),
      jobs: [],
      loading: false,
      error: null,
    });
    renderAt(BUILD_PATH);

    // Scoped to the run being viewed: one addressable event, by its address.
    expect(tailSubs()).toHaveLength(1);
    expect(tailSubs()[0]?.filter).toMatchObject({
      kinds: [39841],
      authors: [COORD],
      '#d': [RUN_ID],
    });

    publish(
      tailEvent({
        jobs: [
          { job: 'build', tail: 'cc -c shard-3.c', omitted: 132096 },
          { job: 'test', tail: 'vitest: 12 passed' },
        ],
      })
    );

    expect(screen.getByText(/cc -c shard-3\.c/)).toBeInTheDocument();
    expect(screen.queryByText(/vitest: 12 passed/)).toBeNull();
    // A late arrival is told what it is looking at the end of.
    expect(screen.getByText(/129 KiB of earlier output/)).toBeInTheDocument();
  });

  it('follows the run: a replacement re-renders the pane, with no reload', () => {
    mockUseCiRun.mockReturnValue({
      run: run(),
      jobs: [],
      loading: false,
      error: null,
    });
    renderAt(BUILD_PATH);

    publish(tailEvent({ jobs: [{ job: 'build', tail: 'step 1 of 3' }] }));
    expect(screen.getByText(/step 1 of 3/)).toBeInTheDocument();

    publish(
      tailEvent({ jobs: [{ job: 'build', tail: 'step 3 of 3' }] }, CREATED + 10)
    );
    expect(screen.getByText(/step 3 of 3/)).toBeInTheDocument();
    expect(screen.queryByText(/step 1 of 3/)).toBeNull();
  });

  it('says plainly that the live view is a rolling tail and the job log is the record', () => {
    mockUseCiRun.mockReturnValue({
      run: run(),
      jobs: [],
      loading: false,
      error: null,
    });
    renderAt(BUILD_PATH);
    publish(tailEvent({ jobs: [{ job: 'build', tail: 'building' }] }));

    const pane = screen.getByTestId('live-job-tail');
    expect(pane).toHaveTextContent(/rolling live view/i);
    expect(pane).toHaveTextContent(/not the record/i);
    expect(pane).toHaveTextContent(
      /Output that scrolled past between refreshes is not shown here/i
    );
    expect(pane).toHaveTextContent(/job log published when the run concludes/i);
  });

  it('a job of a running run that has printed nothing is pending, not an error', () => {
    mockUseCiRun.mockReturnValue({
      run: run(),
      jobs: [],
      loading: false,
      error: null,
    });
    renderAt(TEST_PATH);
    publish(tailEvent({ jobs: [{ job: 'build', tail: 'building' }] }));

    expect(screen.getByText('not started')).toBeInTheDocument();
    expect(screen.getByText(/has not started yet/)).toBeInTheDocument();
    expect(screen.queryByTestId('live-job-tail')).toBeNull();
    expect(screen.queryByText(/failed/i)).toBeNull();
  });

  it('shows the runner channel as the runner talking, never as a job', () => {
    mockUseCiRun.mockReturnValue({
      run: run(),
      jobs: [],
      loading: false,
      error: null,
    });
    renderAt(BUILD_PATH);
    publish(
      tailEvent({
        jobs: [{ job: 'build', tail: 'building' }],
        runner: { tail: 'Error response from daemon: pull access denied' },
      })
    );

    const runner = screen.getByTestId('runner-channel');
    expect(runner).toHaveTextContent('pull access denied');
    expect(runner).toHaveTextContent(/not a job/i);
    // Not a job: no job state badge of its own, and no job id on screen.
    expect(runner.querySelector('[data-job-state]')).toBeNull();
    expect(screen.queryByText('~runner')).toBeNull();
  });

  it('a run with no live tail event renders as a normal running job', () => {
    mockUseCiRun.mockReturnValue({
      run: run(),
      jobs: [],
      loading: false,
      error: null,
    });
    renderAt(BUILD_PATH);
    // The relay answers with nothing at all — an old coordinator, or an
    // event that has expired. Absence is never an error state.
    act(() => {
      for (const sub of tailSubs()) sub.onEose();
    });

    expect(screen.getByText('in progress')).toBeInTheDocument();
    expect(screen.getByText(/This job is running/)).toBeInTheDocument();
    expect(screen.queryByTestId('live-job-tail')).toBeNull();
    expect(screen.queryByText(/Failed to load/)).toBeNull();
  });

  it('a concluded run converges on the durable job log and asks for no tail', async () => {
    const encoder = new TextEncoder();
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          statusText: 'OK',
          headers: { get: () => '17' },
          body: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(encoder.encode('the durable record'));
              controller.close();
            },
          }),
        } as unknown as Response)
      )
    );
    mockUseCiRun.mockReturnValue({
      run: run({
        status: 'concluded',
        conclusion: 'success',
        inProgress: [],
        jobs: [
          {
            eventId: '88'.repeat(32),
            relayUrl: '',
            pubkey: COORD,
            jobId: 'build',
          },
        ],
      }),
      jobs: [concludedJob()],
      loading: false,
      error: null,
    });
    renderAt(BUILD_PATH);

    // The run is over: the record is on the store, so nothing subscribes to
    // a view of it, and the live pane cannot disagree with the record.
    expect(tailSubs()).toHaveLength(0);
    expect(await screen.findByText(/the durable record/)).toBeInTheDocument();
    expect(screen.queryByTestId('live-job-tail')).toBeNull();
  });

  it('drops the subscription when the viewer leaves the job page', () => {
    mockUseCiRun.mockReturnValue({
      run: run(),
      jobs: [],
      loading: false,
      error: null,
    });
    const view = renderAt(BUILD_PATH);
    expect(tailSubs()).toHaveLength(1);
    view.unmount();
    expect(tailSubs().every((s) => s.closed)).toBe(true);
  });
});

describe('[P1] browsing the run list pulls no log bytes (rig#194)', () => {
  it('opens no live tail subscription for the repo’s runs', () => {
    renderAt(`/${OWNER_HEX}/demo/actions`);

    // The list does subscribe — to run state, which is cheap and flat.
    expect(relay.subs.length).toBeGreaterThan(0);
    for (const sub of relay.subs) {
      expect(sub.filter.kinds ?? []).not.toContain(39841);
    }
    expect(tailSubs()).toHaveLength(0);
  });
});
