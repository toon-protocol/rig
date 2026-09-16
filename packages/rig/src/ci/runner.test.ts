/**
 * The Runner seam (rig#125): the one interface the coordinator drives, plus
 * the scripted FakeRunner every coordinator test uses instead of Docker.
 */

import { describe, it, expect } from 'vitest';
import { FakeRunner, type RunnerRequest } from './runner.js';

const REQUEST: RunnerRequest = {
  checkoutDir: '/tmp/checkout',
  workflow: { path: '.github/workflows/ci.yml', sha256: 'ab'.repeat(32) },
  trigger: {
    repoAddr: `30617:${'ab'.repeat(32)}:demo`,
    commit: 'c0'.repeat(20),
    workflow: { path: '.github/workflows/ci.yml', sha256: 'ab'.repeat(32) },
    reason: 'push',
    ref: 'refs/heads/main',
  },
  secrets: {},
  timeoutMs: 60_000,
};

describe('FakeRunner', () => {
  it('reports family act and a default selector', () => {
    const runner = new FakeRunner();
    expect(runner.family).toBe('act');
    expect(runner.selectors).toEqual(['ubuntu-latest']);
  });

  it('defaults to one successful "build" job with a short log', async () => {
    const runner = new FakeRunner();
    const result = await runner.run(REQUEST);
    expect(result.conclusion).toBe('success');
    expect(result.jobs).toHaveLength(1);
    expect(result.jobs[0]).toMatchObject({
      jobId: 'build',
      conclusion: 'success',
      exitCode: 0,
      artifacts: [],
    });
    expect(result.jobs[0]?.log.length).toBeGreaterThan(0);
    expect(result.finishedAt).toBeGreaterThanOrEqual(result.startedAt);
  });

  it('records every request it is given, in order', async () => {
    const runner = new FakeRunner();
    await runner.run(REQUEST);
    await runner.run({ ...REQUEST, secrets: { TOKEN: 'x' } });
    expect(runner.requests).toHaveLength(2);
    expect(runner.requests[1]?.secrets).toEqual({ TOKEN: 'x' });
  });

  it('runs a scripted outcome (sync or async) per request', async () => {
    const runner = new FakeRunner(async (req) => ({
      conclusion: 'failure',
      startedAt: 10,
      finishedAt: 20,
      jobs: [
        {
          jobId: 'test',
          conclusion: 'failure',
          exitCode: 1,
          startedAt: 10,
          finishedAt: 20,
          log: `failed for ${req.trigger.commit}`,
          artifacts: [],
        },
      ],
    }));
    const result = await runner.run(REQUEST);
    expect(result.conclusion).toBe('failure');
    expect(result.jobs[0]?.log).toContain(REQUEST.trigger.commit);
  });

  it('streams the scripted job logs to onLog when a sink is given', async () => {
    const runner = new FakeRunner();
    const seen: [string, string][] = [];
    await runner.run({
      ...REQUEST,
      onLog: (jobId, chunk) => seen.push([jobId, chunk]),
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.[0]).toBe('build');
  });
});
