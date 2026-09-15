/**
 * ActRunner (rig#125) — the first `Runner` implementation: shell out to
 * `act` (nektos/act) against the host Docker daemon, in the coordinator's
 * own process. This is the "coordinator is its own compute provider" shape
 * ngit's reference coordinator uses today; a TOON-lease runner replaces it
 * later behind the same ./runner.ts interface without touching the
 * coordinator.
 *
 * What crosses the seam and how:
 *
 *   - The checkout is a real git repository at the run's commit, already
 *     materialized by the coordinator from the relay + Arweave. act copies
 *     it into the job container itself (`-C <dir>`), so `actions/checkout`
 *     steps resolve to the local copy and never reach GitHub. Other
 *     GitHub-hosted actions ARE fetched by act — the accepted dependency the
 *     spec names.
 *   - Secrets go in as `-s NAME` with the VALUE in the child's environment,
 *     never on argv (argv is world-readable via /proc). act masks them in
 *     its output.
 *   - The event payload (`-e <file>`) carries the ref/sha or the PR
 *     head/base so `github.*` context in workflows is truthful.
 *   - Logs are act's `--json` line stream, grouped per `jobID`; the
 *     terminal `jobResult` field is each job's conclusion, passed through
 *     as NIP-C1 wants ("preserve the execution backend's conclusion").
 *   - Artifacts: `--artifact-server-path` makes `actions/upload-artifact`
 *     work; act stores each named artifact as ONE zip under
 *     `<dir>/<run>/<name>/<name>.zip`, which is unpacked here so every file
 *     becomes its own `artifact` tag (NIP-C1 forbids archives).
 *
 * All child-process arguments are ARRAYS (never a shell), matching the rest
 * of the package.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { accessSync, constants } from 'node:fs';
import type { CiConclusion, CiTriggerContext } from './nip-c1-events.js';
import type {
  Runner,
  RunnerArtifact,
  RunnerJobResult,
  RunnerRequest,
  RunnerRunResult,
} from './runner.js';
import { parseWorkflow, type WorkflowTriggers } from './workflows.js';

/** Environment variable naming the act binary (overrides PATH lookup). */
export const RIG_ACT_BIN_ENV = 'RIG_ACT_BIN';

/** Default `-P` platform mapping: the community act image for ubuntu-latest. */
export const DEFAULT_ACT_PLATFORMS: Readonly<Record<string, string>> = {
  'ubuntu-latest': 'catthehacker/ubuntu:act-latest',
};

export interface ActRunnerOptions {
  /** act executable; default `RIG_ACT_BIN` env, else `act` on PATH. */
  actBin?: string;
  /** `runs-on` label → Docker image (`-P label=image`). */
  platforms?: Record<string, string>;
  /** Where act's artifact server stores uploads; default a fresh temp dir per run. */
  artifactDir?: string;
  /** Pass `--pull=false` (use local images only). Default: act's own default (pull). */
  pull?: boolean;
  /** Grace period between SIGTERM and SIGKILL on timeout/cancel (ms). */
  killGraceMs?: number;
}

// ---------------------------------------------------------------------------
// Binary resolution
// ---------------------------------------------------------------------------

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Find an act binary: `RIG_ACT_BIN` (must exist), else the first `act` on
 * PATH. Returns null when neither is present — the coordinator refuses to
 * start and the Docker-gated test skips.
 */
export function resolveActBinary(env: NodeJS.ProcessEnv, explicit?: string): string | null {
  const candidate = explicit ?? env[RIG_ACT_BIN_ENV];
  if (candidate) return isExecutable(candidate) ? candidate : null;
  for (const dir of (env['PATH'] ?? '').split(':')) {
    if (!dir) continue;
    const p = join(dir, 'act');
    if (isExecutable(p)) return p;
  }
  return null;
}

// ---------------------------------------------------------------------------
// act --json line parsing (pure)
// ---------------------------------------------------------------------------

