/**
 * Coordinator operations (#133 — CI 8): a coordinator left running is safe
 * to leave running. Bounded concurrency with queue rounds, the per-run wall
 * clock, wallet exhaustion, and relay reconnects. The fake clock drives the
 * coordinator's timers (wall clock, reconnect backoff, renewals); git and the
 * read path are real I/O, awaited via `waitFor` / `handle.idle()`.
 */

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import type { FeeRates } from '../publisher.js';
import { flush, waitFor } from './ci-testkit.js';
import {
  ADDR,
  MAINT,
  blockingRunner,
  cleanupWorlds,
  jobEvents,
  makeWorld,
  must,
  progressEvents,
  publishedKinds,
  push,
  resetEventIds,
  resultEvents,
  serviceRequest,
} from './coordinator-testkit.js';
import { FakeRunner, type RunnerRunResult } from './runner.js';
import { loadCoordinatorState } from './state.js';

afterEach(cleanupWorlds);
beforeEach(resetEventIds);

const TWO_JOB_WORKFLOW = `name: ci
on:
  push:
    branches: [main]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo build
  test:
    runs-on: ubuntu-latest
    steps:
      - run: sleep 300
`;

// ---------------------------------------------------------------------------
// Bounded concurrency
// ---------------------------------------------------------------------------

describe('bounded concurrency', () => {
  it('three pushes under concurrency 1 run one at a time, in push order; the waiting runs show queue rounds 1, 2, 3', async () => {
    const world = makeWorld();
    const { announce, refsEvent } = world.snapshot(1000);
    world.relay.serve([announce, refsEvent, serviceRequest(MAINT, 1100)]);
    const blocking = blockingRunner();
    const handle = await world.start({
      runner: blocking.runner,
      concurrency: 1,
    });

    const first = push(world, 2000, 'a.txt', 'a\n');
    await waitFor(() => blocking.started.length === 1, 'the first run');
    const second = push(world, 2100, 'b.txt', 'b\n');
    const third = push(world, 2200, 'c.txt', 'c\n');
    await waitFor(
      () =>
        progressEvents(world.publisher).filter((p) => p.status === 'queued')
          .length === 3,
      'three queued markers'
    );

    // Only one slot: the second and third wait, each one round further back.
    expect(blocking.started).toHaveLength(1);
    const queued = progressEvents(world.publisher).filter(
      (p) => p.status === 'queued'
    );
    expect(queued.map((q) => q.queue)).toEqual([1, 2, 3]);
    expect(queued.map((q) => q.trigger.commit)).toEqual([first, second, third]);

    blocking.release();
    await waitFor(() => blocking.started.length === 2, 'the second run');
    blocking.release();
    await waitFor(() => blocking.started.length === 3, 'the third run');
    blocking.release();
    await handle.idle();

    // Started in push order, each concluded, and no `queue` once running.
    expect(blocking.started.map((r) => r.trigger.commit)).toEqual([
      first,
      second,
      third,
    ]);
    expect(resultEvents(world.publisher).map((r) => r.conclusion)).toEqual([
      'success',
      'success',
      'success',
    ]);
    expect(
      progressEvents(world.publisher)
        .filter((p) => p.status !== 'queued')
        .every((p) => p.queue === undefined)
    ).toBe(true);
    await handle.stop();
  });

  it('concurrency 2 runs two pushes at once and queues the third in round 2', async () => {
    const world = makeWorld();
    const { announce, refsEvent } = world.snapshot(1000);
    world.relay.serve([announce, refsEvent, serviceRequest(MAINT, 1100)]);
    const blocking = blockingRunner();
    const handle = await world.start({
      runner: blocking.runner,
      concurrency: 2,
    });

    push(world, 2000, 'a.txt', 'a\n');
    push(world, 2100, 'b.txt', 'b\n');
    await waitFor(() => blocking.started.length === 2, 'two runs at once');
    push(world, 2200, 'c.txt', 'c\n');
    await waitFor(
      () =>
        progressEvents(world.publisher).filter((p) => p.status === 'queued')
          .length === 3,
      'three queued markers'
    );
    expect(blocking.started).toHaveLength(2);
    expect(
      progressEvents(world.publisher)
        .filter((p) => p.status === 'queued')
        .map((q) => q.queue)
    ).toEqual([1, 1, 2]);

    blocking.release();
    await waitFor(() => blocking.started.length === 3, 'the third run');
    blocking.release();
    blocking.release();
    await handle.idle();
    expect(resultEvents(world.publisher)).toHaveLength(3);
    await handle.stop();
  });
});

