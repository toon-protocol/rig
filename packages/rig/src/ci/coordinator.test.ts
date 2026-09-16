/**
 * Coordinator loop tests (#125): scripted relay events go in, the NIP-C1
 * event sequence comes out of a fake Publisher. A REAL source repository
 * (with a workflow file) is served through the mock gateway so the free read
 * path is exercised end to end; the FakeRunner scripts outcomes; a fake
 * clock drives every timer, so nothing here sleeps.
 */

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearShaCache } from '@toon-protocol/arweave';
import type { NostrEvent } from '../remote-state.js';
import {
  makeMockGateway,
  repoStateEvents,
  storeFromObjects,
  type EnumeratedObject,
} from '../cli/read-testkit.js';
import {
  fakeClock,
  fakePublisher,
  flush,
  makeScriptedRelay,
  waitFor,
  type FakePublisher,
} from './ci-testkit.js';
import {
  startCoordinator,
  logTail,
  movedRefs,
  type CoordinatorHandle,
  type CoordinatorOptions,
} from './coordinator.js';
import {
  CI_ADVERTISEMENT_KIND,
  CI_JOB_RESULT_KIND,
  CI_WORKFLOW_PROGRESS_KIND,
  CI_WORKFLOW_RESULT_KIND,
  buildCiManualTrigger,
  buildCiSecretUpdate,
  buildCiServiceRequest,
  buildCiServiceStop,
  parseCiAdvertisement,
  parseCiJobResult,
  parseCiWorkflowProgress,
  parseCiWorkflowResult,
  repoAddress,
} from './nip-c1-events.js';
import {
  FakeRunner,
  type RunnerRequest,
  type RunnerRunResult,
} from './runner.js';
import { encryptSecretUpdate, generateSecretsKey } from './secrets.js';
import { cursorPath } from './state.js';
import { sha256Hex } from './workflows.js';

const OWNER = 'ab'.repeat(32);
const MAINT = 'cd'.repeat(32);
const STRANGER = 'ef'.repeat(32);
const COORD = '12'.repeat(32);
const REPO = 'demo';
const ADDR = repoAddress(OWNER, REPO);
const RELAY = 'wss://relay.test.example';
const GATEWAY = 'http://gateway.test:3000';

const WORKFLOW = `name: ci
on:
  push:
    branches: [main]
  pull_request:
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo hello
`;

/** A second workflow that only answers tag moves (`on: push: tags`). */
const RELEASE_WORKFLOW = `name: release
on:
  push:
    tags: ['v*']
jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - run: echo release
`;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

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

let eventCounter = 0;
function eventId(): string {
  eventCounter += 1;
  return eventCounter.toString(16).padStart(64, '0');
}

function signed(
  event: {
    kind: number;
    tags: string[][];
    content: string;
    created_at: number;
  },
  pubkey: string,
  id = eventId()
): NostrEvent {
  return { id, pubkey, sig: 'f0'.repeat(64), ...event };
}

interface World {
  srcDir: string;
  store: Map<string, Uint8Array>;
  relay: ReturnType<typeof makeScriptedRelay>;
  publisher: FakePublisher;
  clock: ReturnType<typeof fakeClock>;
  runner: FakeRunner;
  logs: string[];
  stateDir: string;
  workdir: string;
  /** Build a 30617 + 30618 snapshot of the source repo at `createdAt` and load its objects. */
  snapshot(createdAt: number): { announce: NostrEvent; refsEvent: NostrEvent };
  /** Commit a change on the current branch of the source repo. */
  commit(file: string, content: string, message: string): string;
  start(overrides?: Partial<CoordinatorOptions>): Promise<CoordinatorHandle>;
}

function makeWorld(): World {
  const srcDir = tempDir('rig-ci-coord-src-');
  git(['init', '--initial-branch=main'], srcDir);
  mkdirSync(join(srcDir, '.github', 'workflows'), { recursive: true });
  writeFileSync(join(srcDir, '.github', 'workflows', 'ci.yml'), WORKFLOW);
  writeFileSync(join(srcDir, 'README.md'), '# demo\n');
  git(['add', '.'], srcDir);
  git(['commit', '-m', 'initial'], srcDir);

  const store = new Map<string, Uint8Array>();
  const gateway = makeMockGateway(store);
  const relay = makeScriptedRelay();
  const publisher = fakePublisher();
  const clock = fakeClock();
  const runner = new FakeRunner();
  const logs: string[] = [];
  const stateDir = join(tempDir('rig-ci-coord-state-'), 'state');
  const workdir = tempDir('rig-ci-coord-work-');

  const load = (objects: EnumeratedObject[]): void => {
    for (const [tx, bytes] of storeFromObjects(objects)) store.set(tx, bytes);
  };

  const world: World = {
    srcDir,
    store,
    relay,
    publisher,
    clock,
    runner,
    logs,
    stateDir,
    workdir,
    snapshot(createdAt) {
      const { announce, refsEvent, objects } = repoStateEvents({
        repoDir: srcDir,
        owner: OWNER,
        repoId: REPO,
        createdAt,
      });
      load(objects);
      announce.tags.push(['maintainers', MAINT]);
      return { announce, refsEvent };
    },
    commit(file, content, message) {
      writeFileSync(join(srcDir, file), content);
      git(['add', '.'], srcDir);
      git(['commit', '-m', message], srcDir);
      return git(['rev-parse', 'HEAD'], srcDir);
    },
    async start(overrides = {}) {
      const handle = await startCoordinator({
        coordinatorPubkey: COORD,
        publisher,
        relayUrl: RELAY,
        gatewayUrl: GATEWAY,
        repos: [{ ownerPubkey: OWNER, repoId: REPO }],
        runner,
        stateDir,
        workdir,
        version: '9.9.9-test',
        webSocketFactory: relay.factory,
        fetchFn: gateway.fetchFn,
        resolveSha: async () => null,
        clock: clock.now,
        scheduler: clock.scheduler,
        log: (line) => logs.push(line),
        ...overrides,
      });
      await flush();
      return handle;
    },
  };
  return world;
}

