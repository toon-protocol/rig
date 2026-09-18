/**
 * The coordinator test world (#125 / #130): a REAL source repository served
 * through the mock gateway, a scripted relay, a fake Publisher, a fake clock
 * and a FakeRunner, so a coordinator test can script relay events in and
 * assert the NIP-C1 event sequence out without Docker, sleeps or a network.
 *
 * Shared by the coordinator test files; `coordinator.test.ts` still carries
 * its own copy of these fixtures (it was written first) and can adopt this
 * module once the in-flight additions to it land.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
  type FakePublisher,
} from './ci-testkit.js';
import {
  startCoordinator,
  type CoordinatorHandle,
  type CoordinatorOptions,
} from './coordinator.js';
import {
  CI_ADVERTISEMENT_KIND,
  CI_JOB_RESULT_KIND,
  CI_LIVE_LOG_TAIL_KIND,
  CI_WORKFLOW_PROGRESS_KIND,
  CI_WORKFLOW_RESULT_KIND,
  buildCiSecretUpdate,
  buildCiServiceRequest,
  buildCiServiceStop,
  parseCiJobResult,
  parseCiLiveLogTail,
  parseCiWorkflowProgress,
  parseCiWorkflowResult,
  repoAddress,
} from './nip-c1-events.js';
import { encryptSecretUpdate, generateSecretsKey } from './secrets.js';
import {
  FakeRunner,
  type RunnerRequest,
  type RunnerRunResult,
} from './runner.js';

export const OWNER = 'ab'.repeat(32);
export const MAINT = 'cd'.repeat(32);
export const STRANGER = 'ef'.repeat(32);
export const COORD = '12'.repeat(32);
export const REPO = 'demo';
export const ADDR = repoAddress(OWNER, REPO);
export const RELAY = 'wss://relay.test.example';
export const GATEWAY = 'http://gateway.test:3000';

/** The default workflow: pushes to main and every pull request. */
export const WORKFLOW = `name: ci
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

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const cleanups: string[] = [];

/** Narrow an optional value or fail the test loudly (no non-null assertions). */
export function must<T>(value: T | undefined | null, what = 'value'): T {
  if (value === undefined || value === null) {
    throw new Error(`expected ${what} to be present`);
  }
  return value;
}

/** Register from the test file's `afterEach`: drops temp dirs + the sha cache. */
export function cleanupWorlds(): void {
  clearShaCache();
  for (const dir of cleanups.splice(0))
    rmSync(dir, { recursive: true, force: true });
}

export function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(dir);
  return dir;
}

export function git(args: string[], cwd: string): string {
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
/** Reset from the test file's `beforeEach` so ids are stable per test. */
export function resetEventIds(): void {
  eventCounter = 0;
}
function eventId(): string {
  eventCounter += 1;
  return eventCounter.toString(16).padStart(64, '0');
}

export function signed(
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

export interface World {
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

export interface WorldOptions {
  /** Workflow files under `.github/workflows/` (default: `ci.yml` = {@link WORKFLOW}). */
  workflows?: Record<string, string>;
}

export function makeWorld(options: WorldOptions = {}): World {
  const srcDir = tempDir('rig-ci-coord-src-');
  git(['init', '--initial-branch=main'], srcDir);
  mkdirSync(join(srcDir, '.github', 'workflows'), { recursive: true });
  const workflows = options.workflows ?? { 'ci.yml': WORKFLOW };
  for (const [file, content] of Object.entries(workflows)) {
    writeFileSync(join(srcDir, '.github', 'workflows', file), content);
  }
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

export function serviceRequest(from: string, createdAt: number): NostrEvent {
  return signed(buildCiServiceRequest(ADDR, COORD, RELAY, createdAt), from);
}
export function serviceStop(from: string, createdAt: number): NostrEvent {
  return signed(buildCiServiceStop(ADDR, COORD, RELAY, createdAt), from);
}

/** Kinds of every published event, in order (advertisement excluded). */
export function publishedKinds(publisher: FakePublisher): number[] {
  return publisher.publishedEvents
    .map((p) => p.event.kind)
    .filter((k) => k !== CI_ADVERTISEMENT_KIND);
}

export function progressEvents(publisher: FakePublisher, pubkey = COORD) {
  return publisher
    .ofKind(CI_WORKFLOW_PROGRESS_KIND)
    .map((p) =>
      must(
        parseCiWorkflowProgress(publisher.asRelayEvent(p, pubkey)),
        'a parseable 39842'
      )
    );
}

export function resultEvents(publisher: FakePublisher, pubkey = COORD) {
  return publisher
    .ofKind(CI_WORKFLOW_RESULT_KIND)
    .map((p) =>
      must(
        parseCiWorkflowResult(publisher.asRelayEvent(p, pubkey)),
        'a parseable 9842'
      )
    );
}

export function jobEvents(publisher: FakePublisher, pubkey = COORD) {
  return publisher
    .ofKind(CI_JOB_RESULT_KIND)
    .map((p) =>
      must(
        parseCiJobResult(publisher.asRelayEvent(p, pubkey)),
        'a parseable 9841'
      )
    );
}

/**
 * Every Live Log Tail (39841) published, in order — what a client watching
 * the run on the relay would see, parsed through the shipped parser so a
 * malformed event fails the test rather than being read leniently.
 */
export function liveLogTailEvents(publisher: FakePublisher, pubkey = COORD) {
  return publisher
    .ofKind(CI_LIVE_LOG_TAIL_KIND)
    .map((p) =>
      must(
        parseCiLiveLogTail(publisher.asRelayEvent(p, pubkey)),
        'a parseable 39841'
      )
    );
}

/** A kind:29846 from `author`, NIP-44 encrypted to the coordinator's CURRENT secrets-key. */
export function secretUpdate(
  world: World,
  handle: CoordinatorHandle,
  author: string,
  set: Record<string, string>
): NostrEvent {
  const sender = generateSecretsKey();
  const created_at = world.clock.now();
  return signed(
    buildCiSecretUpdate({
      repoAddr: repoAddress(author, REPO),
      coordinatorPubkey: COORD,
      advertisementId: handle.advertisementId as string,
      advertisementRelayHint: RELAY,
      senderPubkey: sender.pubkey,
      recipientPubkey: handle.secretsKeyPubkey,
      ciphertext: encryptSecretUpdate(
        { author, created_at, set, remove: [] },
        sender.secretKey,
        handle.secretsKeyPubkey
      ),
      createdAt: created_at,
    }),
    author
  );
}

/** A push: commit on the source repo, publish the new 30618 live. */
export function push(
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
export function blockingRunner(): {
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
        const releaser = (r: RunnerRunResult) => resolve(r);
        releasers.push(releaser);
        // An aborted run reports its own teardown and leaves the release
        // queue, so the next `release()` reaches the run that is still going.
        request.signal?.addEventListener(
          'abort',
          () => {
            releasers = releasers.filter((r) => r !== releaser);
            resolve({
              conclusion: 'cancelled',
              jobs: [],
              startedAt: 1,
              finishedAt: 2,
            });
          },
          { once: true }
        );
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
