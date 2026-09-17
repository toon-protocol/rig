/**
 * `rig ci serve` tests (#125): flag validation, the act-missing refusal
 * (before anything is loaded or paid), and a full serve session driven
 * through the dispatch-level seams — fake standalone context (fake
 * Publisher), scripted relay, FakeRunner, injected abort signal — proving the
 * coordinator advertises, runs a push, and stops cleanly with exit 0, with
 * exactly one JSON document under `--json`. The `--once` sessions (#127)
 * drive one Manual Trigger (9840) from the relay to its Workflow Result and
 * assert the NIP-C1 sequence, the `q` quotes, and the store URLs in full.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
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
  CI_JOB_RESULT_KIND,
  CI_WORKFLOW_PROGRESS_KIND,
  CI_WORKFLOW_RESULT_KIND,
  buildCiManualTrigger,
  buildCiServiceRequest,
  parseCiJobResult,
  parseCiWorkflowProgress,
  parseCiWorkflowResult,
  repoAddress,
} from '../ci/nip-c1-events.js';
import { FakeRunner, type RunnerRunResult } from '../ci/runner.js';
import { sha256Hex } from '../ci/workflows.js';
import type { NostrEvent } from '../remote-state.js';
import { hexToNpub } from '../npub.js';
import type { CiDeps } from './ci.js';
import {
  actRunnerOptions,
  estimateRunCost,
  makeAffordabilityCheck,
  runCiServe,
} from './ci-serve.js';
import {
  ChannelMapStore,
  resolveChannelPaths,
} from '../standalone/channel-map.js';
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
const STRANGER = 'ef'.repeat(32);
const COORD = '12'.repeat(32);
const REPO = 'demo';
const RELAY = 'wss://relay.test.example';

const cleanups: string[] = [];

/** Narrow an optional value or fail the test loudly (no non-null assertions). */
function must<T>(value: T | undefined | null, what = 'value'): T {
  if (value === undefined || value === null) {
    throw new Error(`expected ${what} to be present`);
  }
  return value;
}
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

