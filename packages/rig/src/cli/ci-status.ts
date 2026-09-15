/**
 * `rig ci status <commit>` — the FREE read side of relay-native CI (#125):
 * every NIP-C1 run (kind:9842 Workflow Result / kind:39842 Workflow
 * Progress) and job (kind:9841 Job Result) a relay holds for one commit of
 * one repo, with each run's trust level derived from the repo's maintainers
 * (kind:30617) and the Service Request / Stop history (kind:9843/9844).
 *
 * It is the one-command merge gate: exit 0 only when every COUNTED run has
 * concluded green. A run counts when it is the latest attempt by its
 * publisher for its workflow, survives `--workflow` and
 * `--require-ci-trust`, and — since the relay is permissionless — a
 * stranger's coordinator can never make a commit green under a trust
 * requirement it does not meet. A commit with no concluded run is NOT green
 * (exit 1, "no concluded run"), so a gate cannot pass by accident.
 *
 * Like the #278 tracker reads: no identity, no payment, reads may target
 * several relays (merged by event id), and `--json` emits exactly one
 * document.
 */

import { parseArgs } from 'node:util';
import { REPOSITORY_ANNOUNCEMENT_KIND } from '@toon-protocol/core/nip34';
import {
  CI_JOB_RESULT_KIND,
  CI_SERVICE_REQUEST_KIND,
  CI_SERVICE_STOP_KIND,
  CI_WORKFLOW_PROGRESS_KIND,
  CI_WORKFLOW_RESULT_KIND,
  parseCiJobResult,
  parseCiServiceControl,
  parseCiWorkflowProgress,
  parseCiWorkflowResult,
  repoAddress,
  type CiArtifact,
  type CiConclusion,
  type CiProgressStatus,
  type CiProvenance,
  type CiTriggerReason,
  type CiWorkflowRef,
  type ServiceControl,
} from '../ci/nip-c1-events.js';
import {
  CI_TRUST_ORDER,
  deriveTrustLevel,
  isCiTrustLevel,
  trustAtLeast,
  type CiTrustLevel,
} from '../ci/trust.js';
import { runGit } from '../materialize.js';
import { authorizedStatusAuthors } from '../nip34-events.js';
import { hexToNpub, ownerToHex } from '../npub.js';
import {
  queryRelay,
  type NostrEvent,
  type NostrFilter,
  type WebSocketFactory,
  type WebSocketLike,
} from '../remote-state.js';
import {
  emitCliError,
  InvalidRelayUrlError,
  UnconfiguredRepoAddressError,
} from './errors.js';
import { readToonConfig, resolveRepoRoot } from './git-config.js';
import type { ReadCommandDeps } from './read-seams.js';
import { resolveRelays } from './remote.js';

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

export const CI_STATUS_USAGE = `Usage: rig ci status <commit> [options]

Show every CI run and job for <commit> — FREE (relay reads only). <commit>
is a full 40-hex SHA, or any local revision (HEAD, a branch, a short SHA)
when run inside the repository. Exit status is the gate: 0 when every
counted run concluded green (success/neutral/skipped); 1 when any counted
run failed, timed out, was cancelled, or failed to start, when a run is
still queued/in progress, or when the commit has no concluded run at all.

A run counts when it is its publisher's latest attempt for its workflow.
Trust levels (NIP-C1, derived from the repo's maintainers and Service
Requests): maintainer-directed > operationally-associated > seen-in-network
> no-known-context. With --require-ci-trust, runs below that level are
dropped before counting — so an unknown coordinator's green never gates.

Options:
  --require-ci-trust <level>   minimum trust level to count a run
  --workflow <path>            only runs of this workflow file
  --repo-id <id>       repository id / NIP-34 d-tag (default: git config)
  --owner <pubkey>     repository owner (npub or 64-char hex; default: git config)
  --remote <name>      read via this configured git remote (default: origin)
  --relay <url>        ad-hoc relay override; repeatable — reads are merged
  --json               machine-readable envelope (exactly one JSON document)
  -h, --help           show this help`;

// ---------------------------------------------------------------------------
// Types (the JSON envelope)
// ---------------------------------------------------------------------------

export interface CiStatusJob {
  jobId: string;
  name?: string;
  conclusion: CiConclusion;
  logsUrl?: string;
  artifacts: CiArtifact[];
  exitCode?: number;
  startedAt?: number;
  eventId: string;
  publisher: string;
}