/** One decoded line of act's `--json` stream that belongs to a job. */
export interface ActLine {
  jobId: string;
  /** act's display name minus the `<workflow>/` prefix and padding. */
  jobName: string;
  msg: string;
  level: string;
  /** Step stdout/stderr (as opposed to act's own narration). */
  rawOutput: boolean;
  /** Present on the job's terminal line. */
  jobResult?: string;
  /** Parsed from act's `exitcode '<n>': failure` error line. */
  exitCode?: number;
  /** Epoch milliseconds from the line's `time` field (0 when absent). */
  timeMs: number;
}

const EXITCODE_RE = /^exitcode '(\d+)'/;

/** Decode one line; null for non-JSON lines or lines without a `jobID`. */
export function parseActJsonLine(line: string): ActLine | null {
  if (!line.startsWith('{')) return null;
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
  const jobId = obj['jobID'];
  if (typeof jobId !== 'string' || jobId === '') return null;
  const display = typeof obj['job'] === 'string' ? obj['job'] : jobId;
  const slash = display.indexOf('/');
  const jobName = (slash >= 0 ? display.slice(slash + 1) : display).trim() || jobId;
  const msg = typeof obj['msg'] === 'string' ? obj['msg'] : '';
  const out: ActLine = {
    jobId,
    jobName,
    msg,
    level: typeof obj['level'] === 'string' ? obj['level'] : 'info',
    rawOutput: obj['raw_output'] === true,
    timeMs: typeof obj['time'] === 'string' ? Date.parse(obj['time']) || 0 : 0,
  };
  if (typeof obj['jobResult'] === 'string') out.jobResult = obj['jobResult'];
  const exit = EXITCODE_RE.exec(msg);
  if (exit) out.exitCode = Number(exit[1]);
  return out;
}

export interface ActRunOutcome {
  /** act's exit code, or null when it was killed. */
  exitCode: number | null;
  timedOut: boolean;
  cancelled: boolean;
}

export interface ActJobSummary {
  jobId: string;
  name: string;
  conclusion: CiConclusion;
  exitCode?: number;
  log: string;
  startedAt: number;
  finishedAt: number;
}

export interface ActRunSummary {
  conclusion: CiConclusion;
  jobs: ActJobSummary[];
}

/**
 * act's verdict for one job, corrected for a run WE ended: act reports the
 * job it tears down on SIGTERM as `failure`, but that failure is our kill,
 * not the job's — so once the wall clock expired (or the run was cancelled)
 * only jobs that already finished cleanly keep their own conclusion.
 */
function mapJobResult(result: string | undefined, outcome: ActRunOutcome): CiConclusion {
  if (result === 'success') return 'success';
  if (result === 'skipped') return 'skipped';
  if (outcome.timedOut) return 'timed_out';
  if (outcome.cancelled) return 'cancelled';
  switch (result) {
    case 'failure':
      return 'failure';
    case 'cancelled':
      return 'cancelled';
    default:
      return outcome.exitCode === 0 ? 'success' : 'failure';
  }
}

/**
 * Fold the job lines into per-job results and one combined conclusion.
 * The combined verdict is act's own where it has one (a failed job fails
 * the run); an unfinished run is `timed_out`/`cancelled`; no job lines at
 * all with a non-zero exit is `startup_failure` (act could not even plan
 * the workflow — parse error, missing image, bad `runs-on`).
 */