function makeServeWorld(
  options: { extraWorkflows?: Record<string, string> } = {}
) {
  const srcDir = tempDir('rig-ci-serve-src-');
  git(['init', '--initial-branch=main'], srcDir);
  mkdirSync(join(srcDir, '.github', 'workflows'), { recursive: true });
  writeFileSync(
    join(srcDir, '.github', 'workflows', 'ci.yml'),
    'on: push\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - run: true\n'
  );
  for (const [path, content] of Object.entries(options.extraWorkflows ?? {})) {
    mkdirSync(dirname(join(srcDir, path)), { recursive: true });
    writeFileSync(join(srcDir, path), content);
  }
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
  const home = tempDir('rig-ci-serve-home-');
  const deps: CiDeps = {
    io: rec.io,
    env: { TOON_CLIENT_HOME: home },
    cwd: tempDir('rig-ci-serve-cwd-'),
    loadStandalone: async () => context,
    // The default wallet check reads THIS identity's recorded channels under
    // TOON_CLIENT_HOME; the affordability tests below drop this override.
    canAfford: async () => true,
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
    gateway,
    snapshot,
    abort,
    rec,
    deps,
    runner,
    stateDir,
    home,
    context,
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

  it('refuses --pull together with --no-pull (exit 2), and accepts either alone (#175)', async () => {
    const rec = makeIo();
    expect(
      await runCiServe(
        ['--relay', RELAY, '--repo', REPO_FLAG, '--pull', '--no-pull'],
        { io: rec.io, env: {}, cwd: '/x' }
      )
    ).toBe(2);
    expect(rec.err[0]).toContain('--pull');
    expect(rec.err[0]).toContain('--no-pull');

    // Either alone parses: the run reaches the act-binary check, which is
    // the first thing after the flags that can refuse.
    for (const flag of ['--pull', '--no-pull']) {
      const recOne = makeIo();
      expect(
        await runCiServe(['--relay', RELAY, '--repo', REPO_FLAG, flag], {
          io: recOne.io,
          env: { PATH: '/nonexistent-bin' },
          cwd: '/nonexistent',
        })
      ).toBe(1);
      expect(recOne.err.join('\n')).toMatch(/act executable was not found/);
    }
  });

  it('maps the runner flags onto ActRunner options — --no-pull is the one a local image needs (#175)', () => {
    expect(actRunnerOptions({ pull: false })).toEqual({ pull: false });
    expect(actRunnerOptions({ pull: true })).toEqual({ pull: true });
    // Neither flag: no `pull` key at all, so act's own default (pull) stands.
    expect(actRunnerOptions({})).toEqual({});
    expect(
      actRunnerOptions({
        actBin: '/opt/act',
        platforms: { 'ubuntu-latest': 'my-runner:1' },
        pull: false,
      })
    ).toEqual({
      actBin: '/opt/act',
      platforms: { 'ubuntu-latest': 'my-runner:1' },
      pull: false,
    });
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
    expect(must(world.runner.requests[0]).timeoutMs).toBe(120_000);

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

  /**
   * A gateway shaped like the sandbox's (and any ar.io node behind a
   * sandboxing redirect): plain `/<txId>` is NOT served, only the store's
   * raw-bytes route `/raw/<txId>` is. Every other host is unreachable, so a
   * run can only succeed if the coordinator reads through the named gateway.
   */
  function rawRouteOnlyGateway(world: ReturnType<typeof makeServeWorld>) {
    const seen: string[] = [];
    world.deps.fetchFn = async (url, init) => {
      seen.push(url);
      const parsed = new URL(url);
      const raw = /^\/raw\/([^/]+)$/.exec(parsed.pathname);
      if (parsed.host !== 'gw.test' || raw === null) {
        return { ok: false, arrayBuffer: async () => new ArrayBuffer(0) };
      }
      return world.gateway.fetchFn(`https://gw.test/${raw[1]}`, init);
    };
    return seen;
  }

  it('reads objects through --gateway (<url>/raw/<txId>) before the shared gateway list (#134)', async () => {
    const world = makeServeWorld();
    const seen = rawRouteOnlyGateway(world);
    const running = runCiServe(
      ['--relay', RELAY, '--repo', REPO_FLAG, '--gateway', 'https://gw.test/'],
      world.deps
    );
    await waitFor(
      () => world.publisher.ofKind(CI_ADVERTISEMENT_KIND).length === 1,
      'the advertisement'
    );
    world.push(2000);
    await waitFor(
      () => world.publisher.ofKind(CI_WORKFLOW_RESULT_KIND).length === 1,
      'the workflow result'
    );
    expect(world.runner.requests).toHaveLength(1);
    // Every object came from the named gateway's raw route; nothing fell
    // through to the shared list.
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((u) => u.startsWith('https://gw.test/raw/'))).toBe(true);
    world.abort.abort();
    expect(await running).toBe(0);
  });

  it('RIG_ARWEAVE_GATEWAY names the gateway when --gateway is absent, for links and reads alike (#134)', async () => {
    const world = makeServeWorld();
    const seen = rawRouteOnlyGateway(world);
    world.deps.env = {
      ...world.deps.env,
      RIG_ARWEAVE_GATEWAY: 'https://gw.test',
    };
    const running = runCiServe(
      ['--relay', RELAY, '--repo', REPO_FLAG, '--json'],
      world.deps
    );
    await waitFor(() => world.rec.json.length === 1, 'the JSON document');
    expect(world.rec.json[0]).toMatchObject({ gateway: 'https://gw.test' });
    world.push(2000);
    await waitFor(
      () => world.publisher.ofKind(CI_WORKFLOW_RESULT_KIND).length === 1,
      'the workflow result'
    );
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((u) => u.startsWith('https://gw.test/raw/'))).toBe(true);
    world.abort.abort();
    expect(await running).toBe(0);
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

// ---------------------------------------------------------------------------
// --once: one manual trigger → workflow result → exit (#127)
// ---------------------------------------------------------------------------

const MANUAL_WORKFLOW_PATH = '.github/workflows/manual.yml';
const MANUAL_WORKFLOW = `name: manual
on: workflow_dispatch
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo build
  test:
    runs-on: ubuntu-latest
    steps:
      - run: echo test
`;
const GATEWAY = 'http://gateway.test:3000';
const ADDR = repoAddress(OWNER, REPO);

function manualTrigger(
  commit: string,
  from: string,
  n: number,
  workflow = { path: MANUAL_WORKFLOW_PATH, sha256: sha256Hex(MANUAL_WORKFLOW) }
): NostrEvent {
  return signed(
    buildCiManualTrigger(
      COORD,
      { repoAddr: ADDR, commit, workflow, ref: 'refs/heads/main' },
      1500 + n
    ),
    from,
    n
  );
}

/** The `a`/`c`/`w`/`o` tags every event of a manual run must carry. */
function commonTagsOf(tags: string[][]) {
  return {
    a: tags.filter((t) => t[0] === 'a').map((t) => t[1]),
    c: tags.filter((t) => t[0] === 'c').map((t) => t[1]),
    w: tags.filter((t) => t[0] === 'w').map((t) => t.slice(1)),
    o: tags.filter((t) => t[0] === 'o').map((t) => t[1]),
  };
}

describe('rig ci serve --once: manual trigger → workflow result → exit (#127)', () => {
  it('refuses a stranger, then runs ONE maintainer trigger through the fake Runner and publisher in NIP-C1 order and exits 0 on its own', async () => {
    const world = makeServeWorld({
      extraWorkflows: { [MANUAL_WORKFLOW_PATH]: MANUAL_WORKFLOW },
    });
    const commit = git(['rev-parse', 'HEAD'], world.srcDir);

    // A two-job scripted outcome: build succeeds with one artifact file,
    // test fails with exit code 1 — so the run concludes `failure`.
    const artifactDir = tempDir('rig-ci-once-artifact-');
    writeFileSync(join(artifactDir, 'out.txt'), 'built\n');
    const runner = new FakeRunner((): RunnerRunResult => ({
      conclusion: 'failure',
      startedAt: 10,
      finishedAt: 30,
      jobs: [
        {
          jobId: 'build',
          name: 'build',
          conclusion: 'success',
          exitCode: 0,
          startedAt: 10,
          finishedAt: 20,
          log: 'building…\nok\n',
          artifacts: [
            {
              path: join(artifactDir, 'out.txt'),
              filename: 'out.txt',
              name: 'outputs',
            },
          ],
        },
        {
          jobId: 'test',
          name: 'test',
          conclusion: 'failure',
          exitCode: 1,
          startedAt: 20,
          finishedAt: 30,
          log: 'testing…\nFAIL\n',
          artifacts: [],
        },
      ],
    }));
    world.deps.runner = runner;

    const running = dispatch(
      [
        'ci',
        'serve',
        '--relay',
        RELAY,
        '--repo',
        REPO_FLAG,
        '--gateway',
        GATEWAY,
        '--once',
        '--json',
      ],
      world.deps
    );
    await waitFor(
      () => world.publisher.ofKind(CI_ADVERTISEMENT_KIND).length === 1,
      'the advertisement'
    );
    await flush();
    expect(world.rec.json).toHaveLength(1);
    expect(world.rec.json[0]).toMatchObject({
      command: 'ci serve',
      once: true,
    });

    // A stranger's trigger: nothing published, the refusal logged, and the
    // coordinator keeps listening (--once counts runs, not requests).
    world.relay.push(manualTrigger(commit, STRANGER, 2));
    await waitFor(
      () => world.rec.err.some((l) => /non-maintainer/.test(l)),
      'the refusal on stderr'
    );
    await flush();
    expect(world.publisher.publishedEvents).toHaveLength(1); // the advertisement
    expect(runner.requests).toHaveLength(0);

    // The maintainer's trigger runs, and the session ends by itself.
    const trigger = manualTrigger(commit, MAINT, 3);
    world.relay.push(trigger);
    expect(await running).toBe(0);
    expect(world.stoppedCount()).toBe(1);
    expect(world.rec.err.join('\n')).toContain('--once');
    expect(world.rec.json).toHaveLength(1);

    // Exactly ONE run was handed to the Runner, at the requested commit.
    expect(runner.requests).toHaveLength(1);
    expect(must(runner.requests[0])).toMatchObject({
      workflow: {
        path: MANUAL_WORKFLOW_PATH,
        sha256: sha256Hex(MANUAL_WORKFLOW),
      },
      trigger: { commit, reason: 'manual' },
    });

    // The NIP-C1 sequence, in order: queued → in_progress → per job (9841 +
    // the renewed in_progress quoting it) → 9842 → concluded.
    const published = world.publisher.publishedEvents.filter(
      (p) => p.event.kind !== CI_ADVERTISEMENT_KIND
    );
    expect(published.map((p) => p.event.kind)).toEqual([
      CI_WORKFLOW_PROGRESS_KIND, // queued
      CI_WORKFLOW_PROGRESS_KIND, // in_progress: build, test
      CI_JOB_RESULT_KIND, // build
      CI_WORKFLOW_PROGRESS_KIND, // in_progress, quoting build
      CI_JOB_RESULT_KIND, // test
      CI_WORKFLOW_PROGRESS_KIND, // in_progress, quoting build + test
      CI_WORKFLOW_RESULT_KIND, // result
      CI_WORKFLOW_PROGRESS_KIND, // concluded
    ]);
    // Every one of them carries the common trigger tags, paid from the
    // coordinator's own identity to the one relay.
    for (const p of published) {
      expect(commonTagsOf(p.event.tags)).toEqual({
        a: [ADDR],
        c: [commit],
        w: [[MANUAL_WORKFLOW_PATH, sha256Hex(MANUAL_WORKFLOW)]],
        o: ['manual'],
      });
      expect(p.relayUrls).toEqual([RELAY]);
    }

    const asRelay = (p: (typeof published)[number]) =>
      world.publisher.asRelayEvent(p, COORD);
    const progress = world.publisher
      .ofKind(CI_WORKFLOW_PROGRESS_KIND)
      .map((p) => must(parseCiWorkflowProgress(asRelay(p)), 'a 39842'));
    const jobs = world.publisher
      .ofKind(CI_JOB_RESULT_KIND)
      .map((p) => must(parseCiJobResult(asRelay(p)), 'a 9841'));
    const [result] = world.publisher
      .ofKind(CI_WORKFLOW_RESULT_KIND)
      .map((p) => must(parseCiWorkflowResult(asRelay(p)), 'a 9842'));
    const [queued, inProgress, afterBuild, afterTest, concluded] = progress;
    const runId = must(queued).runId;

    expect(queued).toMatchObject({
      status: 'queued',
      jobs: [],
      provenance: {
        kind: 'manual-trigger',
        eventId: trigger.id,
        pubkey: MAINT,
      },
      trigger: { reason: 'manual', commit, ref: 'refs/heads/main' },
    });
    expect(inProgress).toMatchObject({
      status: 'in_progress',
      runId,
      inProgress: ['build', 'test'],
      jobs: [],
    });

    // One 9841 per job: conclusion, exit code, timings, log tail, and the
    // store gateway URLs of the uploaded log and artifact.
    const [build, test] = jobs;
    expect(build).toMatchObject({
      jobId: 'build',
      name: 'build',
      conclusion: 'success',
      exitCode: 0,
      startedAt: 10,
      progressAddress: `39842:${COORD}:${runId}`,
      logsUrl: `${GATEWAY}/raw/tx-1`,
      logTail: 'building…\nok\n',
      logOmittedBytes: 0,
      artifacts: [
        { url: `${GATEWAY}/raw/tx-2`, filename: 'out.txt', name: 'outputs' },
      ],
      runsOn: ['ubuntu-latest'],
    });
    expect(test).toMatchObject({
      jobId: 'test',
      conclusion: 'failure',
      exitCode: 1,
      startedAt: 20,
      progressAddress: `39842:${COORD}:${runId}`,
      logsUrl: `${GATEWAY}/raw/tx-3`,
      logTail: 'testing…\nFAIL\n',
      artifacts: [],
    });
    // …and those URLs came from the publisher's blob upload, byte for byte.
    expect(
      world.publisher.uploadedBlobs.map((b) => ({
        txId: b.txId,
        contentType: b.contentType,
        repoId: b.repoId,
        body: Buffer.from(b.body).toString('utf-8'),
      }))
    ).toEqual([
      {
        txId: 'tx-1',
        contentType: 'text/plain; charset=utf-8',
        repoId: REPO,
        body: 'building…\nok\n',
      },
      {
        txId: 'tx-2',
        contentType: 'text/plain',
        repoId: REPO,
        body: 'built\n',
      },
      {
        txId: 'tx-3',
        contentType: 'text/plain; charset=utf-8',
        repoId: REPO,
        body: 'testing…\nFAIL\n',
      },
    ]);

    // The `q` quotes link the pieces: each renewed 39842 quotes the job
    // results so far, and the 9842 quotes every job result AND the trigger.
    const buildQuote = {
      eventId: must(build).eventId,
      relayUrl: RELAY,
      pubkey: COORD,
      jobId: 'build',
    };
    const testQuote = {
      ...buildQuote,
      eventId: must(test).eventId,
      jobId: 'test',
    };
    expect(afterBuild).toMatchObject({
      status: 'in_progress',
      inProgress: ['test'],
      jobs: [buildQuote],
    });
    expect(afterTest).toMatchObject({
      status: 'in_progress',
      inProgress: [],
      jobs: [buildQuote, testQuote],
    });
    expect(result).toMatchObject({
      runId,
      conclusion: 'failure',
      startedAt: expect.any(Number),
      provenance: {
        kind: 'manual-trigger',
        eventId: trigger.id,
        relayUrl: RELAY,
        pubkey: MAINT,
      },
      jobs: [buildQuote, testQuote],
      trigger: { reason: 'manual', commit, ref: 'refs/heads/main' },
    });
    expect(concluded).toMatchObject({
      status: 'concluded',
      conclusion: 'failure',
      runId,
      jobs: [buildQuote, testQuote],
      provenance: { kind: 'manual-trigger', eventId: trigger.id },
    });
    expect(must(build).eventId).not.toBe(must(test).eventId);
  });

  it('also exits after a trigger whose run concludes startup_failure (the commit cannot be materialized)', async () => {
    const world = makeServeWorld();
    const running = runCiServe(
      ['--relay', RELAY, '--repo', REPO_FLAG, '--once'],
      world.deps
    );
    await waitFor(
      () => world.publisher.ofKind(CI_ADVERTISEMENT_KIND).length === 1,
      'the advertisement'
    );
    await flush();
    expect(world.rec.out.join('\n')).toContain('one run');

    world.relay.push(
      manualTrigger('9'.repeat(40), OWNER, 2, {
        path: '.github/workflows/ci.yml',
        sha256: 'ab'.repeat(32),
      })
    );
    expect(await running).toBe(0);
    expect(world.runner.requests).toHaveLength(0);
    const kinds = world.publisher.publishedEvents
      .map((p) => p.event.kind)
      .filter((k) => k !== CI_ADVERTISEMENT_KIND);
    expect(kinds).toEqual([
      CI_WORKFLOW_PROGRESS_KIND,
      CI_WORKFLOW_RESULT_KIND,
      CI_WORKFLOW_PROGRESS_KIND,
    ]);
    const [result] = world.publisher
      .ofKind(CI_WORKFLOW_RESULT_KIND)
      .map((p) =>
        must(parseCiWorkflowResult(world.publisher.asRelayEvent(p, COORD)))
      );
    expect(result).toMatchObject({ conclusion: 'startup_failure', jobs: [] });
    const stopLine = world.rec.err.find((l) => l.includes('--once'));
    expect(stopLine).toContain('concluded startup_failure');
    expect(stopLine).toContain(`result ${must(result).eventId.slice(0, 8)}`);
  });
});

describe('rig ci serve: --requester (story 21)', () => {
  it('rejects a malformed requester (exit 2)', async () => {
    const rec = makeIo();
    expect(
      await runCiServe(
        ['--relay', RELAY, '--repo', REPO_FLAG, '--requester', 'nope'],
        { io: rec.io, env: {}, cwd: '/x' }
      )
    ).toBe(2);
    expect(rec.err[0]).toContain('--requester');
  });

  it("serves on an allowlisted stranger's request and reports the requesters", async () => {
    const world = makeServeWorld();
    // Only the STRANGER has asked; without --requester nothing would run.
    const { announce, refsEvent } = world.snapshot(1000);
    world.relay.serve([
      announce,
      refsEvent,
      signed(
        buildCiServiceRequest(repoAddress(OWNER, REPO), COORD, RELAY, 1100),
        STRANGER,
        7
      ),
    ]);
    const running = runCiServe(
      [
        '--relay',
        RELAY,
        '--repo',
        REPO_FLAG,
        '--requester',
        hexToNpub(STRANGER),
        '--json',
      ],
      world.deps
    );
    await waitFor(() => world.rec.json.length === 1, 'the JSON document');
    expect(world.rec.json[0]).toMatchObject({ requesters: [STRANGER] });
    world.push(2000);
    await waitFor(
      () => world.publisher.ofKind(CI_WORKFLOW_RESULT_KIND).length === 1,
      'the workflow result'
    );
    world.abort.abort();
    expect(await running).toBe(0);
  });
});

describe('rig ci serve: the wallet check (story 15)', () => {
  const RATES = { uploadFee: 1000n, uploadPerKib: 10n, eventFee: 5n };

  it('estimates a run as events × eventFee + uploads × the metered upload charge', () => {
    // 4 events × 5 + 1 upload × (1000 + 10 × (⌊sealed(64 KiB)/1024⌋ + 1))
    expect(estimateRunCost({ events: 4, uploads: 1, rates: RATES })).toBe(
      20n +
        1000n +
        10n *
          BigInt(Math.floor((Math.ceil((64 * 1024) / 3) * 4 + 704) / 1024) + 1)
    );
  });

  function recordChannel(
    home: string,
    identity: string,
    deposit: string,
    claimed: string
  ): void {
    const paths = resolveChannelPaths({ TOON_CLIENT_HOME: home });
    const store = new ChannelMapStore(paths);
    store.record({
      channelId: '0x' + '11'.repeat(32),
      peerId: 'nostr-test',
      identity,
      destination: 'g.toon.relay',
      chain: 'evm:31337',
      tokenNetwork: '0x' + '22'.repeat(20),
      context: {
        chainType: 'evm',
        chainId: 31337,
        tokenNetworkAddress: '0x' + '22'.repeat(20),
        tokenAddress: '0x' + '33'.repeat(20),
        recipient: '0x' + '44'.repeat(20),
      },
      depositTotal: deposit,
    });
    mkdirSync(dirname(paths.watermarkPath), { recursive: true });
    writeFileSync(
      paths.watermarkPath,
      JSON.stringify({
        ['0x' + '11'.repeat(32)]: { nonce: 3, cumulativeAmount: claimed },
      })
    );
  }

  it('refuses a run when the best open channel cannot cover it, and allows it when it can', async () => {
    const logs: string[] = [];
    const ctx = makeServeWorld().context;
    const home = tempDir('rig-ci-serve-wallet-');
    const check = makeAffordabilityCheck({
      ctx,
      env: { TOON_CLIENT_HOME: home },
      log: (l) => logs.push(l),
    });
    const estimate = { events: 4, uploads: 1, rates: RATES };
    const cost = estimateRunCost(estimate);

    recordChannel(home, COORD, (cost - 1n).toString(), '0');
    expect(await check(estimate)).toBe(false);
    expect(logs.at(-1)).toMatch(/wallet check: the best open channel has/);

    recordChannel(home, COORD, (cost + 500n).toString(), '500');
    expect(await check(estimate)).toBe(true);

    // Claimed past the deposit → nothing available.
    recordChannel(home, COORD, cost.toString(), (cost + 1n).toString());
    expect(await check(estimate)).toBe(false);
  });

  it('falls back to the wallet before any channel is recorded; unreadable or absent → refuse', async () => {
    const logs: string[] = [];
    const base = makeServeWorld().context;
    const home = tempDir('rig-ci-serve-wallet-');
    const estimate = { events: 4, uploads: 1, rates: RATES };
    const cost = estimateRunCost(estimate);
    const withWallet = (tokens: { symbol?: string; amount: string }[]) =>
      makeAffordabilityCheck({
        ctx: {
          ...base,
          money: {
            openChannel: async () => {
              throw new Error('unused');
            },
            closeChannel: async () => {
              throw new Error('unused');
            },
            settleChannel: async () => {
              throw new Error('unused');
            },
            walletChainBalances: async () => [
              { chain: 'evm', chainKey: 'evm:31337', address: '0x0', tokens },
            ],
          },
        },
        env: { TOON_CLIENT_HOME: home },
        log: (l) => logs.push(l),
      });

    expect(
      await withWallet([{ symbol: 'USDC', amount: (cost - 1n).toString() }])(
        estimate
      )
    ).toBe(false);
    expect(logs.at(-1)).toMatch(/no channel recorded yet/);
    expect(
      await withWallet([{ symbol: 'USDC', amount: cost.toString() }])(estimate)
    ).toBe(true);
    // A non-USDC token never counts.
    expect(
      await withWallet([{ symbol: 'ETH', amount: (cost * 10n).toString() }])(
        estimate
      )
    ).toBe(false);

    // No wallet reader at all → refuse.
    const noMoney = makeAffordabilityCheck({
      ctx: base,
      env: { TOON_CLIENT_HOME: home },
      log: (l) => logs.push(l),
    });
    expect(await noMoney(estimate)).toBe(false);
    expect(logs.at(-1)).toMatch(/no wallet reader/);

    // Unreadable wallet → refuse.
    const broken = makeAffordabilityCheck({
      ctx: {
        ...base,
        money: {
          openChannel: async () => {
            throw new Error('unused');
          },
          closeChannel: async () => {
            throw new Error('unused');
          },
          settleChannel: async () => {
            throw new Error('unused');
          },
          walletChainBalances: async () => {
            throw new Error('rpc down');
          },
        },
      },
      env: { TOON_CLIENT_HOME: home },
      log: (l) => logs.push(l),
    });
    expect(await broken(estimate)).toBe(false);
    expect(logs.at(-1)).toMatch(/wallet unreadable \(rpc down\)/);
  });

  it('is wired into serve by default: an empty home with no wallet reader starts no run and says why on stderr', async () => {
    const world = makeServeWorld();
    delete world.deps.canAfford;
    const running = runCiServe(
      ['--relay', RELAY, '--repo', REPO_FLAG],
      world.deps
    );
    await waitFor(
      () => world.publisher.ofKind(CI_ADVERTISEMENT_KIND).length === 1,
      'the advertisement'
    );
    world.push(2000);
    await waitFor(
      () => world.rec.err.some((l) => l.includes('wallet check')),
      'the wallet refusal'
    );
    await flush();
    expect(world.publisher.ofKind(CI_WORKFLOW_RESULT_KIND)).toHaveLength(0);
    expect(world.runner.requests).toHaveLength(0);
    expect(world.rec.err.some((l) => l.includes('wallet cannot cover'))).toBe(
      true
    );
    world.abort.abort();
    expect(await running).toBe(0);
  });
});
