/**
 * NIP-C1 (Nostr CI) parser + trust-derivation tests for rig-web (rig#125).
 *
 * Fixture events follow docs/specs/nip-c1.md to the letter; the parsers are
 * a self-contained copy of the ones in @toon-protocol/rig (see the header of
 * nip-c1-parsers.ts for why rig-web does not import them).
 */

import { describe, it, expect } from 'vitest';
import type { NostrEvent } from './nip34-parsers.js';
import {
  CI_JOB_RESULT_KIND,
  CI_SERVICE_REQUEST_KIND,
  CI_SERVICE_STOP_KIND,
  CI_WORKFLOW_PROGRESS_KIND,
  CI_WORKFLOW_RESULT_KIND,
  aggregateRunStatus,
  buildCiRuns,
  controlOrder,
  deriveTrustLevel,
  parseCiJobResult,
  parseCiServiceControl,
  parseCiTriggerContext,
  parseCiWorkflowProgress,
  parseCiWorkflowResult,
  parseRepoAddress,
  repoAddress,
  selectServiceRequests,
  trustAtLeast,
} from './nip-c1-parsers.js';

const OWNER = 'ab'.repeat(32);
const MAINTAINER = 'cd'.repeat(32);
const STRANGER = 'ef'.repeat(32);
const COORD = '12'.repeat(32);
const REPO = 'demo';
const ADDR = `30617:${OWNER}:${REPO}`;
const COMMIT = '9a'.repeat(20);
const TAG_OBJ = '7b'.repeat(20);
const WF_SHA = 'f0'.repeat(32);
const RUN_ID = 'run-0001';
const RELAY = 'wss://relay.test.example';
const AUTHORIZED = new Set([OWNER, MAINTAINER]);

let counter = 0;
function event(
  overrides: Partial<NostrEvent> & { kind: number }
): NostrEvent {
  counter += 1;
  return {
    id: counter.toString(16).padStart(64, '0'),
    pubkey: COORD,
    created_at: 1000 + counter,
    tags: [],
    content: '',
    sig: 'f0'.repeat(64),
    ...overrides,
  };
}

const COMMON_PUSH_TAGS: string[][] = [
  ['a', ADDR],
  ['c', COMMIT],
  ['c', TAG_OBJ],
  ['w', '.github/workflows/ci.yml', WF_SHA],
  ['o', 'push'],
  ['r', 'refs/heads/main'],
];

const PR_ID = '55'.repeat(32);
const PR_UPDATE_ID = '66'.repeat(32);
const COMMON_PR_TAGS: string[][] = [
  ['a', ADDR],
  ['c', COMMIT],
  ['w', '.github/workflows/ci.yml', WF_SHA],
  ['o', 'pull_request'],
  ['E', PR_ID],
  ['K', '1618'],
  ['P', STRANGER],
  ['e', PR_UPDATE_ID],
  ['k', '1619'],
  ['p', STRANGER],
];

describe('repo addresses', () => {
  it('round-trips a 30617 coordinate', () => {
    expect(repoAddress(OWNER, REPO)).toBe(ADDR);
    expect(parseRepoAddress(ADDR)).toEqual({ ownerPubkey: OWNER, repoId: REPO });
  });

  it('rejects non-30617 or malformed coordinates', () => {
    expect(parseRepoAddress(`30618:${OWNER}:${REPO}`)).toBeNull();
    expect(parseRepoAddress('30617:nothex:x')).toBeNull();
    expect(parseRepoAddress('garbage')).toBeNull();
  });
});

describe('parseCiTriggerContext', () => {
  it('parses push context: a/c/w/o/r with extra c as tag ids', () => {
    const ctx = parseCiTriggerContext([...COMMON_PUSH_TAGS, ['r', RUN_ID]]);
    expect(ctx).toEqual({
      repoAddr: ADDR,
      commit: COMMIT,
      tagObjectIds: [TAG_OBJ],
      workflow: { path: '.github/workflows/ci.yml', sha256: WF_SHA },
      reason: 'push',
      ref: 'refs/heads/main',
    });
  });

  it('parses pull_request context from the NIP-22 tags and ignores the run-id r', () => {
    const ctx = parseCiTriggerContext([...COMMON_PR_TAGS, ['r', RUN_ID]]);
    expect(ctx?.reason).toBe('pull_request');
    expect(ctx?.ref).toBeUndefined();
    expect(ctx?.pr).toEqual({
      prEventId: PR_ID,
      prAuthor: STRANGER,
      prKind: 1618,
      sourceEventId: PR_UPDATE_ID,
      sourceAuthor: STRANGER,
      sourceKind: 1619,
    });
  });

  it('keeps extra repo coordinates and defaults a missing o to the supplied reason', () => {
    const other = `30617:${MAINTAINER}:${REPO}`;
    const ctx = parseCiTriggerContext(
      [['a', ADDR], ['a', other], ['c', COMMIT], ['w', 'ci.yml', WF_SHA]],
      'manual'
    );
    expect(ctx?.extraRepoAddrs).toEqual([other]);
    expect(ctx?.reason).toBe('manual');
  });

  it('returns null without a, c, or w', () => {
    expect(parseCiTriggerContext([['c', COMMIT], ['w', 'ci.yml', WF_SHA], ['o', 'push']])).toBeNull();
    expect(parseCiTriggerContext([['a', ADDR], ['w', 'ci.yml', WF_SHA], ['o', 'push']])).toBeNull();
    expect(parseCiTriggerContext([['a', ADDR], ['c', COMMIT], ['o', 'push']])).toBeNull();
    expect(parseCiTriggerContext([['a', ADDR], ['c', COMMIT], ['w', 'ci.yml', WF_SHA]])).toBeNull();
  });
});

