/**
 * ActRunner tests (rig#125). The parsing half runs everywhere against
 * fixture lines captured from a real `act --json` run (act 0.2.89). The
 * execution half is the ONLY test in the package that touches Docker: it is
 * skipped unless an `act` binary is reachable (RIG_ACT_BIN or PATH) AND
 * `docker info` succeeds, so `pnpm -r test` never needs either.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ActRunner,
  actContainerNamePrefix,
  actEventName,
  buildActEventPayload,
  collectArtifacts,
  extractZip,
  parseActJsonLine,
  resolveActBinary,
  sanitizeActContainerName,
  summarizeActRun,
  type ActLine,
} from './act-runner.js';
import type { CiTriggerContext } from './nip-c1-events.js';
import type { RunnerRequest } from './runner.js';

// ---------------------------------------------------------------------------
// Fixture lines (verbatim shapes from act 0.2.89 `--json`)
// ---------------------------------------------------------------------------

const T0 = '2026-09-15T16:20:39-04:00';
const T1 = '2026-09-15T16:20:41-04:00';
const T2 = '2026-09-15T16:20:45-04:00';

function line(fields: Record<string, unknown>): string {
  return JSON.stringify({
    dryrun: false,
    level: 'info',
    matrix: {},
    time: T0,
    ...fields,
  });
}

const LINES = [
  line({
    job: 'probe/Build job',
    jobID: 'build',
    step: 'Set up job',
    msg: '⭐ Run Set up job',
  }),
  line({
    job: 'probe/failing  ',
    jobID: 'failing',
    step: 'Set up job',
    msg: '⭐ Run Set up job',
  }),
  line({
    job: 'probe/Build job',
    jobID: 'build',
    raw_output: true,
    stage: 'Main',
    step: 'echo hello',
    msg: 'hello\n',
    time: T1,
  }),
  line({
    job: 'probe/failing  ',
    jobID: 'failing',
    level: 'error',
    stage: 'Main',
    step: 'exit 3',
    msg: "exitcode '3': failure",
    time: T1,
  }),
  line({
    job: 'probe/Build job',
    jobID: 'build',
    raw_output: true,
    stage: 'Main',
    step: 'actions/upload-artifact@v4',
    msg: 'Artifact outputs has been successfully uploaded! Final size is 134 bytes.\n',
    time: T1,
  }),
  line({
    job: 'probe/failing  ',
    jobID: 'failing',
    jobResult: 'failure',
    msg: '🏁  Job failed',
    time: T2,
  }),
  line({
    job: 'probe/Build job',
    jobID: 'build',
    jobResult: 'success',
    msg: '🏁  Job succeeded',
    time: T2,
  }),
];

const TRIGGER: CiTriggerContext = {
  repoAddr: `30617:${'ab'.repeat(32)}:demo`,
  commit: 'c0'.repeat(20),
  workflow: { path: '.github/workflows/ci.yml', sha256: '0'.repeat(64) },
  reason: 'push',
  ref: 'refs/heads/main',
};

describe('parseActJsonLine', () => {
  it('parses a step output line', () => {
    const parsed = parseActJsonLine(LINES[2] as string);
    expect(parsed).toMatchObject({
      jobId: 'build',
      jobName: 'Build job',
      rawOutput: true,
      msg: 'hello\n',
      level: 'info',
      timeMs: Date.parse(T1),
    });
  });

  it('parses the jobResult terminal line and the exitcode error line', () => {
    expect(parseActJsonLine(LINES[6] as string)).toMatchObject({
      jobId: 'build',
      jobResult: 'success',
    });
    expect(parseActJsonLine(LINES[3] as string)).toMatchObject({
      jobId: 'failing',
      level: 'error',
      exitCode: 3,
    });
  });

  it('trims the padded job display name and drops the workflow prefix', () => {
    expect(parseActJsonLine(LINES[1] as string)?.jobName).toBe('failing');
  });

  it('returns null for non-JSON and for lines without a jobID', () => {
    expect(parseActJsonLine('Error: Job failed')).toBeNull();
    expect(
      parseActJsonLine('{"level":"info","msg":"Start server"}')
    ).toBeNull();
    expect(parseActJsonLine('')).toBeNull();
  });
});

describe('summarizeActRun', () => {
  const parsed = LINES.map(parseActJsonLine).filter(
    (l): l is ActLine => l !== null
  );

  it('groups logs per job, takes jobResult as the conclusion, and records exit codes', () => {
    const run = summarizeActRun(parsed, {
      exitCode: 1,
      timedOut: false,
      cancelled: false,
    });
    expect(run.conclusion).toBe('failure');
    expect(run.jobs.map((j) => [j.jobId, j.conclusion, j.exitCode])).toEqual([
      ['build', 'success', 0],
      ['failing', 'failure', 3],
    ]);
    const build = run.jobs[0];
    expect(build?.name).toBe('Build job');
    expect(build?.log).toContain('hello\n');
    expect(build?.log).toContain('⭐ Run Set up job\n');
    expect(build?.log).not.toContain('exitcode');
    expect(build?.startedAt).toBe(Math.floor(Date.parse(T0) / 1000));
    expect(build?.finishedAt).toBe(Math.floor(Date.parse(T2) / 1000));
  });

  it('is success only when every job succeeded or was skipped', () => {
    const ok = summarizeActRun(
      parsed.filter((l) => l.jobId === 'build'),
      { exitCode: 0, timedOut: false, cancelled: false }
    );
    expect(ok.conclusion).toBe('success');
    const skipped = summarizeActRun(
      [
        ...parsed.filter((l) => l.jobId === 'build'),
        {
          jobId: 'lint',
          jobName: 'lint',
          msg: 'skipped',
          level: 'info',
          rawOutput: false,
          jobResult: 'skipped',
          timeMs: 0,
        },
      ],
      { exitCode: 0, timedOut: false, cancelled: false }
    );
    expect(skipped.conclusion).toBe('success');
    expect(skipped.jobs[1]?.conclusion).toBe('skipped');
  });

  it('marks a job with no result as failure when act exited non-zero', () => {
    const noResult = parsed.filter((l) => l.jobResult === undefined);
    const run = summarizeActRun(noResult, {
      exitCode: 1,
      timedOut: false,
      cancelled: false,
    });
    expect(run.jobs.every((j) => j.conclusion === 'failure')).toBe(true);
    expect(run.conclusion).toBe('failure');
  });

  it('marks unfinished jobs timed_out / cancelled when the run was', () => {
    const noResult = parsed.filter((l) => l.jobResult === undefined);
    expect(
      summarizeActRun(noResult, {
        exitCode: null,
        timedOut: true,
        cancelled: false,
      }).conclusion
    ).toBe('timed_out');
    expect(
      summarizeActRun(noResult, {
        exitCode: null,
        timedOut: false,
        cancelled: true,
      }).conclusion
    ).toBe('cancelled');
  });

  it('overrides act\'s teardown "failure" with timed_out when WE killed the run', () => {
    // act reports the job it tears down on SIGTERM as failure; a job that
    // finished successfully before the kill keeps its own conclusion.
    const run = summarizeActRun(parsed, {
      exitCode: null,
      timedOut: true,
      cancelled: false,
    });
    expect(run.jobs.map((j) => [j.jobId, j.conclusion])).toEqual([
      ['build', 'success'],
      ['failing', 'timed_out'],
    ]);
    expect(run.conclusion).toBe('timed_out');
  });

  it('is startup_failure when act produced no job lines and exited non-zero', () => {
    const run = summarizeActRun([], {
      exitCode: 1,
      timedOut: false,
      cancelled: false,
    });
    expect(run.conclusion).toBe('startup_failure');
    expect(run.jobs).toEqual([]);
  });
});

describe('sanitizeActContainerName / actContainerNamePrefix', () => {
  // Observed with act 0.2.89: `.github/workflows/hang.yml` (no `name:`),
  // job `hang` → this container name.
  const OBSERVED =
    'act-hang-yml-hang-1296543966e1f3d735d80c8622483e916239a677c40863504f9ca8aa694072c6';

  it('mirrors act: non-alphanumerics → "-", one pass of "--" → "-", cut to 63, trailing "-" trimmed', () => {
    expect(sanitizeActContainerName('act-hang.yml/hang')).toBe(
      'act-hang-yml-hang'
    );
    expect(sanitizeActContainerName('a---b')).toBe('a--b');
    expect(sanitizeActContainerName('x'.repeat(70) + '-')).toBe('x'.repeat(63));
    expect(sanitizeActContainerName('a' + '-'.repeat(70))).toBe('a');
  });

  it('derives the per-workflow prefix that the observed container name starts with', () => {
    const prefix = actContainerNamePrefix('hang.yml');
    expect(prefix).toBe('act-hang-yml-');
    expect(OBSERVED.startsWith(prefix)).toBe(true);
    // act's single "--" → "-" pass turns " / " into "--", not "-".
    expect(actContainerNamePrefix('My CI / Build')).toBe('act-My-CI--Build-');
    expect(actContainerNamePrefix('ci-')).toBe('act-ci-');
  });

  it('cuts an over-long prefix at 63 characters like the real name', () => {
    const prefix = actContainerNamePrefix('w'.repeat(80));
    expect(prefix).toHaveLength(63);
    expect(prefix).toBe(`act-${'w'.repeat(59)}`);
  });
});

describe('actEventName / buildActEventPayload', () => {
  it('maps trigger reasons to act event names', () => {
    expect(actEventName({ ...TRIGGER, reason: 'push' }, {})).toBe('push');
    expect(actEventName({ ...TRIGGER, reason: 'pull_request' }, {})).toBe(
      'pull_request'
    );
    // A manual replay uses an event the workflow declares, so `on: push`
    // workflows still run (NIP-C1: replay need not declare `manual`).
    expect(actEventName({ ...TRIGGER, reason: 'manual' }, { push: {} })).toBe(
      'push'
    );
    expect(
      actEventName({ ...TRIGGER, reason: 'manual' }, { pull_request: {} })
    ).toBe('pull_request');
    expect(actEventName({ ...TRIGGER, reason: 'manual' }, {})).toBe(
      'workflow_dispatch'
    );
  });

  it('builds a push payload with ref + after and a PR payload with head/base', () => {
    expect(buildActEventPayload(TRIGGER)).toMatchObject({
      ref: 'refs/heads/main',
      after: TRIGGER.commit,
      head_commit: { id: TRIGGER.commit },
    });
    const pr = buildActEventPayload({
      ...TRIGGER,
      reason: 'pull_request',
      ref: undefined,
      pr: {
        prEventId: 'e1',
        prAuthor: 'p1',
        prKind: 1618,
        sourceEventId: 'e1',
        sourceAuthor: 'p1',
        sourceKind: 1618,
      },
    });
    expect(pr).toMatchObject({
      action: 'synchronize',
      pull_request: { head: { sha: TRIGGER.commit }, base: { ref: 'main' } },
    });
  });
});

// ---------------------------------------------------------------------------
// Zip + artifact collection (act stores each named artifact as one zip)
// ---------------------------------------------------------------------------

const cleanups: string[] = [];
afterEach(() => {
  for (const dir of cleanups.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(dir);
  return dir;
}

/** Build a zip with python (deflate + data descriptor, like upload-artifact). */
function pythonZip(zipPath: string, files: Record<string, string>): boolean {
  try {
    execFileSync('python3', [
      '-c',
      `import zipfile,json,sys
files=json.loads(sys.argv[2])
with zipfile.ZipFile(sys.argv[1],'w',zipfile.ZIP_DEFLATED) as z:
    for k,v in files.items(): z.writestr(k,v)`,
      zipPath,
      JSON.stringify(files),
    ]);
    return true;
  } catch {
    return false;
  }
}