function serviceRequest(from: string, createdAt: number): NostrEvent {
  return signed(buildCiServiceRequest(ADDR, COORD, RELAY, createdAt), from);
}
function serviceStop(from: string, createdAt: number): NostrEvent {
  return signed(buildCiServiceStop(ADDR, COORD, RELAY, createdAt), from);
}

/** Kinds of every published event, in order (advertisement excluded). */
function publishedKinds(publisher: FakePublisher): number[] {
  return publisher.publishedEvents
    .map((p) => p.event.kind)
    .filter((k) => k !== CI_ADVERTISEMENT_KIND);
}

function progressEvents(publisher: FakePublisher, pubkey = COORD) {
  return publisher
    .ofKind(CI_WORKFLOW_PROGRESS_KIND)
    .map((p) =>
      must(
        parseCiWorkflowProgress(publisher.asRelayEvent(p, pubkey)),
        'a parseable 39842'
      )
    );
}

function resultEvents(publisher: FakePublisher, pubkey = COORD) {
  return publisher
    .ofKind(CI_WORKFLOW_RESULT_KIND)
    .map((p) =>
      must(
        parseCiWorkflowResult(publisher.asRelayEvent(p, pubkey)),
        'a parseable 9842'
      )
    );
}

function jobEvents(publisher: FakePublisher, pubkey = COORD) {
  return publisher
    .ofKind(CI_JOB_RESULT_KIND)
    .map((p) =>
      must(
        parseCiJobResult(publisher.asRelayEvent(p, pubkey)),
        'a parseable 9841'
      )
    );
}

/** A push: commit on the source repo, publish the new 30618 live. */
function push(
  world: World,
  createdAt: number,
  file = 'code.txt',
  content = 'v2\n'
): string {
  const sha = world.commit(file, content, `change ${createdAt}`);
  const { refsEvent } = world.snapshot(createdAt);
  world.relay.push(refsEvent);
  return sha;
}

/** A blocking runner script: resolves when `release()` is called or the signal aborts. */
function blockingRunner(): {
  runner: FakeRunner;
  release(result?: Partial<RunnerRunResult>): void;
  started: RunnerRequest[];
} {
  let releasers: ((r: RunnerRunResult) => void)[] = [];
  const started: RunnerRequest[] = [];
  const runner = new FakeRunner(
    (request) =>
      new Promise<RunnerRunResult>((resolve) => {
        started.push(request);
        const done = (conclusion: RunnerRunResult['conclusion']) =>
          resolve({ conclusion, jobs: [], startedAt: 1, finishedAt: 2 });
        request.signal?.addEventListener('abort', () => done('cancelled'), {
          once: true,
        });
        releasers.push((r) => resolve(r));
      })
  );
  return {
    runner,
    started,
    release(result = {}) {
      const next = releasers.shift();
      next?.({
        conclusion: 'success',
        jobs: [
          {
            jobId: 'build',
            name: 'build',
            conclusion: 'success',
            exitCode: 0,
            startedAt: 1,
            finishedAt: 2,
            log: 'ok\n',
            artifacts: [],
          },
        ],
        startedAt: 1,
        finishedAt: 2,
        ...result,
      });
      releasers = releasers.filter((r) => r !== next);
    },
  };
}

beforeEach(() => {
  eventCounter = 0;
});

// ---------------------------------------------------------------------------
// Advertisement + first sight
// ---------------------------------------------------------------------------

describe('startCoordinator: advertisement and first sight of a repo', () => {
  it('advertises itself per NIP-C1 (act, maintainer-request, request-required, out-of-band, secrets-key)', async () => {
    const world = makeWorld();
    const { announce, refsEvent } = world.snapshot(1000);
    world.relay.serve([announce, refsEvent]);
    const handle = await world.start();

    const ads = world.publisher.ofKind(CI_ADVERTISEMENT_KIND);
    expect(ads).toHaveLength(1);
    const ad = parseCiAdvertisement(
      world.publisher.asRelayEvent(must(ads[0]), COORD)
    );
    expect(ad).toMatchObject({
      version: '9.9.9-test',
      families: ['act'],
      selectors: ['act:ubuntu-latest'],
      admission: 'maintainer-request',
      execution: 'request-required',
      billing: 'out-of-band',
      secretsKey: { pubkey: handle.secretsKeyPubkey, inboxRelays: [RELAY] },
    });
    expect(must(ad).expiresAt - must(ad).createdAt).toBeLessThanOrEqual(1800);
    expect(handle.advertisementId).toBe(must(ads[0]).eventId);
    expect(must(ads[0]).event.tags).toContainEqual([
      'software',
      'rig',
      '9.9.9-test',
    ]);

    // Existing refs are recorded, nothing runs, the cursor is on disk.
    expect(publishedKinds(world.publisher)).toEqual([]);
    const cursor = JSON.parse(
      readFileSync(cursorPath(world.stateDir), 'utf-8')
    );
    expect(cursor.repos[ADDR].refs['refs/heads/main']).toBe(
      git(['rev-parse', 'HEAD'], world.srcDir)
    );
    expect(handle.serving()).toEqual([{ repoAddr: ADDR, serving: false }]);
    await handle.stop();
  });

  it('renews the advertisement before it expires', async () => {
    const world = makeWorld();
    const { announce, refsEvent } = world.snapshot(1000);
    world.relay.serve([announce, refsEvent]);
    const handle = await world.start();
    world.clock.advance(26 * 60 * 1000);
    await flush();
    expect(world.publisher.ofKind(CI_ADVERTISEMENT_KIND)).toHaveLength(2);
    await handle.stop();
  });
});

// ---------------------------------------------------------------------------
// Push runs — the full NIP-C1 sequence
// ---------------------------------------------------------------------------

