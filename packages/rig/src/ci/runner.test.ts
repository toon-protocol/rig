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

  it('reports a multi-job workflow job by job: mixed conclusions, exit codes, timings, logs, artifacts', async () => {
    const runner = new FakeRunner(() => ({
      conclusion: 'failure',
      startedAt: 100,
      finishedAt: 130,
      jobs: [
        {
          jobId: 'build',
          name: 'Build it',
          conclusion: 'success',
          exitCode: 0,
          startedAt: 100,
          finishedAt: 110,
          log: 'compiling\n',
          artifacts: [
            {
              path: '/tmp/art/outputs/out.txt',
              filename: 'out.txt',
              name: 'outputs',
            },
          ],
        },
        {
          jobId: 'test',
          conclusion: 'failure',
          exitCode: 2,
          startedAt: 110,
          finishedAt: 130,
          log: '1 test failed\n',
          artifacts: [],
        },
        {
          jobId: 'docs',
          conclusion: 'skipped',
          startedAt: 130,
          finishedAt: 130,
          log: '',
          artifacts: [],
        },
      ],
    }));
    const streamed: [string, string][] = [];
    const result = await runner.run({
      ...REQUEST,
      onLog: (jobId, chunk) => streamed.push([jobId, chunk]),
    });

    expect(result.conclusion).toBe('failure');
    expect(result.jobs.map((j) => j.jobId)).toEqual(['build', 'test', 'docs']);
    expect(result.jobs.map((j) => [j.conclusion, j.exitCode])).toEqual([
      ['success', 0],
      ['failure', 2],
      ['skipped', undefined],
    ]);
    for (const job of result.jobs) {
      expect(job.finishedAt).toBeGreaterThanOrEqual(job.startedAt);
      expect(job.startedAt).toBeGreaterThanOrEqual(result.startedAt);
      expect(job.finishedAt).toBeLessThanOrEqual(result.finishedAt);
    }
    expect(result.jobs[0]?.artifacts).toEqual([
      {
        path: '/tmp/art/outputs/out.txt',
        filename: 'out.txt',
        name: 'outputs',
      },
    ]);
    expect(result.jobs[1]?.log).toBe('1 test failed\n');
    // One onLog call per job, in job order.
    expect(streamed).toEqual([
      ['build', 'compiling\n'],
      ['test', '1 test failed\n'],
      ['docs', ''],
    ]);
  });

  it('does not replay a job whose log the script already streamed', async () => {
    const runner = new FakeRunner((request) => {
      request.onLog?.('build', 'compiling\n');
      request.onLog?.('build', 'linking\n');
      return {
        conclusion: 'success',
        startedAt: 10,
        finishedAt: 20,
        jobs: [
          {
            jobId: 'build',
            conclusion: 'success',
            startedAt: 10,
            finishedAt: 15,
            log: 'compiling\nlinking\n',
            artifacts: [],
          },
          {
            jobId: 'docs',
            conclusion: 'success',
            startedAt: 15,
            finishedAt: 20,
            log: 'rendered\n',
            artifacts: [],
          },
        ],
      };
    });
    const seen: [string, string][] = [];
    await runner.run({
      ...REQUEST,
      onLog: (jobId, chunk) => seen.push([jobId, chunk]),
    });
    // `build` streamed itself, so replaying its log would double every byte;
    // `docs` did not, so it is still replayed.
    expect(seen).toEqual([
      ['build', 'compiling\n'],
      ['build', 'linking\n'],
      ['docs', 'rendered\n'],
    ]);
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