// ---------------------------------------------------------------------------
// Wall clock
// ---------------------------------------------------------------------------

describe('wall clock', () => {
  it('stops the Runner at the wall clock, publishes timed_out for the job it cut short (a job that finished successfully keeps its verdict), and concludes timed_out', async () => {
    const world = makeWorld({ workflows: { 'ci.yml': TWO_JOB_WORKFLOW } });
    const { announce, refsEvent } = world.snapshot(1000);
    world.relay.serve([announce, refsEvent, serviceRequest(MAINT, 1100)]);

    // A runner shaped like act under SIGTERM: `build` had finished, `test`
    // was torn down and reported as `failure` — that failure is our kill.
    const runner = new FakeRunner(
      (request) =>
        new Promise<RunnerRunResult>((resolve) => {
          request.signal?.addEventListener(
            'abort',
            () =>
              resolve({
                conclusion: 'failure',
                startedAt: 1,
                finishedAt: 61,
                jobs: [
                  {
                    jobId: 'build',
                    name: 'build',
                    conclusion: 'success',
                    exitCode: 0,
                    startedAt: 1,
                    finishedAt: 2,
                    log: 'build ok\n',
                    artifacts: [],
                  },
                  {
                    jobId: 'test',
                    name: 'test',
                    conclusion: 'failure',
                    startedAt: 2,
                    finishedAt: 61,
                    log: 'sleeping…\n',
                    artifacts: [],
                  },
                ],
              }),
            { once: true }
          );
        })
    );
    const handle = await world.start({ runner, timeoutMs: 60_000 });

    push(world, 2000);
    await waitFor(() => runner.requests.length === 1, 'the run to start');
    await flush();
    const request = must(runner.requests[0]);
    expect(request.timeoutMs).toBe(60_000);
    expect(progressEvents(world.publisher).map((p) => p.status)).toEqual([
      'queued',
      'in_progress',
    ]);
    expect(must(progressEvents(world.publisher).at(-1)).inProgress).toEqual([
      'build',
      'test',
    ]);

    // One tick short of the budget: still running, nothing concluded.
    world.clock.advance(59_999);
    await flush();
    expect(request.signal?.aborted).toBe(false);
    expect(resultEvents(world.publisher)).toHaveLength(0);

    // The budget expires: the Runner is asked to stop, then the run concludes.
    world.clock.advance(2);
    await handle.idle();
    expect(request.signal?.aborted).toBe(true);
    expect(
      jobEvents(world.publisher).map((j) => [j.jobId, j.conclusion])
    ).toEqual([
      ['build', 'success'],
      ['test', 'timed_out'],
    ]);
    expect(world.publisher.uploadedBlobs).toHaveLength(2);
    const result = must(resultEvents(world.publisher)[0]);
    expect(result.conclusion).toBe('timed_out');
    expect(result.jobs.map((j) => j.jobId)).toEqual(['build', 'test']);
    expect(progressEvents(world.publisher).at(-1)).toMatchObject({
      status: 'concluded',
      conclusion: 'timed_out',
      inProgress: [],
    });
    expect(world.logs.some((l) => /\btimed_out$/.test(l))).toBe(true);
    await handle.stop();
  });
});

// ---------------------------------------------------------------------------
// Wallet exhaustion
// ---------------------------------------------------------------------------