export function summarizeActRun(lines: ActLine[], outcome: ActRunOutcome): ActRunSummary {
  const byJob = new Map<string, ActLine[]>();
  for (const l of lines) {
    const list = byJob.get(l.jobId);
    if (list) list.push(l);
    else byJob.set(l.jobId, [l]);
  }
  const jobs: ActJobSummary[] = [];
  for (const [jobId, list] of byJob) {
    const terminal = list.find((l) => l.jobResult !== undefined);
    const exitLine = list.find((l) => l.exitCode !== undefined);
    const conclusion = mapJobResult(terminal?.jobResult, outcome);
    const times = list.map((l) => l.timeMs).filter((t) => t > 0);
    const startedAt = times.length > 0 ? Math.floor(Math.min(...times) / 1000) : 0;
    const finishedAt = times.length > 0 ? Math.floor(Math.max(...times) / 1000) : 0;
    const log = list
      .filter((l) => l.exitCode === undefined)
      .map((l) => (l.rawOutput || l.msg.endsWith('\n') ? l.msg : `${l.msg}\n`))
      .join('');
    const job: ActJobSummary = {
      jobId,
      name: list[0]?.jobName ?? jobId,
      conclusion,
      log,
      startedAt,
      finishedAt,
    };
    if (exitLine?.exitCode !== undefined) job.exitCode = exitLine.exitCode;
    else if (conclusion === 'success') job.exitCode = 0;
    jobs.push(job);
  }

  let conclusion: CiConclusion;
  if (jobs.length === 0) {
    conclusion = outcome.timedOut
      ? 'timed_out'
      : outcome.cancelled
        ? 'cancelled'
        : outcome.exitCode === 0
          ? 'success'
          : 'startup_failure';
  } else if (outcome.timedOut && jobs.some((j) => j.conclusion === 'timed_out')) {
    conclusion = 'timed_out';
  } else if (outcome.cancelled && jobs.some((j) => j.conclusion === 'cancelled')) {
    conclusion = 'cancelled';
  } else if (jobs.some((j) => j.conclusion === 'failure')) {
    conclusion = 'failure';
  } else if (jobs.some((j) => j.conclusion === 'timed_out')) {
    conclusion = 'timed_out';
  } else if (jobs.some((j) => j.conclusion === 'cancelled')) {
    conclusion = 'cancelled';
  } else {
    conclusion = 'success';
  }
  return { conclusion, jobs };
}

// ---------------------------------------------------------------------------
// Event name + payload (pure)
// ---------------------------------------------------------------------------

/**
 * The act event for a trigger. A manual replay (NIP-C1 `o: manual`) runs a
 * workflow that need not declare `workflow_dispatch`, so it borrows the
 * first event the workflow DOES declare — otherwise act would plan no jobs.
 */
export function actEventName(trigger: CiTriggerContext, triggers: WorkflowTriggers): string {
  if (trigger.reason === 'push') return 'push';
  if (trigger.reason === 'pull_request') return 'pull_request';
  if (triggers.push) return 'push';
  if (triggers.pull_request) return 'pull_request';
  return 'workflow_dispatch';
}

function shortBranch(ref: string | undefined): string {
  if (!ref) return 'main';
  return ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
}

/** The `github.event` payload act reads from `-e`. */
export function buildActEventPayload(trigger: CiTriggerContext): Record<string, unknown> {
  if (trigger.reason === 'pull_request' && trigger.pr) {
    const base = shortBranch(trigger.ref);
    return {
      action: 'synchronize',
      number: 0,
      ref: `refs/pull/0/merge`,
      pull_request: {
        number: 0,
        head: { sha: trigger.commit, ref: trigger.commit.slice(0, 12) },
        base: { ref: base },
      },
    };
  }
  return {
    ref: trigger.ref ?? 'refs/heads/main',
    before: '0'.repeat(40),
    after: trigger.commit,
    head_commit: { id: trigger.commit },
  };
}

// ---------------------------------------------------------------------------
// Zip extraction (central-directory driven: upload-artifact zips use data
// descriptors, so local headers carry zero sizes) + artifact collection
// ---------------------------------------------------------------------------

const EOCD_SIG = 0x06054b50;
const CDIR_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

/**
 * Extract a (non-zip64) zip into `destDir`, returning the extracted entry
 * names (forward-slash relative paths). Directory entries are skipped;
 * entries that would escape `destDir` throw.
 */
