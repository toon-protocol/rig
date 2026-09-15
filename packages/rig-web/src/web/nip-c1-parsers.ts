/**
 * NIP-C1 (Nostr CI) parsers for rig-web (rig#125).
 *
 * The wire contract is docs/specs/nip-c1.md: a Coordinator watches a NIP-34
 * repo on the relay, runs its Workflows, and publishes Workflow Progress
 * (kind:39842, addressable per run), Job Results (kind:9841) and Workflow
 * Results (kind:9842). Maintainers authorize a Coordinator with a Service
 * Request (kind:9843) and revoke it with a Service Stop (kind:9844).
 *
 * Same posture as ./nip34-parsers.ts: rig-web does NOT import
 * `@toon-protocol/rig` (payment-side deps would land in the browser bundle),
 * so these parsers and the trust derivation are a self-contained COPY of the
 * ones in `packages/rig/src/ci/`. Keep the two in step.
 *
 * Trust is derived CLIENT-SIDE (#287 spirit): the relay is permissionless, so
 * a run is only as trustworthy as its relationship to the repo's declared
 * maintainers, which {@link deriveTrustLevel} reads off the Service Requests.
 */

import { getTagValue, getTagValues, type NostrEvent } from './nip34-parsers.js';

// ---------------------------------------------------------------------------
// Kinds + enumerations
// ---------------------------------------------------------------------------

export const CI_ADVERTISEMENT_KIND = 19843;
export const CI_SERVICE_REQUEST_KIND = 9843;
export const CI_SERVICE_STOP_KIND = 9844;
export const CI_SECRET_UPDATE_KIND = 29846;
export const CI_MANUAL_TRIGGER_KIND = 9840;
export const CI_JOB_RESULT_KIND = 9841;
export const CI_WORKFLOW_RESULT_KIND = 9842;
export const CI_WORKFLOW_PROGRESS_KIND = 39842;

/** Conclusion values, aligned with the GitHub API `conclusion` field. */
export type CiConclusion =
  | 'success'
  | 'failure'
  | 'neutral'
  | 'cancelled'
  | 'skipped'
  | 'timed_out'
  | 'startup_failure';

const CONCLUSIONS: ReadonlySet<string> = new Set<CiConclusion>([
  'success',
  'failure',
  'neutral',
  'cancelled',
  'skipped',
  'timed_out',
  'startup_failure',
]);

export type CiProgressStatus = 'queued' | 'in_progress' | 'concluded';
const PROGRESS_STATUSES: ReadonlySet<string> = new Set<CiProgressStatus>([
  'queued',
  'in_progress',
  'concluded',
]);

export type CiTriggerReason = 'push' | 'pull_request' | 'manual';
const TRIGGER_REASONS: ReadonlySet<string> = new Set<CiTriggerReason>([
  'push',
  'pull_request',
  'manual',
]);

/** How a run relates to the repo's maintainers (strongest first). */
export type CiTrustLevel =
  | 'maintainer-directed'
  | 'operationally-associated'
  | 'seen-in-network'
  | 'no-known-context';

export const CI_TRUST_ORDER: readonly CiTrustLevel[] = [
  'maintainer-directed',
  'operationally-associated',
  'seen-in-network',
  'no-known-context',
];

/** True when `level` is at least as strong as `required`. */
export function trustAtLeast(level: CiTrustLevel, required: CiTrustLevel): boolean {
  return CI_TRUST_ORDER.indexOf(level) <= CI_TRUST_ORDER.indexOf(required);
}

// ---------------------------------------------------------------------------
// Repo addresses
// ---------------------------------------------------------------------------

/** `30617:<owner-hex>:<repo-id>` — the NIP-34 repository coordinate. */
export type RepoAddress = string;

const HEX64_RE = /^[0-9a-f]{64}$/;

export function repoAddress(ownerPubkey: string, repoId: string): RepoAddress {
  return `30617:${ownerPubkey.toLowerCase()}:${repoId}`;
}

