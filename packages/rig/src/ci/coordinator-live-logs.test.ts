/**
 * The live log tail at the coordinator (#193, ADR-0002): what a client
 * subscribed to `39841:<coordinator>:<run id>` sees while a run is in flight.
 *
 * Everything here is asserted from the published event stream — the sequence,
 * timing and content a relay would serve — never from the coordinator's
 * buffers. The cadence rides the coordinator's scheduler seam, so the fake
 * clock drives it and no test sleeps.
 */

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { flush, waitFor } from './ci-testkit.js';
import {
  MAINT,
  blockingRunner,
  cleanupWorlds,
  jobEvents,
  liveLogTailEvents,
  makeWorld,
  must,
  progressEvents,
  publishedKinds,
  push,
  resetEventIds,
  resultEvents,
  secretUpdate,
  serviceRequest,
} from './coordinator-testkit.js';
import { LOG_TAIL_BYTES } from './coordinator.js';
import {
  CI_LIVE_LOG_TAIL_INTERVAL_MS,
  CI_LIVE_LOG_TAIL_KIND,
  CI_LIVE_LOG_TAIL_MAX_BYTES,
  CI_MAX_LIVE_LOG_TAIL_TTL,
  CI_RUNNER_CHANNEL_KEY,
  liveLogTailEventBudget,
} from './nip-c1-events.js';
import { FakeRunner, type RunnerRequest } from './runner.js';

beforeEach(() => resetEventIds());
afterEach(() => cleanupWorlds());

const TICK = CI_LIVE_LOG_TAIL_INTERVAL_MS;

/** A workflow with two jobs, so one can conclude while the other runs on. */
const TWO_JOBS = `name: ci
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
      - run: echo test
`;

/** The durable sequence a one-job push run published before #193. */
const DURABLE_PUSH_RUN = [39842, 39842, 9841, 39842, 9842, 39842];

function bytes(text: string): number {
  return Buffer.byteLength(text, 'utf-8');
}

/** A started, blocked run whose log sink the test drives chunk by chunk. */
async function streamingRun(
  options: { workflows?: Record<string, string> } = {}
) {
  const world = makeWorld(
    options.workflows ? { workflows: options.workflows } : {}
  );
  const { announce, refsEvent } = world.snapshot(1000);
  world.relay.serve([announce, refsEvent, serviceRequest(MAINT, 1100)]);
  const blocking = blockingRunner();
  const handle = await world.start({ runner: blocking.runner });
  push(world, 2000);
  await waitFor(() => blocking.started.length === 1, 'the run to start');
  await flush();
  return { world, handle, blocking, request: must(blocking.started[0]) };
}

/** Advance the clock one cadence interval and let the publish settle. */
async function tick(world: { clock: { advance(ms: number): void } }, n = 1) {
  for (let i = 0; i < n; i++) {
    world.clock.advance(TICK);
    await flush();
  }
}

