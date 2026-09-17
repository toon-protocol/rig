/**
 * The Runner seam (rig#125) — the ONE new interface the relay-native CI
 * layer introduces. The coordinator (./coordinator.ts) materializes a commit,
 * picks a workflow, decides the secret set, and hands all of that to a
 * Runner; the Runner executes the jobs and reports per-job conclusions, exit
 * codes, timings, logs and artifact files. Nothing about relays, payments,
 * or NIP-C1 events crosses this boundary in either direction.
 *
 * Two implementations exist today:
 *
 *   - {@link FakeRunner} (here): scripted outcomes for coordinator tests.
 *   - `ActRunner` (./act-runner.ts): shells out to `act` against the host
 *     Docker daemon — the first-slice "coordinator is its own runner" shape
 *     ngit's reference coordinator also uses.
 *
 * A later TOON-lease runner (rent a workload from a TOON Network provider,
 * blocked on TOON_Network Milestone 1) is a third class behind the SAME
 * interface; that is the whole point of the seam.
 */

import type { CiConclusion, CiTriggerContext } from './nip-c1-events.js';

/** One artifact file a job produced (one entry per FILE, never an archive). */
export interface RunnerArtifact {
  /** Absolute path of the file on the coordinator host. */
  path: string;
  /** The file's path within the artifact (mirrors upload-artifact). */
  filename: string;
  /** The artifact name grouping related files. */
  name: string;
}

/** The outcome of one job within a run. */
export interface RunnerJobResult {
  /** Job id as declared in the workflow file. */
  jobId: string;
  /** Human-readable job name, when the workflow declares one. */
  name?: string;
  conclusion: CiConclusion;
  exitCode?: number;
  /** Unix seconds. */
  startedAt: number;
  /** Unix seconds. */
  finishedAt: number;
  /** The job's complete log output. */
  log: string;
  artifacts: RunnerArtifact[];
}

/** The outcome of one workflow run. */
export interface RunnerRunResult {
  /** Combined conclusion — the execution backend's own verdict, passed through. */
  conclusion: CiConclusion;
  jobs: RunnerJobResult[];
  startedAt: number;
  finishedAt: number;
}

/** Everything a Runner needs to execute one workflow once. */
export interface RunnerRequest {
  /** A real git repository, checked out at `trigger.commit`. */
  checkoutDir: string;
  /** Workflow file path relative to `checkoutDir`, plus its content SHA-256. */
  workflow: { path: string; sha256: string };
  trigger: CiTriggerContext;
  /** Secrets to inject; `{}` for runs the coordinator did not authorize secrets for. */
  secrets: Record<string, string>;
  /** Extra environment for the jobs. */
  env?: Record<string, string>;
  /** Wall-clock budget for the whole run; exceeding it concludes `timed_out`. */
  timeoutMs: number;
  /**
   * Streaming log sink, called with a job id as output is produced. Output
   * the runner attributes to no job — its own account of executing the run —
   * goes to the RUNNER CHANNEL: the reserved key `CI_RUNNER_CHANNEL_KEY`
   * exported by ./nip-c1-events.ts, which no workflow job id can equal.
   */
  onLog?: (jobId: string, chunk: string) => void;
  /** Cancels the run (concludes `cancelled`). */
  signal?: AbortSignal;
}

/** Executes one workflow run. See the module header. */
export interface Runner {
  /** Runner family, as advertised in the NIP-C1 `W` tag. */
  readonly family: 'act';
  /** Accepted selectors for the family (`R` = `act:<selector>`). */
  readonly selectors: string[];
  run(request: RunnerRequest): Promise<RunnerRunResult>;
}

// ---------------------------------------------------------------------------
// FakeRunner — scripted outcomes for tests
// ---------------------------------------------------------------------------

export type FakeRunnerScript = (
  request: RunnerRequest
) => RunnerRunResult | Promise<RunnerRunResult>;

/** The default script: one successful `build` job with a short log. */
export function defaultFakeRunResult(request: RunnerRequest): RunnerRunResult {
  const now = Math.floor(Date.now() / 1000);
  return {
    conclusion: 'success',
    startedAt: now,
    finishedAt: now,
    jobs: [
      {
        jobId: 'build',
        name: 'build',
        conclusion: 'success',
        exitCode: 0,
        startedAt: now,
        finishedAt: now,
        log: `fake runner: ran ${request.workflow.path} at ${request.trigger.commit}\n`,
        artifacts: [],
      },
    ],
  };
}

/**
 * A Runner that returns scripted outcomes and records every request, so a
 * coordinator test can assert on what was asked (secrets, timeout, commit)
 * and drive the publish sequence from a chosen result. Never touches Docker.
 */
export class FakeRunner implements Runner {
  readonly family = 'act' as const;
  readonly selectors = ['ubuntu-latest'];
  /** Every request, in call order. */
  readonly requests: RunnerRequest[] = [];

  constructor(
    private readonly script: FakeRunnerScript = defaultFakeRunResult
  ) {}

  async run(request: RunnerRequest): Promise<RunnerRunResult> {
    const sink = request.onLog;
    // A script that streams nothing still gets its jobs' logs replayed
    // through the sink, so a test that only scripts an outcome still
    // exercises a coordinator's streaming path. A script that DOES stream
    // (chunk by chunk, while the test drives the clock) is left alone: the
    // replay would double-emit every byte it had already sent, which no real
    // runner does. The two are told apart per job, so a script may stream
    // some jobs and let the rest replay.
    const streamed = new Set<string>();
    const scripted: RunnerRequest = sink
      ? {
          ...request,
          onLog: (jobId, chunk) => {
            streamed.add(jobId);
            sink(jobId, chunk);
          },
        }
      : request;
    this.requests.push(scripted);
    const result = await this.script(scripted);
    if (sink) {
      for (const job of result.jobs) {
        if (!streamed.has(job.jobId)) sink(job.jobId, job.log);
      }
    }
    return result;
  }
}