export interface CiStatusRun {
  runId: string;
  coordinator: string;
  workflow: CiWorkflowRef;
  reason: CiTriggerReason;
  status: CiProgressStatus;
  conclusion?: CiConclusion;
  trust: CiTrustLevel;
  createdAt: number;
  startedAt?: number;
  queuedAt?: number;
  provenance?: CiProvenance;
  jobs: CiStatusJob[];
  /** Event id of the 9842 (concluded) or the latest 39842. */
  eventId: string;
}

export interface CiStatusSummary {
  counted: number;
  green: number;
  red: number;
  pending: number;
}

export interface CiStatusReport {
  command: 'ci status';
  commit: string;
  repo: { owner: string; repoId: string };
  relays: string[];
  requiredTrust: CiTrustLevel | null;
  runs: CiStatusRun[];
  summary: CiStatusSummary;
  ok: boolean;
  /** Why `ok` is false, for humans and logs. */
  reason?: string;
}

const GREEN: ReadonlySet<CiConclusion> = new Set([
  'success',
  'neutral',
  'skipped',
]);

// ---------------------------------------------------------------------------
// Flags
// ---------------------------------------------------------------------------

interface StatusFlags {
  json: boolean;
  help: boolean;
  relay: string[];
  remote?: string;
  repoId?: string;
  owner?: string;
  requireTrust?: CiTrustLevel;
  workflow?: string;
}

const STATUS_OPTIONS = {
  json: { type: 'boolean', default: false },
  relay: { type: 'string', multiple: true },
  remote: { type: 'string' },
  'repo-id': { type: 'string' },
  owner: { type: 'string' },
  'require-ci-trust': { type: 'string' },
  workflow: { type: 'string' },
  help: { type: 'boolean', short: 'h', default: false },
} as const;

const FULL_SHA_RE = /^[0-9a-f]{40}$/;
const WS_URL_RE = /^wss?:\/\//i;
const RELAY_TIMEOUT_MS = 10_000;

function defaultWebSocketFactory(url: string): WebSocketLike {
  const ctor = (
    globalThis as { WebSocket?: new (url: string) => WebSocketLike }
  ).WebSocket;
  if (!ctor) {
    throw new Error(
      'No global WebSocket constructor (Node >= 22 required) — pass webSocketFactory'
    );
  }
  return new ctor(url);
}

/** Query every relay with every filter; merge by id; throw only if ALL fail. */
async function queryAll(
  relays: string[],
  filters: NostrFilter[],
  webSocketFactory: WebSocketFactory
): Promise<NostrEvent[]> {
  const jobs = relays.flatMap((relay) =>
    filters.map((filter) =>
      queryRelay(relay, filter, RELAY_TIMEOUT_MS, webSocketFactory)
    )
  );
  const results = await Promise.allSettled(jobs);
  const byId = new Map<string, NostrEvent>();
  let failures = 0;
  let firstError: unknown;
  for (const result of results) {
    if (result.status === 'rejected') {
      failures += 1;
      firstError ??= result.reason;
      continue;
    }
    for (const event of result.value) {
      if (typeof event.id === 'string' && !byId.has(event.id))
        byId.set(event.id, event);
    }
  }
  if (failures === results.length && results.length > 0) {
    throw firstError instanceof Error
      ? firstError
      : new Error(String(firstError));
  }
  return [...byId.values()];
}

// ---------------------------------------------------------------------------
// Pure assembly (exported for tests)
// ---------------------------------------------------------------------------

export interface AssembleStatusOptions {
  commit: string;
  ownerPubkey: string;
  repoId: string;
  /** Owner ∪ declared maintainers (lowercase hex). */
  authorized: Set<string>;
  events: NostrEvent[];
  requireTrust?: CiTrustLevel;
  workflow?: string;
}

/**
 * Turn relay events into the run list + verdict. Runs are keyed by
 * (publisher, runId): a 9842 marks the run concluded; otherwise the newest
 * 39842 (by created_at) gives its status. Jobs attach by the 9841's quoted
 * progress address. Per (publisher, workflow path) only the LATEST attempt
 * (by created_at, ties → lowest id) counts.
 */