describe('the cadence', () => {
  it('publishes a tail while the run is in flight and replaces it as the clock advances', async () => {
    const { world, handle, blocking, request } = await streamingRun();

    // The run has started; the first tail is one cadence away.
    expect(liveLogTailEvents(world.publisher)).toHaveLength(0);

    request.onLog?.('build', 'compiling\n');
    await tick(world);
    expect(liveLogTailEvents(world.publisher)).toHaveLength(1);
    expect(must(liveLogTailEvents(world.publisher)[0]).jobs).toEqual([
      { job: 'build', tail: 'compiling\n', omitted: 0 },
    ]);

    // Between two ticks nothing is published, however much the job prints.
    request.onLog?.('build', 'linking\n');
    world.clock.advance(TICK - 1);
    await flush();
    expect(liveLogTailEvents(world.publisher)).toHaveLength(1);

    world.clock.advance(1);
    await flush();
    const tails = liveLogTailEvents(world.publisher);
    expect(tails).toHaveLength(2);
    expect(must(tails[1]).jobs).toEqual([
      { job: 'build', tail: 'compiling\nlinking\n', omitted: 0 },
    ]);

    // One addressable identity, replaced: same `d` as the run's progress, a
    // later `created_at` each time, and a NIP-40 expiry within the bound.
    const runId = must(progressEvents(world.publisher)[0]).runId;
    expect(tails.map((t) => t.runId)).toEqual([runId, runId]);
    expect(must(tails[1]).createdAt).toBeGreaterThan(must(tails[0]).createdAt);
    for (const t of tails) {
      expect(t.expiresAt).toBeGreaterThan(t.createdAt);
      expect(t.expiresAt - t.createdAt).toBeLessThanOrEqual(
        CI_MAX_LIVE_LOG_TAIL_TTL
      );
    }

    blocking.release();
    await handle.idle();
    await handle.stop();
  });

  it('publishes no tail at all for a run that concludes inside one cadence, and leaves the durable sequence untouched', async () => {
    const world = makeWorld();
    const { announce, refsEvent } = world.snapshot(1000);
    world.relay.serve([announce, refsEvent, serviceRequest(MAINT, 1100)]);
    const handle = await world.start();

    push(world, 2000);
    await handle.idle();

    // Nothing was ever live, so there is nothing on the relay to replace and
    // no empty event is paid for.
    expect(liveLogTailEvents(world.publisher)).toHaveLength(0);
    expect(publishedKinds(world.publisher)).toEqual(DURABLE_PUSH_RUN);
    await handle.stop();
  });
});

describe('what the tail carries', () => {
  it('shows the runner channel as the runner, never as a job', async () => {
    const { world, handle, blocking, request } = await streamingRun();

    request.onLog?.('build', 'compiling\n');
    request.onLog?.(CI_RUNNER_CHANNEL_KEY, 'pulling ubuntu-latest\n');
    await tick(world);

    // `liveLogTailEvents` parses with the shipped parser, which rejects an
    // event naming the runner channel as a job id — so this having parsed at
    // all is half the assertion.
    const tail = must(liveLogTailEvents(world.publisher)[0]);
    expect(tail.jobs.map((j) => j.job)).toEqual(['build']);
    expect(tail.runner).toEqual({
      tail: 'pulling ubuntu-latest\n',
      omitted: 0,
    });

    blocking.release();
    await handle.idle();
    await handle.stop();
  });

  it('bounds a chatty job to the end of its output, with omitted naming everything before it', async () => {
    const { world, handle, blocking, request } = await streamingRun();

    const line = `${'x'.repeat(98)}\n`;
    const printed = 400;
    for (let i = 0; i < printed; i++) request.onLog?.('build', line);
    await tick(world);

    const job = must(must(liveLogTailEvents(world.publisher)[0]).jobs[0]);
    const whole = line.repeat(printed);
    expect(bytes(job.tail)).toBeLessThan(bytes(whole));
    expect(job.omitted + bytes(job.tail)).toBe(bytes(whole));
    // Sliced from the END: the tail is a suffix of what the job printed.
    expect(whole.endsWith(job.tail)).toBe(true);
    // And far more than the 4 KiB that rides in a Job Result — the point of
    // a live view is seeing the failing command WITH its context.
    expect(bytes(job.tail)).toBeGreaterThan(LOG_TAIL_BYTES);

    blocking.release();
    await handle.idle();
    await handle.stop();
  });

  it('divides the budget between many live jobs rather than exceeding the per-event ceiling', async () => {
    const { world, handle, blocking, request } = await streamingRun();

    const line = `${'x'.repeat(98)}\n`;
    const jobIds = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
    for (const id of jobIds) {
      for (let i = 0; i < 400; i++) request.onLog?.(id, line);
    }
    request.onLog?.(CI_RUNNER_CHANNEL_KEY, line.repeat(400));
    await tick(world);

    const tail = must(liveLogTailEvents(world.publisher)[0]);
    expect(tail.jobs.map((j) => j.job)).toEqual(jobIds);
    const sizes = tail.jobs.map((j) => bytes(j.tail));
    const total =
      sizes.reduce((n, s) => n + s, 0) + bytes(must(tail.runner).tail);
    expect(total).toBeLessThanOrEqual(CI_LIVE_LOG_TAIL_MAX_BYTES);
    // Evenly: every live entry gets the same share, and a real one.
    expect(new Set([...sizes, bytes(must(tail.runner).tail)]).size).toBe(1);
    expect(must(sizes[0])).toBeGreaterThan(0);

    blocking.release();
    await handle.idle();
    await handle.stop();
  });
});