describe('parseCiServiceControl (9843 / 9844)', () => {
  it('parses a request with its relay hint', () => {
    const ev = event({
      kind: CI_SERVICE_REQUEST_KIND,
      pubkey: MAINTAINER,
      tags: [['a', ADDR, RELAY], ['p', COORD]],
    });
    expect(parseCiServiceControl(ev)).toEqual({
      kind: 'request',
      eventId: ev.id,
      pubkey: MAINTAINER,
      createdAt: ev.created_at,
      repoAddr: ADDR,
      coordinatorPubkey: COORD,
      relayHint: RELAY,
    });
  });

  it('parses a stop and rejects other kinds / missing tags', () => {
    const stop = event({ kind: CI_SERVICE_STOP_KIND, pubkey: OWNER, tags: [['a', ADDR], ['p', COORD]] });
    expect(parseCiServiceControl(stop)?.kind).toBe('stop');
    expect(parseCiServiceControl(event({ kind: 1, tags: [['a', ADDR], ['p', COORD]] }))).toBeNull();
    expect(parseCiServiceControl(event({ kind: CI_SERVICE_REQUEST_KIND, tags: [['a', ADDR]] }))).toBeNull();
    expect(
      parseCiServiceControl(event({ kind: CI_SERVICE_REQUEST_KIND, tags: [['a', ADDR], ['p', COORD], ['a', ADDR]] }))
    ).toBeNull();
  });
});

describe('control ordering + selectServiceRequests', () => {
  it('orders by created_at then by LOWER id being later', () => {
    const a = { createdAt: 10, eventId: 'bb' };
    const b = { createdAt: 10, eventId: 'aa' };
    const c = { createdAt: 11, eventId: 'zz' };
    expect(controlOrder(a, b)).toBeLessThan(0); // b (lower id) is later
    expect(controlOrder(b, c)).toBeLessThan(0);
    expect([c, b, a].sort(controlOrder).map((x) => x.eventId)).toEqual(['bb', 'aa', 'zz']);
  });

  function control(kind: number, pubkey: string, createdAt: number, coordinator = COORD) {
    const ev = event({ kind, pubkey, created_at: createdAt, tags: [['a', ADDR], ['p', coordinator]] });
    const parsed = parseCiServiceControl(ev);
    if (!parsed) throw new Error('fixture');
    return parsed;
  }

  it('a maintainer request is active until a maintainer stop', () => {
    const req = control(CI_SERVICE_REQUEST_KIND, MAINTAINER, 100);
    const stop = control(CI_SERVICE_STOP_KIND, OWNER, 200);
    const opts = { coordinatorPubkey: COORD, repoAddr: ADDR, authorized: AUTHORIZED };
    expect(selectServiceRequests([req], opts).active?.eventId).toBe(req.eventId);
    expect(selectServiceRequests([req, stop], opts).active).toBeNull();
    // Evaluated BEFORE the stop it is still active.
    expect(selectServiceRequests([req, stop], { ...opts, at: 150 }).active?.eventId).toBe(req.eventId);
  });

  it("a non-maintainer stop closes only that author's requests", () => {
    const req = control(CI_SERVICE_REQUEST_KIND, MAINTAINER, 100);
    const strangerReq = control(CI_SERVICE_REQUEST_KIND, STRANGER, 110);
    const strangerStop = control(CI_SERVICE_STOP_KIND, STRANGER, 120);
    const opts = { coordinatorPubkey: COORD, repoAddr: ADDR, authorized: AUTHORIZED };
    const sel = selectServiceRequests([req, strangerReq, strangerStop], opts);
    expect(sel.active?.eventId).toBe(req.eventId);
    expect(sel.open.map((c) => c.eventId)).toEqual([req.eventId]);
  });

  it('a later request re-opens service and unrelated coordinators/repos are ignored', () => {
    const req = control(CI_SERVICE_REQUEST_KIND, MAINTAINER, 100);
    const stop = control(CI_SERVICE_STOP_KIND, MAINTAINER, 200);
    const again = control(CI_SERVICE_REQUEST_KIND, OWNER, 300);
    const other = control(CI_SERVICE_REQUEST_KIND, OWNER, 400, STRANGER);
    const opts = { coordinatorPubkey: COORD, repoAddr: ADDR, authorized: AUTHORIZED };
    expect(selectServiceRequests([req, stop, again, other], opts).active?.eventId).toBe(again.eventId);
  });

  it('a request from a non-maintainer is never active under the default policy', () => {
    const strangerReq = control(CI_SERVICE_REQUEST_KIND, STRANGER, 110);
    const opts = { coordinatorPubkey: COORD, repoAddr: ADDR, authorized: AUTHORIZED };
    expect(selectServiceRequests([strangerReq], opts).active).toBeNull();
  });
});