describe('push trigger', () => {
  it('runs a maintainer-requested repo: queued → in_progress → 9841 → 9842 → concluded', async () => {
    const world = makeWorld();
    const { announce, refsEvent } = world.snapshot(1000);
    world.relay.serve([announce, refsEvent, serviceRequest(MAINT, 1100)]);
    const handle = await world.start();
    expect(handle.serving()).toEqual([{ repoAddr: ADDR, serving: true }]);

    const sha = push(world, 2000);
    await handle.idle();

    expect(publishedKinds(world.publisher)).toEqual([
      39842, // queued
      39842, // in_progress
      9841, // build
      39842, // in_progress, quoting build
      9842, // result
      39842, // concluded
    ]);

    const [queued, inProgress, withJob, concluded] = progressEvents(
      world.publisher
    );
    expect(queued).toMatchObject({ status: 'queued', queue: 1, jobs: [] });
    // A queued standing-service marker MUST omit the service-request quote.
    expect(must(queued).provenance).toBeUndefined();
    expect(must(queued).trigger).toMatchObject({
      repoAddr: ADDR,
      commit: sha,
      workflow: {
        path: '.github/workflows/ci.yml',
        sha256: sha256Hex(WORKFLOW),
      },
      reason: 'push',
      ref: 'refs/heads/main',
    });
    expect(must(queued).runId).toBe(must(inProgress).runId);
    expect(inProgress).toMatchObject({
      status: 'in_progress',
      inProgress: ['build'],
      provenance: { kind: 'service-request', relayUrl: RELAY, pubkey: MAINT },
    });
    expect(must(withJob).jobs).toHaveLength(1);
    expect(must(withJob).inProgress).toEqual([]);
    expect(concluded).toMatchObject({
      status: 'concluded',
      conclusion: 'success',
      runId: must(queued).runId,
    });

    const [job] = jobEvents(world.publisher);
    expect(job).toMatchObject({
      jobId: 'build',
      conclusion: 'success',
      exitCode: 0,
      progressAddress: `39842:${COORD}:${must(queued).runId}`,
      logsUrl: `${GATEWAY}/raw/tx-1`,
      logOmittedBytes: 0,
      runsOn: ['ubuntu-latest'],
    });
    expect(must(job).logTail).toContain(
      'fake runner: ran .github/workflows/ci.yml'
    );
    expect(world.publisher.uploadedBlobs[0]).toMatchObject({
      contentType: 'text/plain; charset=utf-8',
      repoId: REPO,
    });

    const [result] = resultEvents(world.publisher);
    expect(result).toMatchObject({
      runId: must(queued).runId,
      conclusion: 'success',
      provenance: { kind: 'service-request', pubkey: MAINT },
      jobs: [
        {
          eventId: must(job).eventId,
          relayUrl: RELAY,
          pubkey: COORD,
          jobId: 'build',
        },
      ],
    });
    expect(must(result).trigger.commit).toBe(sha);

    // The runner got a real checkout at the commit, no secrets (none set).
    const request = must(world.runner.requests[0]);
    expect(request.secrets).toEqual({});
    expect(request.trigger.commit).toBe(sha);
    expect(request.workflow.path).toBe('.github/workflows/ci.yml');
    // Cleaned up after the run.
    expect(existsSync(request.checkoutDir)).toBe(false);

    // Every paid write went to the one relay.
    for (const p of world.publisher.publishedEvents)
      expect(p.relayUrls).toEqual([RELAY]);
    await handle.stop();
  });

  it('runs nothing for a repo without a maintainer Service Request (a stranger asking does not count)', async () => {
    const world = makeWorld();
    const { announce, refsEvent } = world.snapshot(1000);
    world.relay.serve([announce, refsEvent, serviceRequest(STRANGER, 1100)]);
    const handle = await world.start();

    push(world, 2000);
    await handle.idle();
    expect(publishedKinds(world.publisher)).toEqual([]);
    expect(world.runner.requests).toHaveLength(0);
    expect(
      world.logs.some((l) => l.includes('no maintainer Service Request'))
    ).toBe(true);
    await handle.stop();
  });

  it('a maintainer Stop closes service; a stranger Stop does not', async () => {
    const world = makeWorld();
    const { announce, refsEvent } = world.snapshot(1000);
    world.relay.serve([
      announce,
      refsEvent,
      serviceRequest(MAINT, 1100),
      serviceStop(STRANGER, 1200),
    ]);
    const handle = await world.start();
    expect(must(handle.serving()[0]).serving).toBe(true);

    world.relay.push(serviceStop(MAINT, 1300));
    await handle.idle();
    expect(must(handle.serving()[0]).serving).toBe(false);

    push(world, 2000);
    await handle.idle();
    expect(world.runner.requests).toHaveLength(0);

    // A later Request makes service eligible again.
    world.relay.push(serviceRequest(OWNER, 2100));
    await handle.idle();
    expect(must(handle.serving()[0]).serving).toBe(true);
    push(world, 2200, 'again.txt', 'x\n');
    await handle.idle();
    expect(world.runner.requests).toHaveLength(1);
    await handle.stop();
  });

  it('does not run a push that only moved a ref the workflow ignores', async () => {
    const world = makeWorld();
    const { announce, refsEvent } = world.snapshot(1000);
    world.relay.serve([announce, refsEvent, serviceRequest(MAINT, 1100)]);
    const handle = await world.start();

    git(['checkout', '-q', '-b', 'topic'], world.srcDir);
    push(world, 2000, 'topic.txt', 't\n');
    await handle.idle();
    expect(world.runner.requests).toHaveLength(0);
    expect(publishedKinds(world.publisher)).toEqual([]);
    await handle.stop();
  });

  it('a 30618 whose refs did not move — an arweave-map-only republish, or a byte-identical one — runs nothing but advances the cursor (#129)', async () => {
    const world = makeWorld();
    const { announce, refsEvent } = world.snapshot(1000);
    world.relay.serve([announce, refsEvent, serviceRequest(MAINT, 1100)]);
    const handle = await world.start();
    const tip = git(['rev-parse', 'HEAD'], world.srcDir);

    // The owner re-uploads: same refs, later created_at, a different arweave map.
    const { refsEvent: reuploaded } = repoStateEvents({
      repoDir: world.srcDir,
      owner: OWNER,
      repoId: REPO,
      createdAt: 2000,
      arweaveMap: new Map([[tip, 'tx-reuploaded']]),
    });
    expect(reuploaded.id).not.toBe(refsEvent.id);
    expect(reuploaded.tags.filter((t) => t[0] === 'r')).toEqual(
      refsEvent.tags.filter((t) => t[0] === 'r')
    );
    expect(reuploaded.tags).toContainEqual(['arweave', tip, 'tx-reuploaded']);
    world.relay.push(reuploaded);
    await handle.idle();

    // Then a byte-identical 30618 (same refs, same map), only later.
    const { refsEvent: identical } = world.snapshot(2500);
    world.relay.push(identical);
    await handle.idle();

    expect(world.runner.requests).toHaveLength(0);
    expect(publishedKinds(world.publisher)).toEqual([]);
    // Both events are recorded as processed; the cursor moved on.
    const cursor = JSON.parse(
      readFileSync(cursorPath(world.stateDir), 'utf-8')
    );
    expect(cursor.repos[ADDR].lastCreatedAt).toBe(2500);
    expect(cursor.repos[ADDR].lastEventId).toBe(identical.id);
    expect(cursor.repos[ADDR].processed).toEqual(
      expect.arrayContaining([reuploaded.id, identical.id])
    );
    expect(cursor.repos[ADDR].refs['refs/heads/main']).toBe(tip);

    // A real branch move afterwards still runs, exactly once.
    push(world, 3000);
    await handle.idle();
    expect(world.runner.requests).toHaveLength(1);
    expect(resultEvents(world.publisher)).toHaveLength(1);
    await handle.stop();
  });

  it('a tag move runs only the workflows whose on: push filter matches refs/tags, tagged o=push and r=refs/tags/… (#129)', async () => {
    const world = makeWorld();
    writeFileSync(
      join(world.srcDir, '.github', 'workflows', 'release.yml'),
      RELEASE_WORKFLOW
    );
    git(['add', '.'], world.srcDir);
    git(['commit', '-m', 'add release workflow'], world.srcDir);
    const { announce, refsEvent } = world.snapshot(1000);
    world.relay.serve([announce, refsEvent, serviceRequest(MAINT, 1100)]);
    const handle = await world.start();

    // Tag the tip: the only ref that moves is refs/tags/v1.
    git(['tag', 'v1'], world.srcDir);
    const tip = git(['rev-parse', 'HEAD'], world.srcDir);
    const { refsEvent: tagged } = world.snapshot(2000);
    expect(tagged.tags).toContainEqual(['r', 'refs/tags/v1', tip]);
    world.relay.push(tagged);
    await handle.idle();

    // ci.yml (branches: [main]) is skipped; release.yml (tags: ['v*']) runs.
    expect(world.runner.requests.map((r) => r.workflow.path)).toEqual([
      '.github/workflows/release.yml',
    ]);
    expect(must(world.runner.requests[0]).trigger).toMatchObject({
      reason: 'push',
      ref: 'refs/tags/v1',
      commit: tip,
    });
    expect(publishedKinds(world.publisher)).toEqual([
      39842, 39842, 9841, 39842, 9842, 39842,
    ]);
    const [result] = resultEvents(world.publisher);
    expect(must(result).trigger).toMatchObject({
      reason: 'push',
      ref: 'refs/tags/v1',
      workflow: {
        path: '.github/workflows/release.yml',
        sha256: sha256Hex(RELEASE_WORKFLOW),
      },
    });
    // The raw event carries `o = push` and `r = refs/tags/v1` (plus the run-id r).
    const raw = must(world.publisher.ofKind(CI_WORKFLOW_RESULT_KIND)[0]).event
      .tags;
    expect(raw).toContainEqual(['o', 'push']);
    expect(raw).toContainEqual(['r', 'refs/tags/v1']);
    // The in_progress marker names release.yml's declared job, not ci.yml's.
    expect(must(progressEvents(world.publisher)[1])).toMatchObject({
      status: 'in_progress',
      inProgress: ['publish'],
    });
    expect(must(jobEvents(world.publisher)[0]).logTail).toContain(
      'ran .github/workflows/release.yml'
    );

    // A branch move on main afterwards runs only ci.yml.
    push(world, 3000);
    await handle.idle();
    expect(world.runner.requests.map((r) => r.workflow.path)).toEqual([
      '.github/workflows/release.yml',
      '.github/workflows/ci.yml',
    ]);
    expect(must(world.runner.requests[1]).trigger).toMatchObject({
      reason: 'push',
      ref: 'refs/heads/main',
    });
    await handle.stop();
  });

  it('refuses to start a run when fee rates cannot be read — nothing is published', async () => {
    const world = makeWorld();
    const { announce, refsEvent } = world.snapshot(1000);
    world.relay.serve([announce, refsEvent, serviceRequest(MAINT, 1100)]);
    const handle = await world.start();
    world.publisher.feeRatesError = 'channel has no funds';

    push(world, 2000);
    await handle.idle();
    expect(publishedKinds(world.publisher)).toEqual([]);
    expect(world.runner.requests).toHaveLength(0);
    expect(world.logs.some((l) => l.includes('cannot read fee rates'))).toBe(
      true
    );
    await handle.stop();
  });

  it('refuses a run the affordability seam declines', async () => {
    const world = makeWorld();
    const { announce, refsEvent } = world.snapshot(1000);
    world.relay.serve([announce, refsEvent, serviceRequest(MAINT, 1100)]);
    const seen: number[] = [];
    const handle = await world.start({
      canAfford: async (estimate) => {
        seen.push(estimate.events);
        return false;
      },
    });
    push(world, 2000);
    await handle.idle();
    expect(seen).toEqual([6]); // 4 + 2 × 1 job
    expect(publishedKinds(world.publisher)).toEqual([]);
    await handle.stop();
  });

  it('publishes startup_failure for a workflow that does not parse', async () => {
    const world = makeWorld();
    const { announce, refsEvent } = world.snapshot(1000);
    world.relay.serve([announce, refsEvent, serviceRequest(MAINT, 1100)]);
    const handle = await world.start();

    push(world, 2000, '.github/workflows/broken.yml', 'on: [\n');
    await handle.idle();
    const results = resultEvents(world.publisher);
    const broken = results.find((r) =>
      must(r).trigger.workflow.path.endsWith('broken.yml')
    );
    expect(broken).toMatchObject({ conclusion: 'startup_failure', jobs: [] });
    // ci.yml still ran normally alongside it.
    expect(
      results.find((r) => r.trigger.workflow.path.endsWith('ci.yml'))
    ).toMatchObject({ conclusion: 'success' });
    await handle.stop();
  });
});