describe('secrets', () => {
  it('redacts the whole buffer before slicing, so a secret spanning a refresh and a slice boundary never reaches the relay', async () => {
    const SECRET = 'hunter2supersecret';
    const world = makeWorld();
    const { announce, refsEvent } = world.snapshot(1000);
    world.relay.serve([announce, refsEvent, serviceRequest(MAINT, 1100)]);
    const blocking = blockingRunner();
    const handle = await world.start({ runner: blocking.runner });
    world.relay.push(secretUpdate(world, handle, MAINT, { TOKEN: SECRET }));
    await handle.idle();

    push(world, 2000);
    await waitFor(() => blocking.started.length === 1, 'the run to start');
    await flush();
    const request = must(blocking.started[0]);
    expect(request.secrets).toEqual({ TOKEN: SECRET });

    // The secret is written in two pieces either side of a refresh: the first
    // publication can only hold its beginning.
    request.onLog?.('build', `${'x'.repeat(100)}hunter`);
    await tick(world);
    // The rest arrives, and enough follows it to push the slice boundary INTO
    // the secret: slicing before redacting would publish its second half in
    // the clear.
    request.onLog?.('build', `2supersecret${'y'.repeat(16_375)}`);
    await tick(world);

    const tails = liveLogTailEvents(world.publisher);
    expect(tails).toHaveLength(2);
    for (const t of tails) {
      expect(JSON.stringify(t)).not.toContain(SECRET);
      expect(JSON.stringify(t)).not.toContain('supersecret');
      expect(JSON.stringify(t)).not.toContain('persecret');
    }
    const sliced = must(must(tails[1]).jobs[0]);
    expect(sliced.omitted).toBeGreaterThan(0);
    expect(sliced.tail).toContain('***');

    blocking.release({
      jobs: [
        {
          jobId: 'build',
          conclusion: 'failure',
          startedAt: 1,
          finishedAt: 2,
          log: `deploying with ${SECRET}\n`,
          artifacts: [],
        },
      ],
      conclusion: 'failure',
    });
    await handle.idle();
    expect(JSON.stringify(world.publisher.publishedEvents)).not.toContain(
      SECRET
    );
    await handle.stop();
  });
});