export function extractZip(zipPath: string, destDir: string): string[] {
  const buf = readFileSync(zipPath);
  // Find the End Of Central Directory record (scan back over the comment).
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error(`not a zip file: ${zipPath}`);
  const entryCount = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  if (offset === 0xffffffff) throw new Error(`zip64 archives are not supported: ${zipPath}`);

  const root = resolve(destDir);
  const names: string[] = [];
  for (let n = 0; n < entryCount; n++) {
    if (buf.readUInt32LE(offset) !== CDIR_SIG) throw new Error(`corrupt central directory: ${zipPath}`);
    const method = buf.readUInt16LE(offset + 10);
    const compSize = buf.readUInt32LE(offset + 20);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const localOffset = buf.readUInt32LE(offset + 42);
    const name = buf.toString('utf-8', offset + 46, offset + 46 + nameLen);
    offset += 46 + nameLen + extraLen + commentLen;

    if (name.endsWith('/')) continue;
    const target = resolve(root, name);
    if (target !== root && !target.startsWith(root + sep)) {
      throw new Error(`zip entry would escape the destination: ${JSON.stringify(name)}`);
    }
    if (buf.readUInt32LE(localOffset) !== LOCAL_SIG) throw new Error(`corrupt local header: ${zipPath}`);
    const localNameLen = buf.readUInt16LE(localOffset + 26);
    const localExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const data = buf.subarray(dataStart, dataStart + compSize);
    let bytes: Buffer;
    if (method === 0) bytes = Buffer.from(data);
    else if (method === 8) bytes = inflateRawSync(data);
    else throw new Error(`unsupported zip compression method ${method} in ${zipPath}`);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, bytes);
    names.push(name);
  }
  return names;
}

function walkFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name)
  )) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(p));
    else if (entry.isFile()) out.push(p);
  }
  return out;
}

/**
 * Turn act's artifact-server tree (`<dir>/<run>/<name>/…`) into one
 * {@link RunnerArtifact} per FILE. Zips are unpacked beside themselves into
 * `<name>/unpacked/`; anything else is listed as-is.
 */