describe('wallet exhaustion', () => {
  it('refuses new runs while the wallet cannot pay — nothing published, one log line each — and resumes once it can', async () => {
    const world = makeWorld();
    const { announce, refsEvent } = world.snapshot(1000);
    world.relay.serve([announce, refsEvent, serviceRequest(MAINT, 1100)]);
    let funded = false;
    const estimates: { events: number; uploads: number; rates: FeeRates }[] =
      [];
    const handle = await world.start({
      canAfford: async (estimate) => {
        estimates.push(estimate);
        return funded;
      },
    });
    const advertisements = world.publisher.publishedEvents.length;

    // The publisher cannot even quote fees (no usable channel).
    world.publisher.feeRatesError = 'insufficient funds';
    push(world, 2000, 'a.txt', 'a\n');
    await handle.idle();
    expect(publishedKinds(world.publisher)).toEqual([]);
    expect(world.runner.requests).toHaveLength(0);
    expect(estimates).toHaveLength(0);
    expect(
      world.logs.filter((l) =>
        l.includes('refusing run of .github/workflows/ci.yml')
      )
    ).toEqual([
      '[ci] refusing run of .github/workflows/ci.yml for demo: cannot read fee rates (insufficient funds) — is the wallet funded?',
    ]);

    // Fees are readable but the estimate is not covered.
    world.publisher.feeRatesError = null;
    push(world, 2100, 'b.txt', 'b\n');
    await handle.idle();
    expect(publishedKinds(world.publisher)).toEqual([]);
    expect(world.runner.requests).toHaveLength(0);
    expect(estimates).toEqual([
      { events: 6, uploads: 1, rates: world.publisher.feeRates },
    ]);
    expect(
      world.logs.filter((l) =>
        l.includes('refusing run of .github/workflows/ci.yml')
      )
    ).toHaveLength(2);
    expect(must(world.logs.at(-1))).toBe(
      '[ci] refusing run of .github/workflows/ci.yml for demo: wallet cannot cover its writes'
    );

    // Funded: the next push runs; the refused ones are not retried.
    funded = true;
    const third = push(world, 2200, 'c.txt', 'c\n');
    await handle.idle();
    expect(world.runner.requests.map((r) => r.trigger.commit)).toEqual([third]);
    expect(resultEvents(world.publisher).map((r) => r.conclusion)).toEqual([
      'success',
    ]);
    // Nothing was ever published for the two refused pushes.
    expect(
      progressEvents(world.publisher).every((p) => p.trigger.commit === third)
    ).toBe(true);
    expect(world.publisher.publishedEvents.length - advertisements).toBe(6);
    await handle.stop();
  });
});

// ---------------------------------------------------------------------------
// Reconnect
// ---------------------------------------------------------------------------

describe('reconnect', () => {
  it('a push that landed while the socket was down runs exactly once after the reconnect, and never again on a later reconnect', async () => {
    const world = makeWorld();
    const { announce, refsEvent } = world.snapshot(1000);
    world.relay.serve([announce, refsEvent, serviceRequest(MAINT, 1100)]);
    const handle = await world.start();
    const socketsBefore = world.relay.sockets.length;

    world.relay.dropConnection();
    await flush();
    expect(world.relay.openSockets()).toHaveLength(0);

    // During the gap: a push lands at the relay. No socket is open, so the
    // live delivery reaches nobody — the event only waits in the relay.
    const sha = world.commit('gap.txt', 'g\n', 'while disconnected');
    const { refsEvent: duringGap } = world.snapshot(2000);
    expect(world.relay.push(duringGap)).toBe(false);
    await flush();
    expect(world.runner.requests).toHaveLength(0);

    // Backoff elapses → reconnect → the REQs replay the backlog. (Once the
    // replayed push materializes, the read path opens sockets of its own, so
    // only a lower bound is exact here.)
    world.clock.advance(1000);
    await flush();
    expect(world.relay.sockets.length).toBeGreaterThanOrEqual(
      socketsBefore + 1
    );
    expect(world.relay.openSockets().length).toBeGreaterThanOrEqual(1);
    await waitFor(() => world.runner.requests.length === 1, 'the gap push');
    await handle.idle();
    expect(world.runner.requests.map((r) => r.trigger.commit)).toEqual([sha]);
    expect(resultEvents(world.publisher)).toHaveLength(1);

    // The cursor recorded it, so a second drop + reconnect (which replays
    // the same backlog) runs nothing new.
    const state = await loadCoordinatorState(world.stateDir);
    expect(must(state.cursor[ADDR])).toMatchObject({
      lastCreatedAt: 2000,
      lastEventId: duringGap.id,
    });
    expect(must(state.cursor[ADDR]).processed).toContain(duringGap.id);

    // (Materializing the gap push opened read-path sockets of its own, so
    // count from here rather than from the first drop.)
    const socketsBeforeSecondDrop = world.relay.sockets.length;
    world.relay.dropConnection();
    await flush();
    world.clock.advance(1000);
    await flush();
    expect(world.relay.sockets.length).toBe(socketsBeforeSecondDrop + 1);
    expect(world.relay.openSockets()).toHaveLength(1);
    await handle.idle();
    expect(world.runner.requests).toHaveLength(1);
    expect(resultEvents(world.publisher)).toHaveLength(1);

    // And the subscription is live again: a later push runs once.
    const later = push(world, 3000, 'after.txt', 'a\n');
    await handle.idle();
    expect(world.runner.requests.map((r) => r.trigger.commit)).toEqual([
      sha,
      later,
    ]);
    await handle.stop();
  });
});
