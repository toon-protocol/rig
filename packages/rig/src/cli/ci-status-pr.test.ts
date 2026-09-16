/**
 * `rig ci status` for pull-request runs (#130): each run carries the PR's
 * NIP-22 context (root event id + kind + author, the update that supplied
 * the commit) and whether the PR author is the repo owner or a declared
 * maintainer — derived on the READ side from the 30617, never from anything
 * the coordinator asserts.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type { NostrEvent } from '../remote-state.js';
import type { UnsignedEvent } from '../nip34-events.js';
import {
  buildCiServiceRequest,
  buildCiWorkflowResult,
  type CiPrContext,
  type CiProvenance,
  type CiTriggerContext,
} from '../ci/nip-c1-events.js';
import type { CliIo } from './output.js';
import { dispatch, type DispatchDeps } from './dispatch.js';
import { filterEvents, makeMockRelayFactory } from './read-testkit.js';
import { renderStatus, type CiStatusReport } from './ci-status.js';

const OWNER = 'ab'.repeat(32);
const MAINTAINER = 'bc'.repeat(32);
const STRANGER = 'dd'.repeat(32);
const COORD = 'cd'.repeat(32);
const RELAY = 'wss://relay.test.example';
const REPO = 'demo';
const A = `30617:${OWNER}:${REPO}`;
const COMMIT = '1a'.repeat(20);
const WF = { path: '.github/workflows/ci.yml', sha256: '3c'.repeat(32) };
const REQ_ID = '11'.repeat(32);
const PR_ID = '51'.repeat(32);
const UPDATE_ID = '52'.repeat(32);
const T0 = 1_800_000_000;

let counter = 0;
function signed(unsigned: UnsignedEvent, pubkey: string): NostrEvent {
  counter += 1;
  return {
    id: counter.toString(16).padStart(64, '0'),
    pubkey,
    sig: 'f0'.repeat(64),
    ...unsigned,
  };
}

const PROVENANCE: CiProvenance = {
  kind: 'service-request',
  eventId: REQ_ID,
  relayUrl: RELAY,
  pubkey: OWNER,
};

function prContext(author: string, viaUpdate: boolean): CiPrContext {
  return {
    prEventId: PR_ID,
    prAuthor: author,
    prKind: 1618,
    sourceEventId: viaUpdate ? UPDATE_ID : PR_ID,
    sourceAuthor: author,
    sourceKind: viaUpdate ? 1619 : 1618,
  };
}

function prResult(opts: {
  runId: string;
  pr: CiPrContext;
  createdAt: number;
}): NostrEvent {
  const trigger: CiTriggerContext = {
    repoAddr: A,
    commit: COMMIT,
    workflow: WF,
    reason: 'pull_request',
    pr: opts.pr,
  };
  return signed(
    buildCiWorkflowResult(
      {
        trigger,
        runId: opts.runId,
        conclusion: 'success',
        queuedAt: opts.createdAt - 30,
        startedAt: opts.createdAt - 20,
        provenance: PROVENANCE,
        jobs: [],
      },
      opts.createdAt
    ),
    COORD
  );
}

function pushResult(runId: string, createdAt: number): NostrEvent {
  return signed(
    buildCiWorkflowResult(
      {
        trigger: {
          repoAddr: A,
          commit: COMMIT,
          workflow: { path: '.github/workflows/deploy.yml', sha256: WF.sha256 },
          reason: 'push',
          ref: 'refs/heads/main',
        },
        runId,
        conclusion: 'success',
        queuedAt: createdAt - 30,
        startedAt: createdAt - 20,
        provenance: PROVENANCE,
        jobs: [],
      },
      createdAt
    ),
    COORD
  );
}

const ANNOUNCEMENT: NostrEvent = {
  id: '30'.repeat(32),
  pubkey: OWNER,
  created_at: 1000,
  kind: 30617,
  tags: [
    ['d', REPO],
    ['name', 'Demo'],
    ['maintainers', MAINTAINER],
  ],
  content: '',
  sig: '0'.repeat(128),
};

function makeDeps(events: NostrEvent[]): {
  deps: DispatchDeps;
  json: unknown[];
} {
  const json: unknown[] = [];
  const io: CliIo = {
    out: () => undefined,
    err: () => undefined,
    emitJson: (payload) => json.push(payload),
    isInteractive: false,
    confirm: async () => false,
  };
  return {
    deps: {
      io,
      env: {},
      cwd: '/nonexistent-not-a-repo',
      webSocketFactory: makeMockRelayFactory((filter) =>
        filterEvents(events, filter)
      ),
      loadStandalone: async () => {
        throw new Error('ci status is free — never loads the standalone');
      },
    },
    json,
  };
}

beforeEach(() => {
  counter = 0;
});

describe('rig ci status — pull request runs', () => {
  it('reports each PR run with the PR event id, the update that supplied the commit, and whether the author is a maintainer', async () => {
    const events = [
      ANNOUNCEMENT,
      signed(buildCiServiceRequest(A, COORD, RELAY, T0 - 100), OWNER),
      prResult({
        runId: 'stranger-pr',
        pr: prContext(STRANGER, true),
        createdAt: T0,
      }),
      prResult({
        runId: 'maintainer-pr',
        pr: prContext(MAINTAINER, false),
        createdAt: T0 - 5,
      }),
      pushResult('push', T0 - 10),
    ];
    const { deps, json } = makeDeps(events);
    const code = await dispatch(
      [
        'ci',
        'status',
        COMMIT,
        '--repo-id',
        REPO,
        '--owner',
        OWNER,
        '--relay',
        RELAY,
        '--json',
      ],
      deps
    );
    expect(code).toBe(0);
    expect(json).toHaveLength(1);
    const report = json[0] as CiStatusReport;
    const byRun = new Map(report.runs.map((r) => [r.runId, r]));

    expect(byRun.get('stranger-pr')).toMatchObject({
      reason: 'pull_request',
      pr: {
        prEventId: PR_ID,
        prKind: 1618,
        prAuthor: STRANGER,
        sourceEventId: UPDATE_ID,
        sourceKind: 1619,
        authorIsMaintainer: false,
      },
    });
    expect(byRun.get('maintainer-pr')).toMatchObject({
      reason: 'pull_request',
      pr: {
        prEventId: PR_ID,
        prAuthor: MAINTAINER,
        sourceEventId: PR_ID,
        sourceKind: 1618,
        authorIsMaintainer: true,
      },
    });
    // A push run has no PR context at all (the key is absent, not null).
    expect(byRun.get('push')).not.toHaveProperty('pr');

    // Human lines: a PR line under each PR run, none under the push run.
    const lines = renderStatus(report);
    const prLines = lines.filter((l) => l.includes('pull request'));
    expect(prLines).toHaveLength(2);
    expect(prLines[0]).toContain(PR_ID);
    expect(prLines[0]).toContain(`via update ${UPDATE_ID}`);
    expect(prLines[0]).toContain('author is not a maintainer');
    expect(prLines[1]).toContain(PR_ID);
    expect(prLines[1]).not.toContain('via update');
    expect(prLines[1]).toContain('author is a maintainer');
  });
});