export function collectArtifacts(artifactDir: string): RunnerArtifact[] {
  if (!existsSync(artifactDir)) return [];
  const out: RunnerArtifact[] = [];
  for (const run of readdirSync(artifactDir, { withFileTypes: true })) {
    if (!run.isDirectory()) continue;
    const runDir = join(artifactDir, run.name);
    for (const art of readdirSync(runDir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name)
    )) {
      if (!art.isDirectory()) continue;
      const artDir = join(runDir, art.name);
      const unpackedDir = join(artDir, 'unpacked');
      for (const file of walkFiles(artDir)) {
        if (file.startsWith(unpackedDir + sep)) continue;
        if (file.toLowerCase().endsWith('.zip')) {
          for (const name of extractZip(file, unpackedDir)) {
            out.push({ path: join(unpackedDir, name), filename: name, name: art.name });
          }
        } else {
          out.push({
            path: file,
            filename: relative(artDir, file).split(sep).join('/'),
            name: art.name,
          });
        }
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The Runner
// ---------------------------------------------------------------------------

/** Shell out to `act` on the host Docker daemon. See the module header. */
export class ActRunner implements Runner {
  readonly family = 'act' as const;
  readonly selectors: string[];
  private readonly platforms: Record<string, string>;

  constructor(private readonly options: ActRunnerOptions = {}) {
    this.platforms = options.platforms ?? { ...DEFAULT_ACT_PLATFORMS };
    this.selectors = Object.keys(this.platforms);
  }

  /** The resolved act binary, or null when none is available. */
  binary(env: NodeJS.ProcessEnv = process.env): string | null {
    return resolveActBinary(env, this.options.actBin);
  }

  async run(request: RunnerRequest): Promise<RunnerRunResult> {
    const startedAt = Math.floor(Date.now() / 1000);
    const bin = this.binary();
    if (bin === null) {
      return startupFailure(startedAt, 'act binary not found (set RIG_ACT_BIN or install act)');
    }

    const workflowText = readFileSync(join(request.checkoutDir, request.workflow.path));
    const parsed = parseWorkflow(request.workflow.path, workflowText);
    if (parsed.parseError !== undefined) {
      return startupFailure(startedAt, `workflow parse error: ${parsed.parseError}`);
    }

    const scratch = await mkdtemp(join(tmpdir(), 'rig-act-'));
    const artifactDir = this.options.artifactDir ?? join(scratch, 'artifacts');
    mkdirSync(artifactDir, { recursive: true });
    const eventPath = join(scratch, 'event.json');
    writeFileSync(eventPath, JSON.stringify(buildActEventPayload(request.trigger)));

    const args = [
      actEventName(request.trigger, parsed.triggers),
      '-W',
      request.workflow.path,
      '-C',
      request.checkoutDir,
      '--json',
      '-e',
      eventPath,
      '--artifact-server-path',
      artifactDir,
    ];
    if (this.options.pull === false) args.push('--pull=false');
    for (const [label, image] of Object.entries(this.platforms)) {
      args.push('-P', `${label}=${image}`);
    }
    for (const name of Object.keys(request.secrets)) args.push('-s', name);
    for (const name of Object.keys(request.env ?? {})) args.push('--env', name);

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...request.env,
      ...request.secrets,
    };

    const lines: ActLine[] = [];
    let timedOut = false;
    let cancelled = false;
    const grace = this.options.killGraceMs ?? 10_000;

    const exitCode = await new Promise<number | null>((resolveExit) => {
      const child = spawn(bin, args, {
        cwd: request.checkoutDir,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const kill = (): void => {
        child.kill('SIGTERM');
        killTimer = setTimeout(() => child.kill('SIGKILL'), grace);
      };
      const timeout = setTimeout(() => {
        timedOut = true;
        kill();
      }, request.timeoutMs);
      const onAbort = (): void => {
        cancelled = true;
        kill();
      };
      if (request.signal?.aborted) onAbort();
      else request.signal?.addEventListener('abort', onAbort, { once: true });

      const consume = (stream: NodeJS.ReadableStream): void => {
        let buffered = '';
        stream.setEncoding('utf-8');
        stream.on('data', (chunk: string) => {
          buffered += chunk;
          let nl: number;
          while ((nl = buffered.indexOf('\n')) >= 0) {
            const line = buffered.slice(0, nl);
            buffered = buffered.slice(nl + 1);
            const parsedLine = parseActJsonLine(line);
            if (!parsedLine) continue;
            lines.push(parsedLine);
            if (request.onLog && parsedLine.exitCode === undefined) {
              request.onLog(
                parsedLine.jobId,
                parsedLine.rawOutput || parsedLine.msg.endsWith('\n')
                  ? parsedLine.msg
                  : `${parsedLine.msg}\n`
              );
            }
          }
        });
        stream.on('end', () => {
          const parsedLine = parseActJsonLine(buffered);
          if (parsedLine) lines.push(parsedLine);
        });
      };
      consume(child.stdout);
      consume(child.stderr);

      child.on('error', () => resolveExit(null));
      child.on('close', (code) => {
        clearTimeout(timeout);
        if (killTimer) clearTimeout(killTimer);
        request.signal?.removeEventListener('abort', onAbort);
        resolveExit(code);
      });
    });

    const summary = summarizeActRun(lines, { exitCode, timedOut, cancelled });
    const artifacts = collectArtifacts(artifactDir);
    const finishedAt = Math.floor(Date.now() / 1000);

    // act's artifact server does not record which job uploaded what; the
    // uploading job announces "Artifact <name> has been successfully
    // uploaded" in its log, so attribute by that line, else to the first job.
    const jobs: RunnerJobResult[] = summary.jobs.map((j) => ({
      jobId: j.jobId,
      name: j.name,
      conclusion: j.conclusion,
      ...(j.exitCode !== undefined ? { exitCode: j.exitCode } : {}),
      startedAt: j.startedAt || startedAt,
      finishedAt: j.finishedAt || finishedAt,
      log: j.log,
      artifacts: [],
    }));
    for (const artifact of artifacts) {
      const owner =
        jobs.find((j) => j.log.includes(`Artifact ${artifact.name} has been successfully uploaded`)) ??
        jobs[0];
      owner?.artifacts.push(artifact);
    }

    // Keep the scratch dir when it holds the artifacts the caller will read.
    if (this.options.artifactDir !== undefined) {
      await rm(scratch, { recursive: true, force: true });
    }

    return { conclusion: summary.conclusion, jobs, startedAt, finishedAt };
  }
}

function startupFailure(startedAt: number, reason: string): RunnerRunResult {
  return {
    conclusion: 'startup_failure',
    startedAt,
    finishedAt: Math.floor(Date.now() / 1000),
    jobs: [
      {
        jobId: 'startup',
        conclusion: 'startup_failure',
        startedAt,
        finishedAt: Math.floor(Date.now() / 1000),
        log: `${reason}\n`,
        artifacts: [],
      },
    ],
  };
}