// ---------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------

/** A kind:29846 update from `author`, encrypted to the coordinator's current secrets-key. */
function secretUpdate(
  world: World,
  handle: CoordinatorHandle,
  author: string,
  set: Record<string, string>,
  remove: string[] = []
) {
  const sender = generateSecretsKey();
  const created_at = world.clock.now();
  const ciphertext = encryptSecretUpdate(
    { author, created_at, set, remove },
    sender.secretKey,
    handle.secretsKeyPubkey
  );
  return signed(
    buildCiSecretUpdate({
      // NIP-C1: the maintainer's OWN perspective, signer == its pubkey.
      repoAddr: repoAddress(author, REPO),
      coordinatorPubkey: COORD,
      advertisementId: handle.advertisementId as string,
      advertisementRelayHint: RELAY,
      senderPubkey: sender.pubkey,
      recipientPubkey: handle.secretsKeyPubkey,
      ciphertext,
      createdAt: created_at,
    }),
    author
  );
}

describe('secrets', () => {
  it('injects a maintainer-provisioned secret into a maintainer push, never into a stranger PR', async () => {
    const world = makeWorld();
    const { announce, refsEvent } = world.snapshot(1000);
    world.relay.serve([announce, refsEvent, serviceRequest(MAINT, 1100)]);
    const handle = await world.start();

    world.relay.push(
      secretUpdate(world, handle, MAINT, { DEPLOY_TOKEN: 'hunter2' })
    );
    await handle.idle();
    expect(world.logs.some((l) => l.includes('secrets updated'))).toBe(true);
    // Persisted (value on disk under the state dir, as the spec allows).
    expect(
      readFileSync(join(world.stateDir, 'secrets.json'), 'utf-8')
    ).toContain('hunter2');

    const base = push(world, 2000);
    await handle.idle();
    expect(must(world.runner.requests[0]).secrets).toEqual({
      DEPLOY_TOKEN: 'hunter2',
    });

    // A stranger's kind:1617 patch against `base`: runs, but with NO secrets.
    const contrib = tempDir('rig-ci-coord-contrib-');
    git(['clone', '-q', world.srcDir, '.'], contrib);
    writeFileSync(join(contrib, 'pr.txt'), 'from a stranger\n');
    git(['add', '.'], contrib);
    git(['commit', '-m', 'stranger change'], contrib);
    const declaredTip = git(['rev-parse', 'HEAD'], contrib);
    const patchText = git(
      ['format-patch', '--stdout', `${base}..HEAD`],
      contrib
    );
    const patch = signed(
      {
        kind: 1617,
        content: patchText,
        created_at: 2500,
        tags: [
          ['a', ADDR],
          ['p', OWNER],
          ['subject', 'stranger change'],
          ['commit', declaredTip],
          ['parent-commit', base],
        ],
      },
      STRANGER
    );
    world.relay.push(patch);
    await handle.idle();

    const prRequest = must(world.runner.requests[1]);
    expect(prRequest.secrets).toEqual({});
    expect(prRequest.trigger).toMatchObject({
      reason: 'pull_request',
      pr: {
        prEventId: patch.id,
        prAuthor: STRANGER,
        prKind: 1617,
        sourceKind: 1617,
      },
    });
    expect(prRequest.trigger.ref).toBeUndefined();
    // The run's commit is the `git am` result; the declared tip is kept as a second `c`.
    expect(prRequest.trigger.commit).not.toBe(declaredTip);
    expect(prRequest.trigger.tagObjectIds).toEqual([declaredTip]);
    const prResult = resultEvents(world.publisher).find(
      (r) => r.trigger.reason === 'pull_request'
    );
    expect(must(prResult).trigger.pr).toMatchObject({ prEventId: patch.id });
    expect(must(prResult).trigger.commit).toBe(prRequest.trigger.commit);

    // Remove: the tombstone wins and the value stops being injected.
    world.clock.advance(1000);
    world.relay.push(secretUpdate(world, handle, MAINT, {}, ['DEPLOY_TOKEN']));
    await handle.idle();
    push(world, 3000, 'later.txt', 'l\n');
    await handle.idle();
    expect(must(world.runner.requests[2]).secrets).toEqual({});
    await handle.stop();
  });

  it('rejects secret updates from non-maintainers, stale keys, and mismatched bindings', async () => {
    const world = makeWorld();
    const { announce, refsEvent } = world.snapshot(1000);
    world.relay.serve([announce, refsEvent, serviceRequest(MAINT, 1100)]);
    const handle = await world.start();

    world.relay.push(secretUpdate(world, handle, STRANGER, { X: '1' }));
    // Encrypted to a key that is not the advertised one.
    const other = generateSecretsKey();
    const sender = generateSecretsKey();
    const created_at = world.clock.now();
    world.relay.push(
      signed(
        buildCiSecretUpdate({
          repoAddr: repoAddress(MAINT, REPO),
          coordinatorPubkey: COORD,
          advertisementId: handle.advertisementId as string,
          senderPubkey: sender.pubkey,
          recipientPubkey: other.pubkey,
          ciphertext: encryptSecretUpdate(
            { author: MAINT, created_at, set: { Y: '2' }, remove: [] },
            sender.secretKey,
            other.pubkey
          ),
          createdAt: created_at,
        }),
        MAINT
      )
    );
    // Plaintext author does not match the signer (a re-signed capture).
    const forgedSender = generateSecretsKey();
    world.relay.push(
      signed(
        buildCiSecretUpdate({
          repoAddr: repoAddress(MAINT, REPO),
          coordinatorPubkey: COORD,
          advertisementId: handle.advertisementId as string,
          senderPubkey: forgedSender.pubkey,
          recipientPubkey: handle.secretsKeyPubkey,
          ciphertext: encryptSecretUpdate(
            { author: OWNER, created_at, set: { Z: '3' }, remove: [] },
            forgedSender.secretKey,
            handle.secretsKeyPubkey
          ),
          createdAt: created_at,
        }),
        MAINT
      )
    );
    await handle.idle();

    push(world, 2000);
    await handle.idle();
    expect(must(world.runner.requests[0]).secrets).toEqual({});
    expect(
      world.logs.filter((l) => /ignored|rejected|stale/.test(l)).length
    ).toBeGreaterThanOrEqual(3);
    await handle.stop();
  });
});