describe('parseCiWorkflowResult (9842)', () => {
  it('parses the run id, conclusion, timings, provenance and job quotes', () => {
    const ev = event({
      kind: CI_WORKFLOW_RESULT_KIND,
      tags: [
        ...COMMON_PUSH_TAGS,
        ['r', RUN_ID],
        ['conclusion', 'failure'],
        ['queued_at', '1700'],
        ['started_at', '1710'],
        ['q', '77'.repeat(32), RELAY, MAINTAINER, 'service-request'],
        ['q', '88'.repeat(32), RELAY, COORD, 'build'],
        ['q', '99'.repeat(32), RELAY, COORD, 'test'],
      ],
    });
    const parsed = parseCiWorkflowResult(ev);
    expect(parsed).toMatchObject({
      eventId: ev.id,
      pubkey: COORD,
      runId: RUN_ID,
      conclusion: 'failure',
      queuedAt: 1700,
      startedAt: 1710,
      provenance: { kind: 'service-request', eventId: '77'.repeat(32), relayUrl: RELAY, pubkey: MAINTAINER },
      jobs: [
        { eventId: '88'.repeat(32), relayUrl: RELAY, pubkey: COORD, jobId: 'build' },
        { eventId: '99'.repeat(32), relayUrl: RELAY, pubkey: COORD, jobId: 'test' },
      ],
    });
    expect(parsed?.trigger.commit).toBe(COMMIT);
    expect(parsed?.trigger.ref).toBe('refs/heads/main');
  });

  it('rejects a result without a run id or with an unknown conclusion', () => {
    expect(parseCiWorkflowResult(event({ kind: CI_WORKFLOW_RESULT_KIND, tags: [...COMMON_PUSH_TAGS, ['conclusion', 'success']] }))).toBeNull();
    expect(
      parseCiWorkflowResult(event({ kind: CI_WORKFLOW_RESULT_KIND, tags: [...COMMON_PUSH_TAGS, ['r', RUN_ID], ['conclusion', 'green']] }))
    ).toBeNull();
  });
});

describe('parseCiWorkflowProgress (39842)', () => {
  it('parses status, in-progress jobs, queue rounds and expiry', () => {
    const ev = event({
      kind: CI_WORKFLOW_PROGRESS_KIND,
      tags: [
        ['d', RUN_ID],
        ...COMMON_PUSH_TAGS,
        ['status', 'in_progress'],
        ['in-progress', 'build', 'test'],
        ['expiration', '2000'],
        ['q', '77'.repeat(32), RELAY, OWNER, 'manual-trigger'],
        ['q', '88'.repeat(32), RELAY, COORD, 'lint'],
      ],
    });
    const parsed = parseCiWorkflowProgress(ev);
    expect(parsed).toMatchObject({
      runId: RUN_ID,
      status: 'in_progress',
      inProgress: ['build', 'test'],
      expiresAt: 2000,
      provenance: { kind: 'manual-trigger', pubkey: OWNER },
      jobs: [{ jobId: 'lint' }],
    });
    expect(parsed?.conclusion).toBeUndefined();
  });

  it('carries queue while queued and conclusion once concluded', () => {
    const queued = parseCiWorkflowProgress(
      event({ kind: CI_WORKFLOW_PROGRESS_KIND, tags: [['d', RUN_ID], ...COMMON_PUSH_TAGS, ['status', 'queued'], ['queue', '2'], ['expiration', '2000']] })
    );
    expect(queued?.queue).toBe(2);
    const done = parseCiWorkflowProgress(
      event({ kind: CI_WORKFLOW_PROGRESS_KIND, tags: [['d', RUN_ID], ...COMMON_PUSH_TAGS, ['status', 'concluded'], ['conclusion', 'success'], ['expiration', '2000']] })
    );
    expect(done?.conclusion).toBe('success');
  });

  it('rejects an unknown status or a missing d', () => {
    expect(parseCiWorkflowProgress(event({ kind: CI_WORKFLOW_PROGRESS_KIND, tags: [['d', RUN_ID], ...COMMON_PUSH_TAGS, ['status', 'running']] }))).toBeNull();
    expect(parseCiWorkflowProgress(event({ kind: CI_WORKFLOW_PROGRESS_KIND, tags: [...COMMON_PUSH_TAGS, ['status', 'queued']] }))).toBeNull();
  });
});