describe('extractZip / collectArtifacts', () => {
  it('extracts deflated + stored entries (central-directory driven)', () => {
    const dir = tmp('rig-zip-');
    const zipPath = join(dir, 'a.zip');
    if (
      !pythonZip(zipPath, {
        'out.txt': 'x=1\n',
        'nested/deep.txt': 'y'.repeat(5000),
      })
    ) {
      return; // no python3 on this box — the Docker-gated test covers act's real zips
    }
    const out = join(dir, 'out');
    const files = extractZip(zipPath, out);
    expect(files.sort()).toEqual(['nested/deep.txt', 'out.txt']);
    expect(existsSync(join(out, 'nested', 'deep.txt'))).toBe(true);
  });

  it('refuses zip entries that escape the destination', () => {
    const dir = tmp('rig-zip-');
    const zipPath = join(dir, 'evil.zip');
    if (!pythonZip(zipPath, { '../escape.txt': 'no' })) return;
    expect(() => extractZip(zipPath, join(dir, 'out'))).toThrow(/escape/);
  });

  it('walks <artifactDir>/<run>/<name>/, unpacking zips into one entry per file', () => {
    const dir = tmp('rig-art-');
    mkdirSync(join(dir, '1', 'outputs'), { recursive: true });
    mkdirSync(join(dir, '1', 'plain'), { recursive: true });
    writeFileSync(join(dir, '1', 'plain', 'report.txt'), 'r');
    if (
      !pythonZip(join(dir, '1', 'outputs', 'outputs.zip'), {
        'out.txt': 'x=1\n',
      })
    )
      return;
    const artifacts = collectArtifacts(dir);
    expect(artifacts.map((a) => [a.name, a.filename]).sort()).toEqual([
      ['outputs', 'out.txt'],
      ['plain', 'report.txt'],
    ]);
    for (const a of artifacts) expect(existsSync(a.path)).toBe(true);
  });

  it('returns [] for a missing artifact dir', () => {
    expect(collectArtifacts(join(tmp('rig-art-'), 'nope'))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The Docker-gated execution test
// ---------------------------------------------------------------------------

function dockerReachable(): boolean {
  try {
    execFileSync('docker', ['info'], { stdio: 'ignore', timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

const ACT_BIN = resolveActBinary(process.env);
const CAN_RUN = ACT_BIN !== null && dockerReachable();

function git(cwd: string, args: string[]): string {
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

const E2E_WORKFLOW = `name: e2e
on: push
jobs:
  build:
    name: Build it
    runs-on: ubuntu-latest
    steps:
      - run: echo hello from rig && echo "x=1" > out.txt && echo "TOKEN_LEN=\${#MY_TOKEN}"
        env:
          MY_TOKEN: \${{ secrets.MY_TOKEN }}
      - uses: actions/upload-artifact@v4
        with:
          name: outputs
          path: out.txt
`;

describe.skipIf(!CAN_RUN)('ActRunner against real act + Docker', () => {
  it(
    'runs a trivial workflow: success, log captured, secret injected, artifact collected',
    async () => {
      const repo = tmp('rig-act-e2e-');
      mkdirSync(join(repo, '.github', 'workflows'), { recursive: true });
      writeFileSync(join(repo, '.github', 'workflows', 'ci.yml'), E2E_WORKFLOW);
      git(repo, ['init', '-q']);
      git(repo, ['add', '-A']);
      git(repo, ['commit', '-qm', 'init']);
      const commit = git(repo, ['rev-parse', 'HEAD']);

      const runner = new ActRunner({
        actBin: ACT_BIN as string,
        artifactDir: tmp('rig-act-artifacts-'),
      });
      const chunks: string[] = [];
      const request: RunnerRequest = {
        checkoutDir: repo,
        workflow: { path: '.github/workflows/ci.yml', sha256: '0'.repeat(64) },
        trigger: { ...TRIGGER, commit },
        secrets: { MY_TOKEN: 'abcdef' },
        timeoutMs: 4 * 60_000,
        onLog: (_jobId, chunk) => chunks.push(chunk),
      };
      const result = await runner.run(request);

      expect(result.conclusion).toBe('success');
      expect(result.jobs).toHaveLength(1);
      const job = result.jobs[0];
      expect(job).toMatchObject({
        jobId: 'build',
        name: 'Build it',
        conclusion: 'success',
        exitCode: 0,
      });
      expect(job?.log).toContain('hello from rig');
      expect(job?.log).toContain('TOKEN_LEN=6');
      expect(job?.log).not.toContain('abcdef');
      expect(chunks.join('')).toContain('hello from rig');
      expect(job?.artifacts.map((a) => [a.name, a.filename])).toEqual([
        ['outputs', 'out.txt'],
      ]);
      expect(existsSync(job?.artifacts[0]?.path ?? '')).toBe(true);
    },
    5 * 60_000
  );

  it(
    'concludes timed_out when the wall clock expires',
    async () => {
      const repo = tmp('rig-act-timeout-');
      mkdirSync(join(repo, '.github', 'workflows'), { recursive: true });
      writeFileSync(
        join(repo, '.github', 'workflows', 'ci.yml'),
        'on: push\njobs:\n  slow:\n    runs-on: ubuntu-latest\n    steps:\n      - run: sleep 300\n'
      );
      git(repo, ['init', '-q']);
      git(repo, ['add', '-A']);
      git(repo, ['commit', '-qm', 'init']);
      const notes: string[] = [];
      const runner = new ActRunner({
        actBin: ACT_BIN as string,
        warn: (line) => notes.push(line),
      });
      const result = await runner.run({
        checkoutDir: repo,
        workflow: { path: '.github/workflows/ci.yml', sha256: '0'.repeat(64) },
        trigger: { ...TRIGGER, commit: git(repo, ['rev-parse', 'HEAD']) },
        secrets: {},
        // act takes ~20-25 s to create the job container on a warm image;
        // the wall clock must expire AFTER that, or there is nothing to leak.
        timeoutMs: 60_000,
      });
      expect(result.conclusion).toBe('timed_out');
      // act 0.2.89 leaves the job container running after SIGTERM; the
      // runner must have removed it (the sleep would otherwise outlive us).
      const leftover = execFileSync(
        'docker',
        ['ps', '-aq', '--filter', `name=^${actContainerNamePrefix('ci.yml')}`],
        { encoding: 'utf-8' }
      ).trim();
      expect(leftover).toBe('');
      expect(notes.some((n) => n.includes('removed 1 job container'))).toBe(
        true
      );
    },
    3 * 60_000
  );
});