// ---------------------------------------------------------------------------
// Timeout, concurrency, cancellation
// ---------------------------------------------------------------------------

describe('run execution bounds', () => {
  it('concludes timed_out when the wall clock runs out', async () => {
    const world = makeWorld();
    const { announce, refsEvent } = world.snapshot(1000);
    world.relay.serve([announce, refsEvent, serviceRequest(MAINT, 1100)]);
    const blocking = blockingRunner();
    const handle = await world.start({
      runner: blocking.runner,
      timeoutMs: 60_000,
    });

    push(world, 2000);
    await waitFor(() => blocking.started.length === 1, 'the run to start');
    await flush();
    expect(progressEvents(world.publisher).map((p) => p.status)).toEqual([
      'queued',
      'in_progress',
    ]);

    world.clock.advance(60_001);
    await handle.idle();
    expect(must(blocking.started[0]).signal?.aborted).toBe(true);
    expect(resultEvents(world.publisher)[0]).toMatchObject({
      conclusion: 'timed_out',
    });
    expect(progressEvents(world.publisher).at(-1)).toMatchObject({
      status: 'concluded',
      conclusion: 'timed_out',
    });
    await handle.stop();
  });

  it('bounds concurrency and reports queue rounds', async () => {
    const world = makeWorld();
    const { announce, refsEvent } = world.snapshot(1000);
    world.relay.serve([announce, refsEvent, serviceRequest(MAINT, 1100)]);
    const blocking = blockingRunner();
    const handle = await world.start({
      runner: blocking.runner,
      concurrency: 1,
    });

    // One 30618 that moved two branches → two triggers → two runs.
    world.commit('a.txt', 'a\n', 'on main');
    git(['checkout', '-q', '-b', 'main-2'], world.srcDir);
    world.commit('b.txt', 'b\n', 'on main-2');
    git(['checkout', '-q', 'main'], world.srcDir);
    // main-2 needs a push trigger too: widen the workflow's branch filter? No —
    // `branches: [main]` ignores it, so move main twice instead via two events.
    const { refsEvent: second } = world.snapshot(2000);
    world.relay.push(second);
    await waitFor(
      () => blocking.started.length === 1,
      'the first run to start'
    );
    world.commit('c.txt', 'c\n', 'again on main');
    const { refsEvent: third } = world.snapshot(2100);
    world.relay.push(third);
    await waitFor(
      () =>
        progressEvents(world.publisher).filter((p) => p.status === 'queued')
          .length === 2,
      'the second run to queue'
    );

    expect(blocking.started).toHaveLength(1);
    const queued = progressEvents(world.publisher).filter(
      (p) => p.status === 'queued'
    );
    expect(queued.map((q) => q.queue)).toEqual([1, 2]);

    blocking.release();
    await waitFor(
      () => blocking.started.length === 2,
      'the second run to start'
    );
    blocking.release();
    await handle.idle();
    expect(resultEvents(world.publisher).map((r) => r.conclusion)).toEqual([
      'success',
      'success',
    ]);
    await handle.stop();
  });

  it('cancels an active run on stop and publishes cancelled', async () => {
    const world = makeWorld();
    const { announce, refsEvent } = world.snapshot(1000);
    world.relay.serve([announce, refsEvent, serviceRequest(MAINT, 1100)]);
    const blocking = blockingRunner();
    const handle = await world.start({ runner: blocking.runner });
    push(world, 2000);
    await waitFor(() => blocking.started.length === 1, 'the run to start');

    await handle.stop();
    expect(resultEvents(world.publisher)[0]).toMatchObject({
      conclusion: 'cancelled',
    });
  });

  it('cancels a queued run whose service was stopped before handoff', async () => {
    const world = makeWorld();
    const { announce, refsEvent } = world.snapshot(1000);
    world.relay.serve([announce, refsEvent, serviceRequest(MAINT, 1100)]);
    const blocking = blockingRunner();
    const handle = await world.start({
      runner: blocking.runner,
      concurrency: 1,
    });
    push(world, 2000);
    await waitFor(
      () => blocking.started.length === 1,
      'the first run to start'
    );
    push(world, 2100, 'd.txt', 'd\n');
    await waitFor(
      () =>
        progressEvents(world.publisher).filter((p) => p.status === 'queued')
          .length === 2,
      'the second run to queue'
    );
    world.relay.push(serviceStop(MAINT, 2200));
    await flush();
    blocking.release();
    await handle.idle();
    expect(resultEvents(world.publisher).map((r) => r.conclusion)).toEqual([
      'success',
      'cancelled',
    ]);
    await handle.stop();
  });
});