export function parseRepoAddress(
  addr: string
): { ownerPubkey: string; repoId: string } | null {
  const first = addr.indexOf(':');
  const second = first === -1 ? -1 : addr.indexOf(':', first + 1);
  if (first === -1 || second === -1) return null;
  const kind = addr.slice(0, first);
  const ownerPubkey = addr.slice(first + 1, second).toLowerCase();
  const repoId = addr.slice(second + 1);
  if (kind !== '30617' || !HEX64_RE.test(ownerPubkey) || repoId === '') return null;
  return { ownerPubkey, repoId };
}

// ---------------------------------------------------------------------------
// Trigger context (the NIP-C1 "common tags")
// ---------------------------------------------------------------------------

export interface CiWorkflowRef {
  path: string;
  sha256: string;
}

/**
 * NIP-22 PR context of a pull_request run. `prKind` 1617 is rig's departure
 * from the NIP (which names 1618 only): `rig pr create` publishes 1617
 * patches, so a rig coordinator quotes them as the PR root.
 */
export interface CiPrContext {
  prEventId: string;
  prAuthor: string;
  prKind: 1617 | 1618;
  sourceEventId: string;
  sourceAuthor: string;
  sourceKind: 1617 | 1618 | 1619;
}

export interface CiTriggerContext {
  repoAddr: RepoAddress;
  extraRepoAddrs?: string[];
  commit: string;
  tagObjectIds?: string[];
  workflow: CiWorkflowRef;
  reason: CiTriggerReason;
  /** `refs/...` git ref for push (and optionally manual) runs. */
  ref?: string;
  pr?: CiPrContext;
}

function asPrKind(value: string | undefined): 1617 | 1618 | undefined {
  if (value === '1617') return 1617;
  if (value === '1618') return 1618;
  return undefined;
}

function asSourceKind(value: string | undefined): 1617 | 1618 | 1619 | undefined {
  if (value === '1619') return 1619;
  return asPrKind(value);
}

/**
 * Parse the common + trigger-context tags shared by 9840/9841/9842/39842.
 * `defaultReason` supplies `o` when the event carries none (a Manual
 * Trigger is always normalized as `manual`). Returns null unless `a`, `c`
 * and a two-value `w` are present and the reason is known.
 */
export function parseCiTriggerContext(
  tags: string[][],
  defaultReason?: CiTriggerReason
): CiTriggerContext | null {
  const addrs = getTagValues(tags, 'a');
  const commits = getTagValues(tags, 'c');
  const wTag = tags.find((t) => t[0] === 'w');
  const repoAddr = addrs[0];
  const commit = commits[0];
  if (!repoAddr || !commit || !wTag?.[1] || !wTag[2]) return null;

  const reasonRaw = getTagValue(tags, 'o') ?? defaultReason;
  if (!reasonRaw || !TRIGGER_REASONS.has(reasonRaw)) return null;
  const reason = reasonRaw as CiTriggerReason;

  // `r` doubles as the workflow-run id on 9842, so only `refs/…` is a git ref.
  const ref = getTagValues(tags, 'r').find((v) => v.startsWith('refs/'));

  const ctx: CiTriggerContext = {
    repoAddr,
    commit,
    workflow: { path: wTag[1], sha256: wTag[2] },
    reason,
  };
  if (addrs.length > 1) ctx.extraRepoAddrs = addrs.slice(1);
  if (commits.length > 1) ctx.tagObjectIds = commits.slice(1);
  if (ref !== undefined) ctx.ref = ref;

  const prEventId = getTagValue(tags, 'E');
  if (prEventId) {
    const prKind = asPrKind(getTagValue(tags, 'K'));
    const prAuthor = getTagValue(tags, 'P');
    const sourceEventId = getTagValue(tags, 'e') ?? prEventId;
    const sourceKind = asSourceKind(getTagValue(tags, 'k')) ?? prKind;
    const sourceAuthor = getTagValue(tags, 'p') ?? prAuthor;
    if (prKind && prAuthor && sourceKind && sourceAuthor) {
      ctx.pr = { prEventId, prAuthor, prKind, sourceEventId, sourceAuthor, sourceKind };
    }
  }
  return ctx;
}