describe('the closing replacement', () => {
  it('drops a job once its Job Result is published and carries what never got one', async () => {
    const { world, handle, blocking, request } = await streamingRun({
      workflows: { 'ci.yml': TWO_JOBS },
    });

    request.onLog?.('build', 'built\n');
    request.onLog?.('test', 'testing…\n');
    request.onLog?.(CI_RUNNER_CHANNEL_KEY, 'docker: daemon wedged\n');
    await tick(world);
    expect(
      must(liveLogTailEvents(world.publisher)[0]).jobs.map((j) => j.job)
    ).toEqual(['build', 'test']);

    // Only `build` comes back with a result; `test` never concluded.
    blocking.release({
      conclusion: 'failure',
      jobs: [
        {
          jobId: 'build',
          name: 'build',
          conclusion: 'success',
          exitCode: 0,
          startedAt: 1,
          finishedAt: 2,
          log: 'built\n',
          artifacts: [],
        },
      ],
    });
    await handle.idle();

    const tails = liveLogTailEvents(world.publisher);
    const closing = must(tails.at(-1));
    expect(closing.jobs).toEqual([
      { job: 'test', tail: 'testing…\n', omitted: 0 },
    ]);
    expect(must(closing.runner).tail).toBe('docker: daemon wedged\n');
    expect(jobEvents(world.publisher).map((j) => j.jobId)).toEqual(['build']);

    // And nothing more for the run: the event is left to expire.
    const kinds = publishedKinds(world.publisher);
    expect(kinds.lastIndexOf(CI_LIVE_LOG_TAIL_KIND)).toBeLessThan(
      kinds.indexOf(9842)
    );
    const published = world.publisher.publishedEvents.length;
    await tick(world, 5);
    expect(world.publisher.publishedEvents).toHaveLength(published);

    // The durable path is exactly what it was before the tail existed.
    expect(kinds.filter((k) => k !== CI_LIVE_LOG_TAIL_KIND)).toEqual(
      DURABLE_PUSH_RUN
    );
    await handle.stop();
  });

  it('carries the closing output of a timed-out run, which no earlier refresh could have caught', async () => {
    const world = makeWorld();
    const { announce, refsEvent } = world.snapshot(1000);
    world.relay.serve([announce, refsEvent, serviceRequest(MAINT, 1100)]);
    const started: RunnerRequest[] = [];
    // A runner killed at the wire: it says what happened on its way out, the
    // way act reports container cleanup after a timeout.
    const runner = new FakeRunner(
      (request) =>
        new Promise((resolve) => {
          started.push(request);
          request.signal?.addEventListener(
            'abort',
            () => {
              request.onLog?.('build', 'ERROR: killed at the wire\n');
              request.onLog?.(
                CI_RUNNER_CHANNEL_KEY,
                'removed 1 orphaned container\n'
              );
              resolve({
                conclusion: 'timed_out',
                jobs: [],
                startedAt: 1,
                finishedAt: 2,
              });
            },
            { once: true }
          );
        })
    );
    const timeoutMs = 55_000;
    const handle = await world.start({ runner, timeoutMs });

    push(world, 2000);
    await waitFor(() => started.length === 1, 'the run to start');
    await flush();
    must(started[0]).onLog?.('build', 'compiling\n');

    await tick(world, 5);
    const live = liveLogTailEvents(world.publisher);
    expect(live).toHaveLength(5);
    expect(JSON.stringify(live)).not.toContain('killed at the wire');

    // The run's budget expires: the runner is asked to stop, and what it says
    // on the way out is what the closing replacement carries.
    world.clock.advance(6_000);
    await handle.idle();

    const tails = liveLogTailEvents(world.publisher);
    const closing = must(tails.at(-1));
    expect(must(closing.jobs[0])).toEqual({
      job: 'build',
      tail: 'compiling\nERROR: killed at the wire\n',
      omitted: 0,
    });
    expect(must(closing.runner).tail).toBe('removed 1 orphaned container\n');
    expect(must(resultEvents(world.publisher)[0]).conclusion).toBe('timed_out');

    // A run never publishes more tails than the affordability check paid for.
    expect(tails.length).toBeLessThanOrEqual(liveLogTailEventBudget(timeoutMs));
    await handle.stop();
  });
});

describe('affordability', () => {
  it('publishes no tail for a run it cannot afford, because the run never starts', async () => {
    const world = makeWorld();
    const { announce, refsEvent } = world.snapshot(1000);
    world.relay.serve([announce, refsEvent, serviceRequest(MAINT, 1100)]);
    const handle = await world.start({ canAfford: async () => false });

    push(world, 2000);
    await handle.idle();
    await tick(world, 5);

    expect(world.runner.requests).toHaveLength(0);
    expect(liveLogTailEvents(world.publisher)).toHaveLength(0);
    expect(publishedKinds(world.publisher)).toEqual([]);
    await handle.stop();
  });
});