// ---------------------------------------------------------------------------
// Manual triggers
// ---------------------------------------------------------------------------

describe('manual trigger (kind:9840)', () => {
  it('replays the exact workflow with o=manual and a manual-trigger quote; a sha mismatch is ignored', async () => {
    const world = makeWorld();
    const { announce, refsEvent } = world.snapshot(1000);
    world.relay.serve([announce, refsEvent]); // NO standing request needed
    const handle = await world.start();
    const commit = git(['rev-parse', 'HEAD'], world.srcDir);

    // Wrong sha → ignored, nothing published.
    world.relay.push(
      signed(
        buildCiManualTrigger(
          COORD,
          {
            repoAddr: ADDR,
            commit,
            workflow: {
              path: '.github/workflows/ci.yml',
              sha256: 'ff'.repeat(32),
            },
            ref: 'refs/heads/main',
          },
          1500
        ),
        MAINT
      )
    );
    await handle.idle();
    expect(publishedKinds(world.publisher)).toEqual([]);
    expect(world.logs.some((l) => l.includes('manual trigger ignored'))).toBe(
      true
    );

    // Non-maintainer → ignored.
    world.relay.push(
      signed(
        buildCiManualTrigger(
          COORD,
          {
            repoAddr: ADDR,
            commit,
            workflow: {
              path: '.github/workflows/ci.yml',
              sha256: sha256Hex(WORKFLOW),
            },
          },
          1600
        ),
        STRANGER
      )
    );
    await handle.idle();
    expect(publishedKinds(world.publisher)).toEqual([]);

    // Right sha from a maintainer → runs.
    const manual = signed(
      buildCiManualTrigger(
        COORD,
        {
          repoAddr: ADDR,
          commit,
          workflow: {
            path: '.github/workflows/ci.yml',
            sha256: sha256Hex(WORKFLOW),
          },
          ref: 'refs/heads/main',
        },
        1700
      ),
      MAINT
    );
    world.relay.push(manual);
    await handle.idle();
    expect(publishedKinds(world.publisher)).toEqual([
      39842, 39842, 9841, 39842, 9842, 39842,
    ]);
    const [queued] = progressEvents(world.publisher);
    expect(queued).toMatchObject({
      status: 'queued',
      provenance: { kind: 'manual-trigger', eventId: manual.id, pubkey: MAINT },
    });
    expect(must(queued).trigger).toMatchObject({
      reason: 'manual',
      commit,
      ref: 'refs/heads/main',
    });
    expect(resultEvents(world.publisher)[0]).toMatchObject({
      conclusion: 'success',
      provenance: { kind: 'manual-trigger', eventId: manual.id },
    });
    // Secrets would be allowed (maintainer) — none set, so empty.
    expect(must(world.runner.requests[0]).secrets).toEqual({});
    await handle.stop();
  });

  it('publishes startup_failure when the requested commit cannot be materialized', async () => {
    const world = makeWorld();
    const { announce, refsEvent } = world.snapshot(1000);
    world.relay.serve([announce, refsEvent]);
    const handle = await world.start();
    world.relay.push(
      signed(
        buildCiManualTrigger(
          COORD,
          {
            repoAddr: ADDR,
            commit: '9'.repeat(40),
            workflow: {
              path: '.github/workflows/ci.yml',
              sha256: sha256Hex(WORKFLOW),
            },
          },
          1500
        ),
        OWNER
      )
    );
    await handle.idle();
    expect(publishedKinds(world.publisher)).toEqual([39842, 9842, 39842]);
    expect(resultEvents(world.publisher)[0]).toMatchObject({
      conclusion: 'startup_failure',
      jobs: [],
    });
    await handle.stop();
  });
});

