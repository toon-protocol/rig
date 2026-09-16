/**
 * `rig ci status <commit>` tests (#125): the free merge gate against a mock
 * relay — run/job assembly from kind:9842/39842/9841, latest-attempt-wins per
 * (coordinator, workflow), trust derivation from kind:30617 maintainers and
 * kind:9843/9844 history, every exit-code branch, `--require-ci-trust`
 * dropping an unknown coordinator's green run, `--workflow`, local revision
 * resolution, and the strict `--json` envelope.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NostrEvent } from '../remote-state.js';
import { hexToNpub } from '../npub.js';
import type { UnsignedEvent } from '../nip34-events.js';
import {
  buildCiJobResult,
  buildCiServiceRequest,
  buildCiServiceStop,
  buildCiWorkflowProgress,
  buildCiWorkflowResult,
  type CiConclusion,
  type CiProvenance,
  type CiTriggerContext,
} from '../ci/nip-c1-events.js';
import type { CliIo } from './output.js';
import { dispatch, type DispatchDeps } from './dispatch.js';
import { writeToonConfig } from './git-config.js';
import { filterEvents, makeMockRelayFactory } from './read-testkit.js';
import { assembleCiStatus, type CiStatusReport } from './ci-status.js';

const OWNER = 'ab'.repeat(32);
const MAINTAINER = 'bc'.repeat(32);
const STRANGER = 'dd'.repeat(32);
const COORD = 'cd'.repeat(32); // the maintainers' coordinator
const ROGUE = 'ee'.repeat(32); // a coordinator nobody asked for
const RELAY = 'wss://relay.test.example';
const REPO = 'demo';
const A = `30617:${OWNER}:${REPO}`;
const COMMIT = '1a'.repeat(20);
const OTHER_COMMIT = '2b'.repeat(20);
const WF = { path: '.github/workflows/ci.yml', sha256: '3c'.repeat(32) };
const WF2 = { path: '.github/workflows/lint.yml', sha256: '4d'.repeat(32) };
const REQ_ID = '11'.repeat(32);
const T0 = 1_800_000_000;

let counter = 0;
function signed(
  unsigned: UnsignedEvent,
  pubkey: string,
  id?: string
): NostrEvent {
  counter += 1;
  return {
    id: id ?? counter.toString(16).padStart(64, '0'),
    pubkey,
    sig: 'f0'.repeat(64),
    ...unsigned,
  };
}

function trigger(overrides: Partial<CiTriggerContext> = {}): CiTriggerContext {
  return {
    repoAddr: A,
    commit: COMMIT,
    workflow: WF,
    reason: 'push',
    ref: 'refs/heads/main',
    ...overrides,
  };
}

const REQ_PROVENANCE: CiProvenance = {
  kind: 'service-request',
  eventId: REQ_ID,
  relayUrl: RELAY,
  pubkey: OWNER,
};

function announcement(maintainers: string[] = []): NostrEvent {
  return {
    id: '30'.repeat(32),
    pubkey: OWNER,
    created_at: 1000,
    kind: 30617,
    tags: [
      ['d', REPO],
      ['name', 'Demo'],
      ...(maintainers.length ? [['maintainers', ...maintainers]] : []),
    ],
    content: '',
    sig: '0'.repeat(128),
  };
}

function serviceRequest(
  from = OWNER,
  coordinator = COORD,
  createdAt = T0 - 100,
  id = REQ_ID
): NostrEvent {
  return signed(
    buildCiServiceRequest(A, coordinator, RELAY, createdAt),
    from,
    id
  );
}

function result(opts: {
  coordinator?: string;
  conclusion?: CiConclusion;
  createdAt?: number;
  runId?: string;
  trig?: Partial<CiTriggerContext>;
  provenance?: CiProvenance | null;
  jobs?: { eventId: string; jobId: string }[];
}): NostrEvent {
  const coordinator = opts.coordinator ?? COORD;
  const provenance =
    opts.provenance === null ? undefined : (opts.provenance ?? REQ_PROVENANCE);
  return signed(
    buildCiWorkflowResult(
      {
        trigger: trigger(opts.trig),
        runId: opts.runId ?? `run-${counter}`,
        conclusion: opts.conclusion ?? 'success',
        queuedAt: (opts.createdAt ?? T0) - 30,
        startedAt: (opts.createdAt ?? T0) - 20,
        ...(provenance ? { provenance } : {}),
        jobs: (opts.jobs ?? []).map((j) => ({
          ...j,
          relayUrl: RELAY,
          pubkey: coordinator,
        })),
      },
      opts.createdAt ?? T0
    ),
    coordinator
  );
}

function progress(opts: {
  status: 'queued' | 'in_progress';
  runId: string;
  createdAt?: number;
  coordinator?: string;
}): NostrEvent {
  return signed(
    buildCiWorkflowProgress(
      {
        trigger: trigger(),
        runId: opts.runId,
        status: opts.status,
        ...(opts.status === 'queued'
          ? { queue: 1 }
          : { inProgress: ['build'], provenance: REQ_PROVENANCE }),
        queuedAt: (opts.createdAt ?? T0) - 5,
        expiresAt: (opts.createdAt ?? T0) + 600,
        jobs: [],
      },
      opts.createdAt ?? T0
    ),
    opts.coordinator ?? COORD
  );
}

function job(opts: {
  runId: string;
  jobId: string;
  conclusion?: CiConclusion;
  coordinator?: string;
  id?: string;
}): NostrEvent {
  const coordinator = opts.coordinator ?? COORD;
  return signed(
    buildCiJobResult(
      {
        trigger: trigger(),
        progressAddress: `39842:${coordinator}:${opts.runId}`,
        relayUrl: RELAY,
        jobId: opts.jobId,
        name: `Job ${opts.jobId}`,
        conclusion: opts.conclusion ?? 'success',
        logsUrl: `http://localhost:3000/raw/tx-${opts.jobId}`,
        logTail: 'ok\n',
        logOmittedBytes: 0,
        queuedAt: T0 - 25,
        startedAt: T0 - 20,
        exitCode: opts.conclusion === 'failure' ? 1 : 0,
      },
      T0 - 1
    ),
    coordinator,
    opts.id
  );
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'F',
      GIT_AUTHOR_EMAIL: 'f@t',
      GIT_COMMITTER_NAME: 'F',
      GIT_COMMITTER_EMAIL: 'f@t',
    },
  }).trim();
}

interface Harness {
  deps: DispatchDeps;
  out: string[];
  err: string[];
  json: unknown[];
}

function makeHarness(
  events: NostrEvent[],
  cwd = '/nonexistent-not-a-repo',
  env: NodeJS.ProcessEnv = {}
): Harness {
  const out: string[] = [];
  const err: string[] = [];
  const json: unknown[] = [];
  const io: CliIo = {
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    emitJson: (payload) => json.push(payload),
    isInteractive: false,
    confirm: async () => false,
  };
  return {
    deps: {
      io,
      env,
      cwd,
      webSocketFactory: makeMockRelayFactory((filter) =>
        filterEvents(events, filter)
      ),
      loadStandalone: async () => {
        throw new Error(
          'ci status is free — the standalone loader must never be called'
        );
      },
    },
    out,
    err,
    json,
  };
}

const ADDR = ['--repo-id', REPO, '--owner', OWNER, '--relay', RELAY];

async function status(
  events: NostrEvent[],
  extra: string[] = [],
  cwd?: string
): Promise<{ code: number; report: CiStatusReport; h: Harness }> {
  const h = makeHarness(events, cwd);
  const code = await dispatch(
    ['ci', 'status', COMMIT, ...ADDR, '--json', ...extra],
    h.deps
  );
  expect(h.json).toHaveLength(1);
  return { code, report: h.json[0] as CiStatusReport, h };
}

beforeEach(() => {
  counter = 0;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('rig ci status — assembly + verdict', () => {
  it('is GREEN (exit 0) for a concluded success from a maintainer-directed coordinator, with its jobs attached', async () => {
    const jobBuild = job({ runId: 'r1', jobId: 'build', id: 'a1'.repeat(32) });
    const jobTest = job({ runId: 'r1', jobId: 'test', id: 'a2'.repeat(32) });
    const events = [
      announcement([MAINTAINER]),
      serviceRequest(),
      progress({ status: 'in_progress', runId: 'r1', createdAt: T0 - 10 }),
      jobBuild,
      jobTest,
      result({
        runId: 'r1',
        jobs: [
          { eventId: jobBuild.id, jobId: 'build' },
          { eventId: jobTest.id, jobId: 'test' },
        ],
      }),
      // Noise: another commit's run must not count.
      result({
        runId: 'other',
        trig: { commit: OTHER_COMMIT },
        conclusion: 'failure',
      }),
    ];
    const { code, report } = await status(events);
    expect(code).toBe(0);
    expect(report).toMatchObject({
      command: 'ci status',
      commit: COMMIT,
      repo: { owner: OWNER, repoId: REPO },
      relays: [RELAY],
      requiredTrust: null,
      ok: true,
      summary: { counted: 1, green: 1, red: 0, pending: 0 },
    });
    expect(report.runs).toHaveLength(1);
    const run = report.runs[0] as CiStatusReport['runs'][0];
    expect(run).toMatchObject({
      runId: 'r1',
      coordinator: COORD,
      workflow: WF,
      reason: 'push',
      status: 'concluded',
      conclusion: 'success',
      trust: 'maintainer-directed',
      createdAt: T0,
      startedAt: T0 - 20,
      queuedAt: T0 - 30,
      provenance: REQ_PROVENANCE,
    });
    expect(run.jobs.map((j) => j.jobId)).toEqual(['build', 'test']);
    expect(run.jobs[0]).toMatchObject({
      name: 'Job build',
      conclusion: 'success',
      logsUrl: 'http://localhost:3000/raw/tx-build',
      exitCode: 0,
      publisher: COORD,
      eventId: jobBuild.id,
    });
    expect(report.reason).toBeUndefined();
  });

  it('is RED (exit 1) when the counted run concluded failure', async () => {
    const { code, report } = await status([
      announcement(),
      serviceRequest(),
      result({ conclusion: 'failure' }),
    ]);
    expect(code).toBe(1);
    expect(report.ok).toBe(false);
    expect(report.summary).toEqual({
      counted: 1,
      green: 0,
      red: 1,
      pending: 0,
    });
    expect(report.reason).toContain('1 run(s) concluded red');
  });

  it('is NOT green (exit 1) while the only run is still in progress — no accidental pass', async () => {
    const { code, report } = await status([
      announcement(),
      serviceRequest(),
      progress({ status: 'in_progress', runId: 'r1' }),
    ]);
    expect(code).toBe(1);
    expect(report.runs[0]).toMatchObject({
      status: 'in_progress',
      trust: 'maintainer-directed',
    });
    expect(report.runs[0]?.conclusion).toBeUndefined();
    expect(report.summary).toEqual({
      counted: 1,
      green: 0,
      red: 0,
      pending: 1,
    });
    expect(report.reason).toContain('not concluded');
  });

  it('exit 1 with "no CI runs found" when the relay holds nothing for the commit', async () => {
    const { code, report } = await status([announcement()]);
    expect(code).toBe(1);
    expect(report.runs).toEqual([]);
    expect(report.summary).toEqual({
      counted: 0,
      green: 0,
      red: 0,
      pending: 0,
    });
    expect(report.reason).toBe('no CI runs found for this commit');
  });

  it('only the LATEST attempt per (coordinator, workflow) counts; older attempts are still listed', async () => {
    const events = [
      announcement(),
      serviceRequest(),
      result({ runId: 'old', conclusion: 'failure', createdAt: T0 - 500 }),
      result({ runId: 'new', conclusion: 'success', createdAt: T0 }),
      result({
        runId: 'lint',
        trig: { workflow: WF2 },
        conclusion: 'neutral',
        createdAt: T0 - 100,
      }),
    ];
    const { code, report } = await status(events);
    expect(code).toBe(0);
    expect(report.runs.map((r) => r.runId)).toEqual(['new', 'lint', 'old']); // newest first
    expect(report.summary).toEqual({
      counted: 2,
      green: 2,
      red: 0,
      pending: 0,
    });
  });

  it('a 9842 supersedes the run’s 39842 progress; a concluded 39842 alone also concludes', async () => {
    const events = [
      announcement(),
      serviceRequest(),
      progress({ status: 'queued', runId: 'r1', createdAt: T0 - 50 }),
      result({ runId: 'r1', createdAt: T0 }),
    ];
    const { code, report } = await status(events);
    expect(code).toBe(0);
    expect(report.runs).toHaveLength(1);
    expect(report.runs[0]).toMatchObject({
      status: 'concluded',
      conclusion: 'success',
    });
  });

  it('--require-ci-trust maintainer-directed drops an unknown coordinator’s green run (exit 1)', async () => {
    const rogueGreen = result({
      coordinator: ROGUE,
      provenance: null,
      runId: 'rogue',
    });
    const { code: withoutGate, report: r1 } = await status([
      announcement(),
      rogueGreen,
    ]);
    // Without a trust requirement the relay is taken at face value…
    expect(withoutGate).toBe(0);
    expect(r1.runs[0]).toMatchObject({
      trust: 'no-known-context',
      coordinator: ROGUE,
    });
    // …but a gate that demands maintainer direction ignores it.
    const { code, report } = await status(
      [announcement(), rogueGreen],
      ['--require-ci-trust', 'maintainer-directed']
    );
    expect(code).toBe(1);
    expect(report.requiredTrust).toBe('maintainer-directed');
    expect(report.runs).toHaveLength(1); // still listed for humans
    expect(report.summary.counted).toBe(0);
    expect(report.reason).toBe('no run meets the workflow/trust requirement');
  });

  it('derives every trust level from the 30617 maintainers + 9843/9844 history', async () => {
    const stopId = '22'.repeat(32);
    const events = [
      announcement([MAINTAINER]),
      // COORD: maintainer-directed via the quoted request.
      serviceRequest(MAINTAINER, COORD, T0 - 100, REQ_ID),
      result({
        runId: 'directed',
        provenance: { ...REQ_PROVENANCE, pubkey: MAINTAINER },
        createdAt: T0,
      }),
      // COORD again, no quote on the run but a standing request → operationally-associated.
      result({
        runId: 'assoc',
        trig: { workflow: WF2 },
        provenance: null,
        createdAt: T0,
      }),
      // ROGUE: a stranger requested it → seen-in-network.
      signed(
        buildCiServiceRequest(A, ROGUE, RELAY, T0 - 100),
        STRANGER,
        '33'.repeat(32)
      ),
      result({
        coordinator: ROGUE,
        runId: 'seen',
        provenance: null,
        createdAt: T0,
      }),
      // A coordinator that was stopped by the owner before the run: its
      // request no longer stands → falls to seen-in-network (a request exists).
      signed(
        buildCiServiceRequest(A, 'ff'.repeat(32), RELAY, T0 - 200),
        OWNER,
        '44'.repeat(32)
      ),
      signed(
        buildCiServiceStop(A, 'ff'.repeat(32), RELAY, T0 - 150),
        OWNER,
        stopId
      ),
      result({
        coordinator: 'ff'.repeat(32),
        runId: 'stopped',
        provenance: null,
        createdAt: T0,
      }),
    ];
    const { report } = await status(events);
    const trust = Object.fromEntries(
      report.runs.map((r) => [r.runId, r.trust])
    );
    expect(trust).toEqual({
      directed: 'maintainer-directed',
      assoc: 'operationally-associated',
      seen: 'seen-in-network',
      stopped: 'seen-in-network',
    });
    // Gate at operationally-associated: directed + assoc count, both green.
    const gated = await status(events, [
      '--require-ci-trust',
      'operationally-associated',
    ]);
    expect(gated.code).toBe(0);
    expect(gated.report.summary.counted).toBe(2);
  });

  it('--workflow narrows the gate to one workflow file', async () => {
    const events = [
      announcement(),
      serviceRequest(),
      result({ runId: 'ci', conclusion: 'failure' }),
      result({ runId: 'lint', trig: { workflow: WF2 }, conclusion: 'success' }),
    ];
    expect((await status(events)).code).toBe(1);
    const { code, report } = await status(events, [
      '--workflow',
      './.github/workflows/lint.yml',
    ]);
    expect(code).toBe(0);
    expect(report.summary).toEqual({
      counted: 1,
      green: 1,
      red: 0,
      pending: 0,
    });
  });

  it('rejects a bad --require-ci-trust level and a missing <commit> with exit 2', async () => {
    const h = makeHarness([]);
    expect(
      await dispatch(
        ['ci', 'status', COMMIT, ...ADDR, '--require-ci-trust', 'verified'],
        h.deps
      )
    ).toBe(2);
    expect(h.err.join('\n')).toContain('--require-ci-trust must be one of');
    expect(await dispatch(['ci', 'status', ...ADDR], h.deps)).toBe(2);
    expect(
      await dispatch(['ci', 'status', COMMIT, OTHER_COMMIT, ...ADDR], h.deps)
    ).toBe(2);
  });

  it('outside a repo, <commit> must be a full sha (error envelope, exit 1); inside, any revision resolves', async () => {
    const h = makeHarness([]);
    expect(
      await dispatch(['ci', 'status', 'HEAD', ...ADDR, '--json'], h.deps)
    ).toBe(1);
    expect(h.json[0]).toMatchObject({ command: 'ci status', error: 'error' });
    expect(String((h.json[0] as { detail: string }).detail)).toContain(
      'full 40-hex SHA'
    );

    const dir = mkdtempSync(join(tmpdir(), 'toon-rig-ci-status-'));
    try {
      git(['init', '--initial-branch=main'], dir);
      writeFileSync(join(dir, 'README.md'), '# demo\n');
      git(['add', '.'], dir);
      git(['commit', '-m', 'first'], dir);
      const head = git(['rev-parse', 'HEAD'], dir);
      await writeToonConfig(dir, { repoId: REPO, owner: OWNER });
      git(['remote', 'add', 'origin', RELAY], dir);
      const events = [
        announcement(),
        serviceRequest(),
        result({ trig: { commit: head } }),
      ];
      const inRepo = makeHarness(events, dir);
      // No address flags: repo id/owner/relay all come from the git config + origin.
      expect(
        await dispatch(['ci', 'status', 'HEAD', '--json'], inRepo.deps)
      ).toBe(0);
      expect(inRepo.json[0]).toMatchObject({
        commit: head,
        ok: true,
        relays: [RELAY],
      });
      const short = makeHarness(events, dir);
      expect(
        await dispatch(['ci', 'status', head.slice(0, 7), '--json'], short.deps)
      ).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('renders human lines: one per run with glyph, workflow, reason, coordinator, trust; jobs; verdict', async () => {
    const j = job({
      runId: 'r1',
      jobId: 'build',
      conclusion: 'failure',
      id: 'a1'.repeat(32),
    });
    const h = makeHarness([
      announcement(),
      serviceRequest(),
      j,
      result({
        runId: 'r1',
        conclusion: 'failure',
        jobs: [{ eventId: j.id, jobId: 'build' }],
      }),
    ]);
    const code = await dispatch(['ci', 'status', COMMIT, ...ADDR], h.deps);
    expect(code).toBe(1);
    expect(h.json).toHaveLength(0);
    const text = h.out.join('\n');
    expect(text).toContain(`CI for ${COMMIT.slice(0, 12)} in ${A}`);
    expect(text).toMatch(
      /✗ failure\s+\.github\/workflows\/ci\.yml\s+push\s+coordinator npub1\S+\s+trust maintainer-directed/
    );
    expect(text).toContain('    failure         Job build (exit 1)');
    expect(text).toContain(
      'NOT GREEN — 1 run(s) concluded red (counted 1: 0 green, 1 red, 0 pending)'
    );
  });

  it('assembleCiStatus ignores malformed / foreign events and never throws on them', () => {
    const garbage: NostrEvent[] = [
      {
        id: '1'.repeat(64),
        pubkey: COORD,
        created_at: T0,
        kind: 9842,
        tags: [['a', A]],
        content: '',
        sig: '',
      },
      {
        id: '2'.repeat(64),
        pubkey: COORD,
        created_at: T0,
        kind: 39842,
        tags: [],
        content: 'x',
        sig: '',
      },
      {
        id: '3'.repeat(64),
        pubkey: COORD,
        created_at: T0,
        kind: 9841,
        tags: [['c', COMMIT]],
        content: '',
        sig: '',
      },
      {
        id: '4'.repeat(64),
        pubkey: OWNER,
        created_at: T0,
        kind: 9843,
        tags: [['p', COORD]],
        content: '',
        sig: '',
      },
      result({ trig: { repoAddr: `30617:${STRANGER}:${REPO}` } }),
    ];
    const out = assembleCiStatus({
      commit: COMMIT,
      ownerPubkey: OWNER,
      repoId: REPO,
      authorized: new Set([OWNER]),
      events: garbage,
    });
    expect(out.runs).toEqual([]);
    expect(out.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// #128 acceptance: the gate under --require-ci-trust with runs REMAINING, a
// failed job, event ids + timings in the envelope, and no identity at all.
// ---------------------------------------------------------------------------

describe('rig ci status — #128 acceptance criteria', () => {
  const STRANGER_TRIGGER: CiProvenance = {
    kind: 'manual-trigger',
    eventId: '55'.repeat(32),
    relayUrl: RELAY,
    pubkey: STRANGER,
  };
  const MAINTAINER_TRIGGER: CiProvenance = {
    kind: 'manual-trigger',
    eventId: '66'.repeat(32),
    relayUrl: RELAY,
    pubkey: MAINTAINER,
  };

  it('--require-ci-trust maintainer-directed hides a run whose trigger came from a non-maintainer; the exit code reflects only the remaining runs', async () => {
    // Same coordinator, two workflows: a stranger's manual trigger produced a
    // RED run, a declared maintainer's manual trigger produced a GREEN one.
    const strangerRun = result({
      runId: 'stranger',
      trig: { workflow: WF2, reason: 'manual' },
      provenance: STRANGER_TRIGGER,
      conclusion: 'failure',
    });
    const maintainerRun = result({
      runId: 'maint',
      trig: { reason: 'manual' },
      provenance: MAINTAINER_TRIGGER,
      conclusion: 'success',
    });
    const events = [announcement([MAINTAINER]), strangerRun, maintainerRun];

    // Without a requirement both count: the stranger's red run fails the gate.
    const ungated = await status(events);
    expect(ungated.code).toBe(1);
    expect(
      Object.fromEntries(ungated.report.runs.map((r) => [r.runId, r.trust]))
    ).toEqual({ stranger: 'no-known-context', maint: 'maintainer-directed' });
    expect(ungated.report.summary).toEqual({
      counted: 2,
      green: 1,
      red: 1,
      pending: 0,
    });

    // With it, the stranger-triggered run is listed but ignored: exit 0 on
    // the strength of the maintainer-directed run alone.
    const gated = await status(events, [
      '--require-ci-trust',
      'maintainer-directed',
    ]);
    expect(gated.code).toBe(0);
    expect(gated.report.requiredTrust).toBe('maintainer-directed');
    expect(gated.report.runs.map((r) => r.runId)).toEqual([
      'stranger',
      'maint',
    ]);
    expect(gated.report.summary).toEqual({
      counted: 1,
      green: 1,
      red: 0,
      pending: 0,
    });
    expect(gated.report.ok).toBe(true);
    expect(gated.report.reason).toBeUndefined();

    // Even when the coordinator itself is authorized (a standing owner
    // request), a stranger's trigger only reaches operationally-associated —
    // still below the requirement, still hidden.
    const authorized = await status(
      [
        announcement([MAINTAINER]),
        serviceRequest(),
        strangerRun,
        maintainerRun,
      ],
      ['--require-ci-trust', 'maintainer-directed']
    );
    expect(authorized.code).toBe(0);
    expect(
      authorized.report.runs.find((r) => r.runId === 'stranger')?.trust
    ).toBe('operationally-associated');
    expect(authorized.report.summary.counted).toBe(1);
  });

  it('a failed job exits 1; the envelope carries every run’s and job’s event id, conclusion and timings', async () => {
    const jobBuild = job({ runId: 'r1', jobId: 'build', id: 'a1'.repeat(32) });
    const jobTest = job({
      runId: 'r1',
      jobId: 'test',
      conclusion: 'failure',
      id: 'a2'.repeat(32),
    });
    const red = result({
      runId: 'r1',
      conclusion: 'failure',
      jobs: [
        { eventId: jobBuild.id, jobId: 'build' },
        { eventId: jobTest.id, jobId: 'test' },
      ],
    });
    const { code, report } = await status([
      announcement(),
      serviceRequest(),
      jobBuild,
      jobTest,
      red,
    ]);
    expect(code).toBe(1);
    expect(report.summary).toEqual({
      counted: 1,
      green: 0,
      red: 1,
      pending: 0,
    });
    const run = report.runs[0] as CiStatusReport['runs'][0];
    expect(run.eventId).toBe(red.id);
    expect(run).toMatchObject({
      conclusion: 'failure',
      queuedAt: T0 - 30,
      startedAt: T0 - 20,
      createdAt: T0,
    });
    expect(run.jobs.map((j) => [j.jobId, j.conclusion, j.eventId])).toEqual([
      ['build', 'success', jobBuild.id],
      ['test', 'failure', jobTest.id],
    ]);
    // Timings: the 9841's queued_at / started_at, and its created_at as the
    // instant the runner published the conclusion.
    expect(run.jobs[1]).toMatchObject({
      exitCode: 1,
      queuedAt: T0 - 25,
      startedAt: T0 - 20,
      concludedAt: T0 - 1,
    });
  });

  it('an in-progress run’s event id is its newest 39842', async () => {
    const queued = progress({
      status: 'queued',
      runId: 'r1',
      createdAt: T0 - 50,
    });
    const running = progress({
      status: 'in_progress',
      runId: 'r1',
      createdAt: T0 - 10,
    });
    const { code, report } = await status([
      announcement(),
      serviceRequest(),
      queued,
      running,
    ]);
    expect(code).toBe(1);
    expect(report.runs).toHaveLength(1);
    expect(report.runs[0]).toMatchObject({
      status: 'in_progress',
      eventId: running.id,
      createdAt: T0 - 10,
    });
  });

  it('works with no identity configured: a bare env, an empty client state dir, and an npub owner', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'toon-rig-ci-status-noid-'));
    try {
      const h = makeHarness(
        [announcement(), serviceRequest(), result({})],
        '/nonexistent-not-a-repo',
        { TOON_CLIENT_HOME: stateDir }
      );
      const code = await dispatch(
        [
          'ci',
          'status',
          COMMIT,
          '--repo-id',
          REPO,
          '--owner',
          hexToNpub(OWNER),
          '--relay',
          RELAY,
          '--json',
        ],
        h.deps
      );
      expect(code).toBe(0);
      expect(h.json).toHaveLength(1);
      expect(h.json[0]).toMatchObject({
        command: 'ci status',
        repo: { owner: OWNER, repoId: REPO },
        ok: true,
      });
      // Nothing was provisioned or read: the state dir is still empty and the
      // standalone (paid) loader was never touched (it throws if it is).
      expect(readdirSync(stateDir)).toEqual([]);
      expect(h.err).toEqual([]);
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it('human output shows each job’s duration and the run’s wall-clock time', async () => {
    const j = job({ runId: 'r1', jobId: 'build', id: 'a1'.repeat(32) });
    const h = makeHarness([
      announcement(),
      serviceRequest(),
      j,
      result({ runId: 'r1', jobs: [{ eventId: j.id, jobId: 'build' }] }),
      // A newer attempt of the same workflow, still running: it is the one
      // that counts (exit 1); r1 is still listed with its timings.
      progress({ status: 'in_progress', runId: 'r2', createdAt: T0 + 5 }),
    ]);
    const code = await dispatch(['ci', 'status', COMMIT, ...ADDR], h.deps);
    expect(code).toBe(1); // r2 is still running
    const text = h.out.join('\n');
    // Run: started T0-20, 9842 at T0 → 20s. Job: started T0-20, 9841 at T0-1 → 19s.
    expect(text).toMatch(
      /✓ success\s+.*trust maintainer-directed {2}took 20s$/m
    );
    expect(text).toContain('    success         Job build (exit 0)  took 19s');
    // A run still in progress has no wall-clock time yet.
    expect(text).toMatch(/… in_progress\s+.*trust maintainer-directed$/m);
  });
});