describe('parseCiJobResult (9841)', () => {
  it('parses the progress address, job, conclusion, logs, artifacts and timings', () => {
    const ev = event({
      kind: CI_JOB_RESULT_KIND,
      content: '[log-tail omitted=1200]\nnpm test\nok',
      tags: [
        ...COMMON_PUSH_TAGS,
        ['q', `39842:${COORD}:${RUN_ID}`, RELAY],
        ['job', 'test'],
        ['name', 'Unit tests'],
        ['conclusion', 'success'],
        ['logs', 'http://localhost:3000/raw/tx1'],
        ['artifact', 'http://localhost:3000/raw/tx2', 'dist/index.js', 'build'],
        ['queued_at', '1700'],
        ['started_at', '1710'],
        ['exit_code', '0'],
        ['runs_on', 'ubuntu-latest'],
      ],
    });
    expect(parseCiJobResult(ev)).toMatchObject({
      eventId: ev.id,
      pubkey: COORD,
      progressAddress: `39842:${COORD}:${RUN_ID}`,
      runId: RUN_ID,
      coordinator: COORD,
      jobId: 'test',
      name: 'Unit tests',
      conclusion: 'success',
      logsUrl: 'http://localhost:3000/raw/tx1',
      logTail: '[log-tail omitted=1200]\nnpm test\nok',
      artifacts: [{ url: 'http://localhost:3000/raw/tx2', filename: 'dist/index.js', name: 'build' }],
      queuedAt: 1700,
      startedAt: 1710,
      exitCode: 0,
      runsOn: ['ubuntu-latest'],
    });
  });

  it('rejects a job result without job / conclusion / progress quote', () => {
    expect(parseCiJobResult(event({ kind: CI_JOB_RESULT_KIND, tags: [...COMMON_PUSH_TAGS, ['job', 'x'], ['conclusion', 'success']] }))).toBeNull();
    expect(parseCiJobResult(event({ kind: CI_JOB_RESULT_KIND, tags: [...COMMON_PUSH_TAGS, ['q', `39842:${COORD}:${RUN_ID}`], ['conclusion', 'success']] }))).toBeNull();
  });
});