// ---------------------------------------------------------------------------
// Operator requester allowlist (story 21)
// ---------------------------------------------------------------------------

describe('operator-accepted requesters', () => {
  it("serves on an allowlisted stranger's request, quotes it, gives them no secrets, and honours their author-local Stop", async () => {
    const world = makeWorld();
    const { announce, refsEvent } = world.snapshot(1000);
    world.relay.serve([announce, refsEvent, serviceRequest(STRANGER, 1100)]);
    const handle = await world.start({ acceptedRequesters: [STRANGER] });
    expect(must(handle.serving()[0]).serving).toBe(true);
    expect(
      world.logs.some((l) => l.includes('operator-accepted requester'))
    ).toBe(true);

    // A maintainer-provisioned secret exists…
    world.relay.push(
      secretUpdate(world, handle, MAINT, { DEPLOY_TOKEN: 'hunter2' })
    );
    await handle.idle();

    // …an owner push (a maintainer-authored trigger) gets it, quoting the
    // stranger's request as the run's provenance.
    const base = push(world, 2000);
    await handle.idle();
    expect(must(world.runner.requests[0]).secrets).toEqual({
      DEPLOY_TOKEN: 'hunter2',
    });
    expect(resultEvents(world.publisher)[0]).toMatchObject({
      provenance: { kind: 'service-request', pubkey: STRANGER },
    });

    // The stranger's own kind:1617 PR runs, with NO secrets.
    const contrib = tempDir('rig-ci-coord-contrib-');
    git(['clone', '-q', world.srcDir, '.'], contrib);
    writeFileSync(join(contrib, 'pr.txt'), 'mine\n');
    git(['add', '.'], contrib);
    git(['commit', '-m', 'my change'], contrib);
    const patch = signed(
      {
        kind: 1617,
        content: git(['format-patch', '--stdout', `${base}..HEAD`], contrib),
        created_at: 2500,
        tags: [
          ['a', ADDR],
          ['p', OWNER],
          ['subject', 'my change'],
          ['commit', git(['rev-parse', 'HEAD'], contrib)],
          ['parent-commit', base],
        ],
      },
      STRANGER
    );
    world.relay.push(patch);
    await handle.idle();
    expect(must(world.runner.requests[1]).secrets).toEqual({});
    expect(must(world.runner.requests[1]).trigger.reason).toBe('pull_request');

    // Their Stop closes only their own request: with a maintainer request
    // also standing, service continues; without one, it stops.
    world.relay.push(serviceRequest(MAINT, 2600));
    await handle.idle();
    world.relay.push(serviceStop(STRANGER, 2700));
    await handle.idle();
    expect(must(handle.serving()[0]).serving).toBe(true);
    world.relay.push(serviceStop(MAINT, 2800));
    await handle.idle();
    expect(must(handle.serving()[0]).serving).toBe(false);
    await handle.stop();
  });
});

