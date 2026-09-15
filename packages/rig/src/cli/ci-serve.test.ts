/**
 * `rig ci serve` tests (#125): flag validation, the act-missing refusal
 * (before anything is loaded or paid), and a full serve session driven
 * through the dispatch-level seams — fake standalone context (fake
 * Publisher), scripted relay, FakeRunner, injected abort signal — proving the
 * coordinator advertises, runs a push, and stops cleanly with exit 0, with
 * exactly one JSON document under `--json`.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearShaCache } from '@toon-protocol/arweave';
import {
  fakePublisher,
  flush,
  makeScriptedRelay,
  waitFor,
} from '../ci/ci-testkit.js';
import {
  CI_ADVERTISEMENT_KIND,
  CI_WORKFLOW_RESULT_KIND,
  buildCiServiceRequest,
  repoAddress,
} from '../ci/nip-c1-events.js';
import { FakeRunner } from '../ci/runner.js';
import type { NostrEvent } from '../remote-state.js';
import { hexToNpub } from '../npub.js';
import type { CiDeps } from './ci.js';
import { runCiServe } from './ci-serve.js';
import { dispatch } from './dispatch.js';
import type { CliIo } from './output.js';
import {
  makeMockGateway,
  repoStateEvents,
  storeFromObjects,
} from './read-testkit.js';
import type { StandaloneContext } from './standalone-context.js';

const OWNER = 'ab'.repeat(32);
const MAINT = 'cd'.repeat(32);
const COORD = '12'.repeat(32);
const REPO = 'demo';
const RELAY = 'wss://relay.test.example';

const cleanups: string[] = [];
afterEach(() => {
  clearShaCache();
  for (const dir of cleanups.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(dir);
  return dir;
}

interface Recorder {
  io: CliIo;
  out: string[];
  err: string[];
  json: unknown[];
}

function makeIo(): Recorder {
  const out: string[] = [];
  const err: string[] = [];
  const json: unknown[] = [];
  return {
    out,
    err,
    json,
    io: {
      out: (line) => out.push(line),
      err: (line) => err.push(line),
      emitJson: (payload) => json.push(payload),
      isInteractive: false,
      confirm: async () => false,
    },
  };
}

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Fixture',
      GIT_AUTHOR_EMAIL: 'fixture@test',
      GIT_COMMITTER_NAME: 'Fixture',
      GIT_COMMITTER_EMAIL: 'fixture@test',
    },
  }).trim();
}

function signed(
  event: {
    kind: number;
    tags: string[][];
    content: string;
    created_at: number;
  },
  pubkey: string,
  n: number
): NostrEvent {
  return {
    id: n.toString(16).padStart(64, '0'),
    pubkey,
    sig: 'f0'.repeat(64),
    ...event,
  };
}

function makeServeWorld() {
  const srcDir = tempDir('rig-ci-serve-src-');
  git(['init', '--initial-branch=main'], srcDir);
  mkdirSync(join(srcDir, '.github', 'workflows'), { recursive: true });
  writeFileSync(
    join(srcDir, '.github', 'workflows', 'ci.yml'),
    'on: push\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - run: true\n'
  );
  writeFileSync(join(srcDir, 'README.md'), '# demo\n');
  git(['add', '.'], srcDir);
  git(['commit', '-m', 'initial'], srcDir);

  const store = new Map<string, Uint8Array>();
  const gateway = makeMockGateway(store);
  const relay = makeScriptedRelay();
  const publisher = fakePublisher();
  const snapshot = (createdAt: number) => {
    const { announce, refsEvent, objects } = repoStateEvents({
      repoDir: srcDir,
      owner: OWNER,
      repoId: REPO,
      createdAt,
    });
    for (const [tx, bytes] of storeFromObjects(objects)) store.set(tx, bytes);
    announce.tags.push(['maintainers', MAINT]);
    return { announce, refsEvent };
  };
  const { announce, refsEvent } = snapshot(1000);
  relay.serve([
    announce,
    refsEvent,
    signed(
      buildCiServiceRequest(repoAddress(OWNER, REPO), COORD, RELAY, 1100),
      MAINT,
      1
    ),
  ]);

  let stopped = 0;
  const context: StandaloneContext = {
    ownerPubkey: COORD,
    identitySource: 'env',
    identitySourceLabel: 'RIG_MNEMONIC env',
    publisher,
    defaultRelayUrls: [RELAY],
    fetchRemote: async () => {
      throw new Error(
        'the coordinator reads via fetchRemoteState, not fetchRemote'
      );
    },
    stop: async () => {
      stopped += 1;
    },
  };
  const abort = new AbortController();
  const rec = makeIo();
  const stateDir = join(tempDir('rig-ci-serve-state-'), 'state');
  const runner = new FakeRunner();
  const deps: CiDeps = {
    io: rec.io,
    env: {},
    cwd: tempDir('rig-ci-serve-cwd-'),
    loadStandalone: async () => context,
    webSocketFactory: relay.factory,
    fetchFn: gateway.fetchFn,
    resolveSha: async () => null,
    runner,
    stateDir,
    signal: abort.signal,
  };
  return {
    srcDir,
    relay,
    publisher,
    snapshot,
    abort,
    rec,
    deps,
    runner,
    stateDir,
    stoppedCount: () => stopped,
    push(createdAt: number) {
      writeFileSync(join(srcDir, 'code.txt'), `v${createdAt}\n`);
      git(['add', '.'], srcDir);
      git(['commit', '-m', `change ${createdAt}`], srcDir);
      relay.push(snapshot(createdAt).refsEvent);
    },
  };
}

const REPO_FLAG = `${hexToNpub(OWNER)}/${REPO}`;

describe('rig ci serve: flags', () => {
  it('prints usage with --help', async () => {
    const rec = makeIo();
    const code = await runCiServe(['--help'], {
      io: rec.io,
      env: {},
      cwd: '/nonexistent',
    });
    expect(code).toBe(0);
    expect(rec.out.join('\n')).toContain('Usage: rig ci serve');
  });

  it('refuses without --relay or --repo (exit 2, usage on stderr)', async () => {
    const rec = makeIo();
    expect(
      await runCiServe(['--repo', REPO_FLAG], {
        io: rec.io,
        env: {},
        cwd: '/nonexistent',
      })
    ).toBe(2);
    expect(rec.err[0]).toContain('--relay');
    const rec2 = makeIo();
    expect(
      await runCiServe(['--relay', RELAY], {
        io: rec2.io,
        env: {},
        cwd: '/nonexistent',
      })
    ).toBe(2);
    expect(rec2.err[0]).toContain('--repo');
    const rec3 = makeIo();
    expect(
      await runCiServe(
        ['--relay', 'https://not-a-relay', '--repo', REPO_FLAG],
        { io: rec3.io, env: {}, cwd: '/x' }
      )
    ).toBe(2);
    const rec4 = makeIo();
    expect(
      await runCiServe(['--relay', RELAY, '--repo', 'no-slash'], {
        io: rec4.io,
        env: {},
        cwd: '/x',
      })
    ).toBe(2);
    expect(rec4.err[0]).toContain('<owner>/<repo-id>');
    const rec5 = makeIo();
    expect(
      await runCiServe(
        ['--relay', RELAY, '--repo', REPO_FLAG, '--concurrency', '0'],
        { io: rec5.io, env: {}, cwd: '/x' }
      )
    ).toBe(2);
  });

  it('refuses before loading an identity when act is not installed', async () => {
    const rec = makeIo();
    let loaded = 0;
    const code = await runCiServe(['--relay', RELAY, '--repo', REPO_FLAG], {
      io: rec.io,
      env: { PATH: '/nonexistent-bin' },
      cwd: '/nonexistent',
      loadStandalone: async () => {
        loaded += 1;
        throw new Error('must not be reached');
      },
    });
    expect(code).toBe(1);
    expect(loaded).toBe(0);
    expect(rec.err.join('\n')).toMatch(/act executable was not found/);
    expect(rec.err.join('\n')).toContain('Nothing was started or paid');
  });
});

describe('rig ci serve: a serve session', () => {
  it('advertises, runs a push, and stops cleanly on the abort signal (exit 0)', async () => {
    const world = makeServeWorld();
    const running = dispatch(
      [
        'ci',
        'serve',
        '--relay',
        RELAY,
        '--repo',
        REPO_FLAG,
        '--concurrency',
        '2',
        '--timeout',
        '120',
      ],
      world.deps
    );
    await waitFor(
      () => world.publisher.ofKind(CI_ADVERTISEMENT_KIND).length === 1,
      'the advertisement'
    );
    await flush();
    expect(world.rec.out.join('\n')).toContain(
      `Coordinator: ${hexToNpub(COORD)}`
    );
    expect(world.rec.out.join('\n')).toContain(
      `rig ci request ${hexToNpub(COORD)}`
    );
    expect(world.rec.out.join('\n')).toContain('State:');

    world.push(2000);
    await waitFor(
      () => world.publisher.ofKind(CI_WORKFLOW_RESULT_KIND).length === 1,
      'the workflow result'
    );
    expect(world.runner.requests).toHaveLength(1);
    expect(world.runner.requests[0]!.timeoutMs).toBe(120_000);

    world.abort.abort();
    expect(await running).toBe(0);
    expect(world.stoppedCount()).toBe(1);
    expect(world.rec.err.join('\n')).toContain('stopping');
    expect(world.rec.json).toEqual([]);
  });

  it('emits exactly one JSON document under --json and keeps the coordinator chatter on stderr', async () => {
    const world = makeServeWorld();
    const running = runCiServe(
      ['--relay', RELAY, '--repo', REPO_FLAG, '--json'],
      world.deps
    );
    await waitFor(() => world.rec.json.length === 1, 'the JSON document');
    expect(world.rec.json[0]).toMatchObject({
      command: 'ci serve',
      path: 'standalone',
      coordinator: COORD,
      coordinatorNpub: hexToNpub(COORD),
      relay: RELAY,
      repos: [{ ownerPubkey: OWNER, repoId: REPO }],
      runner: { family: 'act', selectors: ['ubuntu-latest'] },
      concurrency: 1,
      timeoutSeconds: 1800,
      stateDir: world.stateDir,
    });
    expect((world.rec.json[0] as { secretsKey: string }).secretsKey).toMatch(
      /^[0-9a-f]{64}$/
    );
    expect(world.rec.out).toEqual([]);
    world.push(2000);
    await waitFor(
      () => world.publisher.ofKind(CI_WORKFLOW_RESULT_KIND).length === 1,
      'the workflow result'
    );
    world.abort.abort();
    expect(await running).toBe(0);
    expect(world.rec.json).toHaveLength(1);
    expect(world.rec.err.some((l) => l.startsWith('[ci]'))).toBe(true);
  });

  it('reports a session failure as a CLI error and stops the context', async () => {
    const world = makeServeWorld();
    world.deps.loadStandalone = async () => {
      throw new Error('no identity found');
    };
    const code = await runCiServe(
      ['--relay', RELAY, '--repo', REPO_FLAG, '--json'],
      world.deps
    );
    expect(code).toBe(1);
    expect(world.rec.json[0]).toMatchObject({
      command: 'ci serve',
      error: expect.any(String),
    });
    expect(world.rec.err.join('\n')).toContain('no identity found');
  });
});