describe('deriveTrustLevel', () => {
  function request(pubkey: string, createdAt: number, coordinator = COORD) {
    const ev = event({ kind: CI_SERVICE_REQUEST_KIND, pubkey, created_at: createdAt, tags: [['a', ADDR], ['p', coordinator]] });
    const parsed = parseCiServiceControl(ev);
    if (!parsed) throw new Error('fixture');
    return parsed;
  }

  it('maintainer-directed: the run quotes a service request from a maintainer that targets this coordinator', () => {
    const req = request(MAINTAINER, 100);
    expect(
      deriveTrustLevel({
        publisherPubkey: COORD,
        provenance: { kind: 'service-request', eventId: req.eventId, relayUrl: RELAY, pubkey: MAINTAINER },
        authorized: AUTHORIZED,
        controls: [req],
        runCreatedAt: 500,
      })
    ).toBe('maintainer-directed');
  });

  it('maintainer-directed: a manual trigger from the owner needs no standing request', () => {
    expect(
      deriveTrustLevel({
        publisherPubkey: COORD,
        provenance: { kind: 'manual-trigger', eventId: '77'.repeat(32), relayUrl: RELAY, pubkey: OWNER },
        authorized: AUTHORIZED,
        controls: [],
        runCreatedAt: 500,
      })
    ).toBe('maintainer-directed');
  });

  it('a quoted request that is unknown or addressed elsewhere does not count as directed', () => {
    const elsewhere = request(MAINTAINER, 100, STRANGER);
    expect(
      deriveTrustLevel({
        publisherPubkey: COORD,
        provenance: { kind: 'service-request', eventId: elsewhere.eventId, relayUrl: RELAY, pubkey: MAINTAINER },
        authorized: AUTHORIZED,
        controls: [elsewhere],
        runCreatedAt: 500,
      })
    ).toBe('no-known-context');
  });

  it('operationally-associated: a standing maintainer request, but the run carries no quote', () => {
    expect(
      deriveTrustLevel({ publisherPubkey: COORD, authorized: AUTHORIZED, controls: [request(MAINTAINER, 100)], runCreatedAt: 500 })
    ).toBe('operationally-associated');
  });

  it('seen-in-network: the owner runs their own coordinator, or a stranger asked for service', () => {
    expect(deriveTrustLevel({ publisherPubkey: OWNER, authorized: AUTHORIZED, controls: [], runCreatedAt: 500 })).toBe('seen-in-network');
    expect(
      deriveTrustLevel({ publisherPubkey: COORD, authorized: AUTHORIZED, controls: [request(STRANGER, 100)], runCreatedAt: 500 })
    ).toBe('seen-in-network');
  });

  it("no-known-context: a stranger's coordinator with no relationship to the repo", () => {
    expect(deriveTrustLevel({ publisherPubkey: STRANGER, authorized: AUTHORIZED, controls: [], runCreatedAt: 500 })).toBe('no-known-context');
  });

  it('trustAtLeast follows the strongest-first order', () => {
    expect(trustAtLeast('maintainer-directed', 'operationally-associated')).toBe(true);
    expect(trustAtLeast('seen-in-network', 'operationally-associated')).toBe(false);
    expect(trustAtLeast('no-known-context', 'no-known-context')).toBe(true);
  });
});

describe('buildCiRuns + aggregateRunStatus', () => {
  it('merges a progress marker and its result into one run, newest attempt current', () => {
    const progress = event({
      kind: CI_WORKFLOW_PROGRESS_KIND,
      created_at: 1500,
      tags: [['d', RUN_ID], ...COMMON_PUSH_TAGS, ['status', 'in_progress'], ['in-progress', 'build'], ['expiration', '3300']],
    });
    const result = event({
      kind: CI_WORKFLOW_RESULT_KIND,
      created_at: 1600,
      tags: [...COMMON_PUSH_TAGS, ['r', RUN_ID], ['conclusion', 'success'], ['q', '88'.repeat(32), RELAY, COORD, 'build']],
    });
    const older = event({
      kind: CI_WORKFLOW_RESULT_KIND,
      created_at: 1400,
      tags: [...COMMON_PUSH_TAGS, ['r', 'run-0000'], ['conclusion', 'failure']],
    });
    const runs = buildCiRuns([progress, result, older], { authorized: AUTHORIZED, controls: [] });
    expect(runs.map((r) => r.runId)).toEqual([RUN_ID, 'run-0000']); // newest first
    const [current, previous] = runs;
    expect(current).toMatchObject({
      runId: RUN_ID,
      coordinator: COORD,
      status: 'concluded',
      conclusion: 'success',
      current: true,
      jobs: [{ jobId: 'build' }],
      trust: 'no-known-context',
      resultEventId: result.id,
      progressEventId: progress.id,
    });
    expect(previous?.current).toBe(false);
    expect(previous?.conclusion).toBe('failure');
  });

  it('a progress marker alone is a pending run', () => {
    const progress = event({
      kind: CI_WORKFLOW_PROGRESS_KIND,
      tags: [['d', RUN_ID], ...COMMON_PUSH_TAGS, ['status', 'queued'], ['queue', '1'], ['expiration', '3300']],
    });
    const [run] = buildCiRuns([progress], { authorized: AUTHORIZED, controls: [] });
    expect(run).toMatchObject({ status: 'queued', queue: 1, current: true });
    expect(run?.conclusion).toBeUndefined();
  });

  it('aggregates: pending beats failure beats success; empty is null', () => {
    const mk = (status: 'queued' | 'in_progress' | 'concluded', conclusion?: string) =>
      ({ status, conclusion } as never);
    expect(aggregateRunStatus([])).toBeNull();
    expect(aggregateRunStatus([mk('concluded', 'success'), mk('concluded', 'skipped')])).toBe('success');
    expect(aggregateRunStatus([mk('concluded', 'success'), mk('concluded', 'timed_out')])).toBe('failure');
    expect(aggregateRunStatus([mk('concluded', 'failure'), mk('in_progress')])).toBe('pending');
    expect(aggregateRunStatus([mk('concluded', 'neutral')])).toBe('neutral');
  });
});