// ---------------------------------------------------------------------------
// Manual Trigger: NIP-C1 `c` peeling and `a` scope
// ---------------------------------------------------------------------------

describe('manual trigger: annotated tags and extra repo coordinates', () => {
  function manualFor(
    commit: string,
    createdAt: number,
    extra: { tagObjectIds?: string[]; extraRepoAddrs?: string[] } = {}
  ): NostrEvent {
    return signed(
      buildCiManualTrigger(
        COORD,
        {
          repoAddr: ADDR,
          commit,
          workflow: {
            path: '.github/workflows/ci.yml',
            sha256: sha256Hex(WORKFLOW),
          },
          ...extra,
        },
        createdAt
      ),
      MAINT
    );
  }

  it('runs when every extra c peels to the commit, keeps them as c tags, and never republishes unverified a tags', async () => {
    const world = makeWorld();
    git(['tag', '-a', 'v1', '-m', 'release v1'], world.srcDir);
    const tagObject = git(['rev-parse', 'v1'], world.srcDir);
    const commit = git(['rev-parse', 'v1^{commit}'], world.srcDir);
    expect(tagObject).not.toBe(commit);
    const { announce, refsEvent } = world.snapshot(1000);
    world.relay.serve([announce, refsEvent]);
    const handle = await world.start();

    world.relay.push(
      manualFor(commit, 1500, {
        tagObjectIds: [tagObject],
        extraRepoAddrs: [repoAddress(MAINT, REPO)],
      })
    );
    await handle.idle();
    expect(publishedKinds(world.publisher)).toEqual([
      39842, 39842, 9841, 39842, 9842, 39842,
    ]);
    const result = must(resultEvents(world.publisher)[0]);
    expect(result.trigger.commit).toBe(commit);
    expect(result.trigger.tagObjectIds).toEqual([tagObject]);
    expect(result.trigger.extraRepoAddrs).toBeUndefined();
    await handle.stop();
  });

  it('ignores a request whose extra c does not peel to the same commit, publishing nothing', async () => {
    const world = makeWorld();
    git(['tag', '-a', 'old', '-m', 'old tag'], world.srcDir);
    const oldTag = git(['rev-parse', 'old'], world.srcDir);
    const newer = world.commit('next.txt', 'n\n', 'next');
    const { announce, refsEvent } = world.snapshot(1000);
    world.relay.serve([announce, refsEvent]);
    const handle = await world.start();

    world.relay.push(manualFor(newer, 1500, { tagObjectIds: [oldTag] }));
    await handle.idle();
    expect(publishedKinds(world.publisher)).toEqual([]);
    expect(world.runner.requests).toHaveLength(0);
    expect(world.logs.some((l) => l.includes('does not peel to'))).toBe(true);

    // An id that is not in the repository at all is ignored the same way.
    world.relay.push(
      manualFor(newer, 1600, { tagObjectIds: ['9'.repeat(40)] })
    );
    await handle.idle();
    expect(publishedKinds(world.publisher)).toEqual([]);
    await handle.stop();
  });
});

// ---------------------------------------------------------------------------
// Restart + reconnect
// ---------------------------------------------------------------------------

describe('restart and reconnect', () => {
  it('resumes from the persisted cursor: a push that landed while stopped runs once on restart, never twice', async () => {
    const world = makeWorld();
    const { announce, refsEvent } = world.snapshot(1000);
    world.relay.serve([announce, refsEvent, serviceRequest(MAINT, 1100)]);
    const first = await world.start();
    await first.stop();
    expect(world.runner.requests).toHaveLength(0);

    // While stopped: a push lands on the relay (canned, not live).
    world.commit('offline.txt', 'o\n', 'while offline');
    const { refsEvent: later } = world.snapshot(2000);
    world.relay.serve([later]);

    const second = await world.start();
    await second.idle();
    expect(world.runner.requests).toHaveLength(1);
    expect(resultEvents(world.publisher)).toHaveLength(1);
    await second.stop();

    // A third start replays the same backlog — already processed, no rerun.
    const third = await world.start();
    await third.idle();
    expect(world.runner.requests).toHaveLength(1);
    await third.stop();
  });

  it('reconnects with backoff after the relay drops and keeps hearing pushes', async () => {
    const world = makeWorld();
    const { announce, refsEvent } = world.snapshot(1000);
    world.relay.serve([announce, refsEvent, serviceRequest(MAINT, 1100)]);
    const handle = await world.start();
    const socketsBefore = world.relay.sockets.length;

    world.relay.dropConnection();
    await flush();
    expect(world.logs.some((l) => l.includes('reconnecting'))).toBe(true);
    world.clock.advance(1000);
    await flush();
    expect(world.relay.sockets.length).toBe(socketsBefore + 1);
    // The re-sent REQs carry `since` from the cursor.
    const reqs = world.relay.sentFrames.filter((f) => f[0] === 'REQ').slice(-4);
    expect(reqs.some((f) => (f[2] as { since?: number }).since === 1000)).toBe(
      true
    );

    push(world, 2000);
    await handle.idle();
    expect(world.runner.requests).toHaveLength(1);
    await handle.stop();
  });
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('helpers', () => {
  it('logTail keeps the last 4 KiB and counts omitted bytes', () => {
    const big = 'x'.repeat(5000) + 'END';
    const { tail, omitted } = logTail(big);
    expect(tail.endsWith('END')).toBe(true);
    expect(Buffer.byteLength(tail)).toBe(4096);
    expect(omitted).toBe(5003 - 4096);
    expect(logTail('short')).toEqual({ tail: 'short', omitted: 0 });
  });

  it('movedRefs reports new and changed refs only', () => {
    expect(
      movedRefs(
        { 'refs/heads/main': 'a', 'refs/heads/old': 'b' },
        { 'refs/heads/main': 'c', 'refs/heads/new': 'd' }
      )
    ).toEqual([
      { ref: 'refs/heads/main', sha: 'c' },
      { ref: 'refs/heads/new', sha: 'd' },
    ]);
  });
});