// ---------------------------------------------------------------------------
// Provenance + job quotes (NIP-18 `q` tags)
// ---------------------------------------------------------------------------

export type CiProvenance =
  | { kind: 'service-request'; eventId: string; relayUrl: string; pubkey: string }
  | { kind: 'manual-trigger'; eventId: string; relayUrl: string; pubkey: string };

export interface CiJobQuote {
  eventId: string;
  relayUrl: string;
  pubkey: string;
  jobId: string;
}

function parseQuotes(tags: string[][]): { provenance?: CiProvenance; jobs: CiJobQuote[] } {
  let provenance: CiProvenance | undefined;
  const jobs: CiJobQuote[] = [];
  for (const tag of tags) {
    if (tag[0] !== 'q') continue;
    const [, eventId, relayUrl = '', pubkey = '', marker] = tag;
    if (!eventId || !marker) continue;
    if (marker === 'service-request' || marker === 'manual-trigger') {
      if (!provenance) provenance = { kind: marker, eventId, relayUrl, pubkey };
    } else {
      jobs.push({ eventId, relayUrl, pubkey, jobId: marker });
    }
  }
  return provenance ? { provenance, jobs } : { jobs };
}

function parseTimestamp(tags: string[][], name: string): number | undefined {
  const raw = getTagValue(tags, name);
  if (raw === undefined) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

// ---------------------------------------------------------------------------
// Service Request / Stop (9843 / 9844)
// ---------------------------------------------------------------------------

export interface CiServiceControl {
  kind: 'request' | 'stop';
  eventId: string;
  pubkey: string;
  createdAt: number;
  repoAddr: RepoAddress;
  coordinatorPubkey: string;
  relayHint?: string;
}

/** Parse a 9843/9844; exactly one `a` and one `p` are required by the NIP. */
export function parseCiServiceControl(event: NostrEvent): CiServiceControl | null {
  if (event.kind !== CI_SERVICE_REQUEST_KIND && event.kind !== CI_SERVICE_STOP_KIND) return null;
  const aTags = event.tags.filter((t) => t[0] === 'a');
  const pTags = event.tags.filter((t) => t[0] === 'p');
  if (aTags.length !== 1 || pTags.length !== 1) return null;
  const repoAddr = aTags[0]?.[1];
  const coordinatorPubkey = pTags[0]?.[1];
  if (!repoAddr || !coordinatorPubkey) return null;
  const relayHint = aTags[0]?.[2];
  return {
    kind: event.kind === CI_SERVICE_REQUEST_KIND ? 'request' : 'stop',
    eventId: event.id,
    pubkey: event.pubkey.toLowerCase(),
    createdAt: event.created_at,
    repoAddr,
    coordinatorPubkey: coordinatorPubkey.toLowerCase(),
    ...(relayHint ? { relayHint } : {}),
  };
}

/**
 * NIP-C1 total order for controls: a greater `created_at` is later; at equal
 * timestamps the lexicographically LOWER event id is later. Sorts ascending
 * (earliest first).
 */
export function controlOrder(
  a: { createdAt: number; eventId: string },
  b: { createdAt: number; eventId: string }
): number {
  if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
  if (a.eventId === b.eventId) return 0;
  return a.eventId < b.eventId ? 1 : -1;
}

export interface SelectServiceRequestsOptions {
  coordinatorPubkey: string;
  repoAddr: RepoAddress;
  /** owner ∪ declared maintainers, lowercase hex. */
  authorized: Set<string>;
  /** Evaluate the history as of this timestamp (inclusive); default: all. */
  at?: number;
}

/**
 * Reduce the Service Request/Stop history for one (coordinator, repo) pair:
 * a Stop from a maintainer closes every earlier Request; a Stop from anyone
 * else closes only that author's Requests. `active` is the newest remaining
 * Request from an authorized author (the default acceptance policy).
 */
export function selectServiceRequests(
  controls: CiServiceControl[],
  opts: SelectServiceRequestsOptions
): { active: CiServiceControl | null; open: CiServiceControl[] } {
  const coordinator = opts.coordinatorPubkey.toLowerCase();
  const relevant = controls
    .filter(
      (c) =>
        c.coordinatorPubkey === coordinator &&
        c.repoAddr === opts.repoAddr &&
        (opts.at === undefined || c.createdAt <= opts.at)
    )
    .sort(controlOrder);

  let open: CiServiceControl[] = [];
  for (const control of relevant) {
    if (control.kind === 'request') {
      open.push(control);
    } else if (opts.authorized.has(control.pubkey)) {
      open = [];
    } else {
      open = open.filter((r) => r.pubkey !== control.pubkey);
    }
  }
  const accepted = open.filter((r) => opts.authorized.has(r.pubkey));
  const active = accepted.length > 0 ? (accepted[accepted.length - 1] ?? null) : null;
  return { active, open };
}

// ---------------------------------------------------------------------------
// Workflow Result (9842)
// ---------------------------------------------------------------------------

export interface CiWorkflowResult {
  eventId: string;
  pubkey: string;
  createdAt: number;
  trigger: CiTriggerContext;
  runId: string;
  conclusion: CiConclusion;
  queuedAt?: number;
  startedAt?: number;
  provenance?: CiProvenance;
  jobs: CiJobQuote[];
}

export function parseCiWorkflowResult(event: NostrEvent): CiWorkflowResult | null {
  if (event.kind !== CI_WORKFLOW_RESULT_KIND) return null;
  const trigger = parseCiTriggerContext(event.tags);
  if (!trigger) return null;
  const runId = getTagValues(event.tags, 'r').find((v) => !v.startsWith('refs/'));
  const conclusion = getTagValue(event.tags, 'conclusion');
  if (!runId || !conclusion || !CONCLUSIONS.has(conclusion)) return null;
  const { provenance, jobs } = parseQuotes(event.tags);
  const queuedAt = parseTimestamp(event.tags, 'queued_at');
  const startedAt = parseTimestamp(event.tags, 'started_at');
  return {
    eventId: event.id,
    pubkey: event.pubkey.toLowerCase(),
    createdAt: event.created_at,
    trigger,
    runId,
    conclusion: conclusion as CiConclusion,
    ...(queuedAt !== undefined ? { queuedAt } : {}),
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...(provenance ? { provenance } : {}),
    jobs,
  };
}

// ---------------------------------------------------------------------------
// Workflow Progress (39842)
// ---------------------------------------------------------------------------

export interface CiWorkflowProgress {
  eventId: string;
  pubkey: string;
  createdAt: number;
  trigger: CiTriggerContext;
  runId: string;
  status: CiProgressStatus;
  conclusion?: CiConclusion;
  queue?: number;
  inProgress: string[];
  expiresAt?: number;
  queuedAt?: number;
  startedAt?: number;
  provenance?: CiProvenance;
  jobs: CiJobQuote[];
}

export function parseCiWorkflowProgress(event: NostrEvent): CiWorkflowProgress | null {
  if (event.kind !== CI_WORKFLOW_PROGRESS_KIND) return null;
  const runId = getTagValue(event.tags, 'd');
  const status = getTagValue(event.tags, 'status');
  if (!runId || !status || !PROGRESS_STATUSES.has(status)) return null;
  const trigger = parseCiTriggerContext(event.tags);
  if (!trigger) return null;
  const conclusionRaw = getTagValue(event.tags, 'conclusion');
  const conclusion =
    conclusionRaw && CONCLUSIONS.has(conclusionRaw) ? (conclusionRaw as CiConclusion) : undefined;
  const inProgressTag = event.tags.find((t) => t[0] === 'in-progress');
  const inProgress = inProgressTag ? inProgressTag.slice(1).filter((v) => v !== '') : [];
  const queue = parseTimestamp(event.tags, 'queue');
  const expiresAt = parseTimestamp(event.tags, 'expiration');
  const queuedAt = parseTimestamp(event.tags, 'queued_at');
  const startedAt = parseTimestamp(event.tags, 'started_at');
  const { provenance, jobs } = parseQuotes(event.tags);
  return {
    eventId: event.id,
    pubkey: event.pubkey.toLowerCase(),
    createdAt: event.created_at,
    trigger,
    runId,
    status: status as CiProgressStatus,
    ...(conclusion ? { conclusion } : {}),
    ...(queue !== undefined ? { queue } : {}),
    inProgress,
    ...(expiresAt !== undefined ? { expiresAt } : {}),
    ...(queuedAt !== undefined ? { queuedAt } : {}),
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...(provenance ? { provenance } : {}),
    jobs,
  };
}

// ---------------------------------------------------------------------------
// Job Result (9841)
// ---------------------------------------------------------------------------

export interface CiArtifact {
  url: string;
  filename: string;
  name: string;
}

export interface CiJobResult {
  eventId: string;
  pubkey: string;
  createdAt: number;
  trigger: CiTriggerContext;
  /** `39842:<coordinator>:<run-id>` from the `q` tag. */
  progressAddress: string;
  coordinator: string;
  runId: string;
  jobId: string;
  name?: string;
  conclusion: CiConclusion;
  logsUrl?: string;
  logTail: string;
  artifacts: CiArtifact[];
  queuedAt?: number;
  startedAt?: number;
  exitCode?: number;
  runsOn: string[];
}

/** Split a `39842:<pubkey>:<run-id>` progress address. */
export function parseProgressAddress(
  address: string
): { coordinator: string; runId: string } | null {
  const first = address.indexOf(':');
  const second = first === -1 ? -1 : address.indexOf(':', first + 1);
  if (first === -1 || second === -1) return null;
  if (address.slice(0, first) !== String(CI_WORKFLOW_PROGRESS_KIND)) return null;
  const coordinator = address.slice(first + 1, second).toLowerCase();
  const runId = address.slice(second + 1);
  if (!HEX64_RE.test(coordinator) || runId === '') return null;
  return { coordinator, runId };
}

export function parseCiJobResult(event: NostrEvent): CiJobResult | null {
  if (event.kind !== CI_JOB_RESULT_KIND) return null;
  const trigger = parseCiTriggerContext(event.tags);
  if (!trigger) return null;
  const jobId = getTagValue(event.tags, 'job');
  const conclusion = getTagValue(event.tags, 'conclusion');
  if (!jobId || !conclusion || !CONCLUSIONS.has(conclusion)) return null;
  const quote = event.tags.find(
    (t) => t[0] === 'q' && t[1]?.startsWith(`${CI_WORKFLOW_PROGRESS_KIND}:`)
  );
  const progressAddress = quote?.[1];
  const parsedAddress = progressAddress ? parseProgressAddress(progressAddress) : null;
  if (!progressAddress || !parsedAddress) return null;

  const name = getTagValue(event.tags, 'name');
  const logsUrl = getTagValue(event.tags, 'logs');
  const artifacts: CiArtifact[] = [];
  for (const tag of event.tags) {
    if (tag[0] !== 'artifact' || !tag[1]) continue;
    artifacts.push({ url: tag[1], filename: tag[2] ?? '', name: tag[3] ?? '' });
  }
  const runsOnTag = event.tags.find((t) => t[0] === 'runs_on');
  const runsOn = runsOnTag ? runsOnTag.slice(1).filter((v) => v !== '') : [];
  const queuedAt = parseTimestamp(event.tags, 'queued_at');
  const startedAt = parseTimestamp(event.tags, 'started_at');
  const exitCode = parseTimestamp(event.tags, 'exit_code');

  return {
    eventId: event.id,
    pubkey: event.pubkey.toLowerCase(),
    createdAt: event.created_at,
    trigger,
    progressAddress,
    coordinator: parsedAddress.coordinator,
    runId: parsedAddress.runId,
    jobId,
    ...(name !== undefined ? { name } : {}),
    conclusion: conclusion as CiConclusion,
    ...(logsUrl !== undefined ? { logsUrl } : {}),
    logTail: event.content,
    artifacts,
    ...(queuedAt !== undefined ? { queuedAt } : {}),
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...(exitCode !== undefined ? { exitCode } : {}),
    runsOn,
  };
}

// ---------------------------------------------------------------------------
// Trust derivation
// ---------------------------------------------------------------------------

export interface DeriveTrustArgs {
  /** The run's 9842/39842 signer — the Coordinator. */
  publisherPubkey: string;
  /** The run's frozen `service-request` / `manual-trigger` quote, if any. */
  provenance?: CiProvenance;
  /** owner ∪ declared maintainers, lowercase hex. */
  authorized: Set<string>;
  /** Every 9843/9844 seen for this repo (any coordinator). */
  controls: CiServiceControl[];
  runCreatedAt: number;
}

/**
 * Trust level of a run (CONTEXT.md "Trust level"):
 *
 *  - `maintainer-directed`: the run quotes a maintainer's Manual Trigger, or a
 *    maintainer's Service Request that is on record and addressed to this
 *    coordinator.
 *  - `operationally-associated`: no qualifying quote, but a maintainer had an
 *    accepted, unstopped Service Request with this coordinator when the run
 *    was published.
 *  - `seen-in-network`: the coordinator IS a maintainer running their own CI,
 *    or someone (not a maintainer) requested service from it for this repo.
 *  - `no-known-context`: nothing ties this coordinator to the repo.
 */
export function deriveTrustLevel(args: DeriveTrustArgs): CiTrustLevel {
  const publisher = args.publisherPubkey.toLowerCase();
  const { provenance, authorized } = args;
  const forCoordinator = args.controls.filter((c) => c.coordinatorPubkey === publisher);
  const repoAddr = forCoordinator[0]?.repoAddr;

  if (provenance && authorized.has(provenance.pubkey.toLowerCase())) {
    if (provenance.kind === 'manual-trigger') return 'maintainer-directed';
    const onRecord = forCoordinator.some(
      (c) => c.kind === 'request' && c.eventId === provenance.eventId
    );
    if (onRecord) return 'maintainer-directed';
  }

  if (repoAddr !== undefined) {
    const { active } = selectServiceRequests(forCoordinator, {
      coordinatorPubkey: publisher,
      repoAddr,
      authorized,
      at: args.runCreatedAt,
    });
    if (active) return 'operationally-associated';
  }

  if (authorized.has(publisher)) return 'seen-in-network';
  if (forCoordinator.some((c) => c.kind === 'request')) return 'seen-in-network';
  return 'no-known-context';
}

// ---------------------------------------------------------------------------
// Runs: merging 39842 progress with 9842 results
// ---------------------------------------------------------------------------

/** One Run (CONTEXT.md): one workflow, one commit, one trigger reason, one attempt. */
export interface CiRun {
  runId: string;
  coordinator: string;
  trigger: CiTriggerContext;
  status: CiProgressStatus;
  conclusion?: CiConclusion;
  queue?: number;
  inProgress: string[];
  createdAt: number;
  queuedAt?: number;
  startedAt?: number;
  provenance?: CiProvenance;
  jobs: CiJobQuote[];
  trust: CiTrustLevel;
  /** True for the newest attempt of (coordinator, workflow, commit). */
  current: boolean;
  resultEventId?: string;
  progressEventId?: string;
}

export interface BuildCiRunsOptions {
  authorized: Set<string>;
  controls: CiServiceControl[];
}

/**
 * Fold 9842 + 39842 events into runs (newest first). A result wins over its
 * progress marker for status/conclusion; the marker still contributes the
 * in-progress job list while no result exists. Among several 39842s for one
 * address only the newest is honoured (the relay may hand back stale
 * replacements).
 */
export function buildCiRuns(events: NostrEvent[], opts: BuildCiRunsOptions): CiRun[] {
  const byKey = new Map<string, CiRun>();
  const progressSeen = new Map<string, number>();

  for (const event of events) {
    if (event.kind === CI_WORKFLOW_PROGRESS_KIND) {
      const progress = parseCiWorkflowProgress(event);
      if (!progress) continue;
      const key = `${progress.pubkey}:${progress.runId}`;
      const seenAt = progressSeen.get(key);
      if (seenAt !== undefined && seenAt >= progress.createdAt) continue;
      progressSeen.set(key, progress.createdAt);
      const existing = byKey.get(key);
      const base: CiRun = existing ?? {
        runId: progress.runId,
        coordinator: progress.pubkey,
        trigger: progress.trigger,
        status: progress.status,
        inProgress: [],
        createdAt: progress.createdAt,
        jobs: [],
        trust: 'no-known-context',
        current: false,
      };
      const hasResult = base.resultEventId !== undefined;
      const merged: CiRun = {
        ...base,
        progressEventId: progress.eventId,
        createdAt: Math.max(base.createdAt, progress.createdAt),
        inProgress: hasResult ? [] : progress.inProgress,
        ...(hasResult ? {} : { status: progress.status }),
        ...(hasResult || progress.queue === undefined ? {} : { queue: progress.queue }),
        ...(!hasResult && progress.conclusion ? { conclusion: progress.conclusion } : {}),
        ...(progress.queuedAt !== undefined && base.queuedAt === undefined ? { queuedAt: progress.queuedAt } : {}),
        ...(progress.startedAt !== undefined && base.startedAt === undefined ? { startedAt: progress.startedAt } : {}),
        ...(progress.provenance && !base.provenance ? { provenance: progress.provenance } : {}),
        jobs: hasResult ? base.jobs : progress.jobs,
      };
      byKey.set(key, merged);
    } else if (event.kind === CI_WORKFLOW_RESULT_KIND) {
      const result = parseCiWorkflowResult(event);
      if (!result) continue;
      const key = `${result.pubkey}:${result.runId}`;
      const existing = byKey.get(key);
      const merged: CiRun = {
        ...(existing ?? {
          runId: result.runId,
          coordinator: result.pubkey,
          trust: 'no-known-context',
          current: false,
          progressEventId: undefined,
        }),
        trigger: result.trigger,
        status: 'concluded',
        conclusion: result.conclusion,
        inProgress: [],
        createdAt: Math.max(existing?.createdAt ?? 0, result.createdAt),
        ...(result.queuedAt !== undefined ? { queuedAt: result.queuedAt } : {}),
        ...(result.startedAt !== undefined ? { startedAt: result.startedAt } : {}),
        ...(result.provenance ? { provenance: result.provenance } : {}),
        jobs: result.jobs,
        resultEventId: result.eventId,
      };
      delete merged.queue;
      if (merged.progressEventId === undefined) delete merged.progressEventId;
      byKey.set(key, merged);
    }
  }

  const runs = [...byKey.values()].sort((a, b) => b.createdAt - a.createdAt);
  const currentSeen = new Set<string>();
  for (const run of runs) {
    run.trust = deriveTrustLevel({
      publisherPubkey: run.coordinator,
      ...(run.provenance ? { provenance: run.provenance } : {}),
      authorized: opts.authorized,
      controls: opts.controls,
      runCreatedAt: run.createdAt,
    });
    const currentKey = `${run.coordinator}:${run.trigger.workflow.path}:${run.trigger.commit}`;
    run.current = !currentSeen.has(currentKey);
    currentSeen.add(currentKey);
  }
  return runs;
}

/** What one status dot should say about a set of runs. */
export type CiAggregateStatus = 'success' | 'failure' | 'pending' | 'neutral';

const RED: ReadonlySet<string> = new Set<CiConclusion>([
  'failure',
  'timed_out',
  'startup_failure',
  'cancelled',
]);

/**
 * pending (anything still running) > failure (any red conclusion) >
 * success (at least one success, rest green-ish) > neutral. Null for none.
 */
export function aggregateRunStatus(
  runs: readonly Pick<CiRun, 'status' | 'conclusion'>[]
): CiAggregateStatus | null {
  if (runs.length === 0) return null;
  if (runs.some((r) => r.status !== 'concluded')) return 'pending';
  if (runs.some((r) => r.conclusion !== undefined && RED.has(r.conclusion))) return 'failure';
  if (runs.some((r) => r.conclusion === 'success')) return 'success';
  return 'neutral';
}