export function assembleCiStatus(opts: AssembleStatusOptions): {
  runs: CiStatusRun[];
  summary: CiStatusSummary;
  ok: boolean;
  reason?: string;
} {
  const repoAddr = repoAddress(opts.ownerPubkey, opts.repoId);
  const commit = opts.commit.toLowerCase();

  const controls: ServiceControl[] = [];
  const results = new Map<string, ReturnType<typeof parseCiWorkflowResult>>();
  const progresses = new Map<
    string,
    NonNullable<ReturnType<typeof parseCiWorkflowProgress>>
  >();
  const jobs: NonNullable<ReturnType<typeof parseCiJobResult>>[] = [];

  for (const ev of opts.events) {
    switch (ev.kind) {
      case CI_SERVICE_REQUEST_KIND:
      case CI_SERVICE_STOP_KIND: {
        const c = parseCiServiceControl(ev);
        if (c && c.repoAddr === repoAddr) controls.push(c);
        break;
      }
      case CI_WORKFLOW_RESULT_KIND: {
        const r = parseCiWorkflowResult(ev);
        if (
          !r ||
          r.trigger.repoAddr !== repoAddr ||
          r.trigger.commit !== commit
        )
          break;
        const key = `${r.pubkey}:${r.runId}`;
        const prev = results.get(key);
        if (
          !prev ||
          r.createdAt > prev.createdAt ||
          (r.createdAt === prev.createdAt && r.eventId < prev.eventId)
        ) {
          results.set(key, r);
        }
        break;
      }
      case CI_WORKFLOW_PROGRESS_KIND: {
        const p = parseCiWorkflowProgress(ev);
        if (
          !p ||
          p.trigger.repoAddr !== repoAddr ||
          p.trigger.commit !== commit
        )
          break;
        const key = `${p.pubkey}:${p.runId}`;
        const prev = progresses.get(key);
        if (
          !prev ||
          p.createdAt > prev.createdAt ||
          (p.createdAt === prev.createdAt && p.eventId < prev.eventId)
        ) {
          progresses.set(key, p);
        }
        break;
      }
      case CI_JOB_RESULT_KIND: {
        const j = parseCiJobResult(ev);
        if (j && j.trigger.repoAddr === repoAddr && j.trigger.commit === commit)
          jobs.push(j);
        break;
      }
      default:
        break;
    }
  }

  const runs: CiStatusRun[] = [];
  const keys = new Set([...results.keys(), ...progresses.keys()]);
  for (const key of keys) {
    const result = results.get(key) ?? null;
    const progress = progresses.get(key) ?? null;
    const base = result ?? progress;
    if (!base) continue;
    const progressAddress = `${CI_WORKFLOW_PROGRESS_KIND}:${base.pubkey}:${base.runId}`;
    const runJobs = jobs
      .filter(
        (j) => j.progressAddress.toLowerCase() === progressAddress.toLowerCase()
      )
      .sort(
        (a, b) => (a.startedAt ?? a.createdAt) - (b.startedAt ?? b.createdAt)
      )
      .map<CiStatusJob>((j) => ({
        jobId: j.jobId,
        ...(j.name !== undefined ? { name: j.name } : {}),
        conclusion: j.conclusion,
        ...(j.logsUrl !== undefined ? { logsUrl: j.logsUrl } : {}),
        artifacts: j.artifacts,
        ...(j.exitCode !== undefined ? { exitCode: j.exitCode } : {}),
        ...(j.startedAt !== undefined ? { startedAt: j.startedAt } : {}),
        eventId: j.eventId,
        publisher: j.pubkey,
      }));
    const provenance = result?.provenance ?? progress?.provenance;
    const trust = deriveTrustLevel({
      publisherPubkey: base.pubkey,
      ...(provenance ? { provenance } : {}),
      authorized: opts.authorized,
      controls,
      runCreatedAt: base.createdAt,
    });
    const status: CiProgressStatus = result
      ? 'concluded'
      : (progress as NonNullable<typeof progress>).status;
    const conclusion = result ? result.conclusion : progress?.conclusion;
    const startedAt = result?.startedAt ?? progress?.startedAt;
    const queuedAt = result?.queuedAt ?? progress?.queuedAt;
    runs.push({
      runId: base.runId,
      coordinator: base.pubkey,
      workflow: base.trigger.workflow,
      reason: base.trigger.reason,
      status,
      ...(conclusion !== undefined ? { conclusion } : {}),
      trust,
      createdAt: base.createdAt,
      ...(startedAt !== undefined ? { startedAt } : {}),
      ...(queuedAt !== undefined ? { queuedAt } : {}),
      ...(provenance ? { provenance } : {}),
      jobs: runJobs,
      eventId: base.eventId,
    });
  }
  runs.sort(
    (a, b) => b.createdAt - a.createdAt || (a.eventId < b.eventId ? -1 : 1)
  );

  // Latest attempt per (publisher, workflow path) is the one that counts.
  const latestByWorkflow = new Map<string, CiStatusRun>();
  for (const run of runs) {
    const k = `${run.coordinator}:${run.workflow.path}`;
    if (!latestByWorkflow.has(k)) latestByWorkflow.set(k, run); // runs are newest-first
  }
  const counted = [...latestByWorkflow.values()].filter(
    (run) =>
      (opts.workflow === undefined || run.workflow.path === opts.workflow) &&
      (opts.requireTrust === undefined ||
        trustAtLeast(run.trust, opts.requireTrust))
  );

  let green = 0;
  let red = 0;
  let pending = 0;
  for (const run of counted) {
    if (run.status !== 'concluded' || run.conclusion === undefined)
      pending += 1;
    else if (GREEN.has(run.conclusion)) green += 1;
    else red += 1;
  }
  const summary: CiStatusSummary = {
    counted: counted.length,
    green,
    red,
    pending,
  };
  let reason: string | undefined;
  if (counted.length === 0) {
    reason =
      runs.length === 0
        ? 'no CI runs found for this commit'
        : 'no run meets the workflow/trust requirement';
  } else if (red > 0) {
    reason = `${red} run(s) concluded red`;
  } else if (pending > 0) {
    reason = `${pending} run(s) not concluded yet`;
  }
  const ok = counted.length > 0 && red === 0 && pending === 0;
  return { runs, summary, ok, ...(reason !== undefined ? { reason } : {}) };
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

/** Run `rig ci status …` (free); returns the process exit code. */
export async function runCiStatus(
  args: string[],
  deps: ReadCommandDeps
): Promise<number> {
  const { io } = deps;
  let flags: StatusFlags;
  let commitArg: string;
  try {
    const { values, positionals } = parseArgs({
      args,
      options: STATUS_OPTIONS,
      allowPositionals: true,
    });
    flags = {
      json: values.json === true,
      help: values.help === true,
      relay: values.relay ?? [],
    };
    if (values.remote !== undefined) flags.remote = values.remote;
    if (values['repo-id'] !== undefined) flags.repoId = values['repo-id'];
    if (values.owner !== undefined) flags.owner = ownerToHex(values.owner);
    if (values.workflow !== undefined)
      flags.workflow = values.workflow.replace(/^\.\//, '');
    if (values['require-ci-trust'] !== undefined) {
      const level = values['require-ci-trust'];
      if (!isCiTrustLevel(level)) {
        throw new Error(
          `--require-ci-trust must be one of ${CI_TRUST_ORDER.join(' | ')} (got ${JSON.stringify(level)})`
        );
      }
      flags.requireTrust = level;
    }
    if (flags.help) {
      io.out(CI_STATUS_USAGE);
      return 0;
    }
    if (positionals.length !== 1) {
      throw new Error(
        positionals.length === 0
          ? '<commit> is required'
          : `expected exactly one <commit>, got ${positionals.length}`
      );
    }
    commitArg = positionals[0] as string;
  } catch (err) {
    io.err(err instanceof Error ? err.message : String(err));
    io.err(CI_STATUS_USAGE);
    return 2;
  }

  try {
    // ── Repo address + relays (best-effort git config; flags stand alone) ──
    let repoRoot: string | undefined;
    let toonConfig: { repoId?: string; owner?: string; relays: string[] } = {
      relays: [],
    };
    try {
      repoRoot = await resolveRepoRoot(deps.cwd);
      toonConfig = await readToonConfig(repoRoot);
    } catch {
      // Not inside a git repo — flags must carry everything.
    }
    const repoId = flags.repoId ?? toonConfig.repoId;
    if (!repoId) throw new UnconfiguredRepoAddressError('repository id');
    const owner = flags.owner ?? toonConfig.owner;
    if (!owner) throw new UnconfiguredRepoAddressError('repository owner');

    let commit = commitArg.toLowerCase();
    if (!FULL_SHA_RE.test(commit)) {
      if (repoRoot === undefined) {
        throw new Error(
          `<commit> must be a full 40-hex SHA outside a git repository (got ${JSON.stringify(commitArg)})`
        );
      }
      commit = (
        await runGit(repoRoot, [
          'rev-parse',
          '--verify',
          `${commitArg}^{commit}`,
        ])
      ).trim();
    }

    const resolved = await resolveRelays({
      relayFlags: flags.relay,
      remoteName: flags.remote,
      repoRoot,
      toonRelays: toonConfig.relays,
    });
    const relays = resolved.relays.filter((url) => WS_URL_RE.test(url));
    if (relays.length === 0) {
      throw new InvalidRelayUrlError(
        resolved.relays[0] ?? '',
        'reads need a ws:// or wss:// relay'
      );
    }
    const webSocketFactory = deps.webSocketFactory ?? defaultWebSocketFactory;
    const repoAddr = repoAddress(owner, repoId);

    // ── Reads ──────────────────────────────────────────────────────────────
    const events = await queryAll(
      relays,
      [
        {
          kinds: [
            CI_WORKFLOW_RESULT_KIND,
            CI_WORKFLOW_PROGRESS_KIND,
            CI_JOB_RESULT_KIND,
          ],
          '#a': [repoAddr],
          '#c': [commit],
        },
        {
          kinds: [CI_SERVICE_REQUEST_KIND, CI_SERVICE_STOP_KIND],
          '#a': [repoAddr],
        },
        {
          kinds: [REPOSITORY_ANNOUNCEMENT_KIND],
          authors: [owner],
          '#d': [repoId],
        },
      ],
      webSocketFactory
    );
    // Authority: the owner's own latest 30617 for this d-tag; owner-only when
    // absent (an unresolved announcement never widens authority).
    let announce: NostrEvent | null = null;
    for (const ev of events) {
      if (
        ev.kind !== REPOSITORY_ANNOUNCEMENT_KIND ||
        ev.pubkey.toLowerCase() !== owner
      )
        continue;
      if (!ev.tags.some((t) => t[0] === 'd' && t[1] === repoId)) continue;
      if (
        announce === null ||
        ev.created_at > announce.created_at ||
        (ev.created_at === announce.created_at && ev.id < announce.id)
      ) {
        announce = ev;
      }
    }
    const authorized = authorizedStatusAuthors(owner, announce?.tags ?? []);

    const assembled = assembleCiStatus({
      commit,
      ownerPubkey: owner,
      repoId,
      authorized,
      events,
      ...(flags.requireTrust !== undefined
        ? { requireTrust: flags.requireTrust }
        : {}),
      ...(flags.workflow !== undefined ? { workflow: flags.workflow } : {}),
    });

    const report: CiStatusReport = {
      command: 'ci status',
      commit,
      repo: { owner, repoId },
      relays,
      requiredTrust: flags.requireTrust ?? null,
      runs: assembled.runs,
      summary: assembled.summary,
      ok: assembled.ok,
      ...(assembled.reason !== undefined ? { reason: assembled.reason } : {}),
    };

    if (flags.json) {
      io.emitJson(report);
    } else {
      for (const line of renderStatus(report)) io.out(line);
    }
    return report.ok ? 0 : 1;
  } catch (err) {
    return emitCliError(io, flags.json, 'ci status', err);
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function glyph(run: CiStatusRun): string {
  if (run.status !== 'concluded' || run.conclusion === undefined) return '…';
  return GREEN.has(run.conclusion) ? '✓' : '✗';
}

function shortNpub(hex: string): string {
  try {
    const npub = hexToNpub(hex);
    return `${npub.slice(0, 12)}…${npub.slice(-4)}`;
  } catch {
    return `${hex.slice(0, 12)}…`;
  }
}

/** Human lines: one per run (newest first), jobs indented, then the verdict. */
export function renderStatus(report: CiStatusReport): string[] {
  const lines: string[] = [];
  lines.push(
    `CI for ${report.commit.slice(0, 12)} in 30617:${report.repo.owner}:${report.repo.repoId}`
  );
  if (report.runs.length === 0) {
    lines.push('  (no runs)');
  }
  for (const run of report.runs) {
    const state =
      run.status === 'concluded' ? (run.conclusion ?? 'concluded') : run.status;
    lines.push(
      `${glyph(run)} ${state.padEnd(15)} ${run.workflow.path}  ${run.reason}  ` +
        `coordinator ${shortNpub(run.coordinator)}  trust ${run.trust}`
    );
    for (const job of run.jobs) {
      const extra = job.exitCode !== undefined ? ` (exit ${job.exitCode})` : '';
      lines.push(
        `    ${job.conclusion.padEnd(15)} ${job.name ?? job.jobId}${extra}`
      );
    }
  }
  const s = report.summary;
  const verdict = report.ok
    ? 'GREEN'
    : `NOT GREEN — ${report.reason ?? 'see runs'}`;
  lines.push(
    `${verdict} (counted ${s.counted}: ${s.green} green, ${s.red} red, ${s.pending} pending` +
      (report.requiredTrust ? `; trust ≥ ${report.requiredTrust}` : '') +
      ')'
  );
  return lines;
}
