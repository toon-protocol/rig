/**
 * NIP-C1 (Nostr CI) event builders + parsers — the wire layer of rig's
 * relay-native CI (rig#125, slice 1). The spec is vendored at
 * docs/specs/nip-c1.md; this module adopts it VERBATIM for kinds, tags,
 * content, and ordering rules, so ngit tooling keeps reading rig's events and
 * rig keeps reading ngit-ci's.
 *
 * Builders return UnsignedEvent (the Publisher signs — see ../publisher.ts,
 * the same posture as ../nip34-events.ts). Parsers take a read-side
 * NostrEvent and return `null` on ANY malformed shape: the relay is
 * permissionless, so a consumer must never let a hand-crafted event smuggle a
 * meaning the spec does not give it (an unknown `X` policy is NOT automatic
 * service; a request naming another coordinator is NOT ours; a trigger whose
 * `a` tags name two repo ids is NOT a run).
 *
 * rig's deliberate departures from the ngit reference, all within the spec:
 *   - `["software","rig","<version>"]` on the Advertisement;
 *   - Advertisement policy `M=maintainer-request`, `X=request-required`,
 *     `B=out-of-band` (the coordinator is funded by its operator);
 *   - logs/artifacts are TOON store gateway URLs, not Blossom (the tag
 *     shapes are identical — only the URL host differs);
 *   - PR context may carry `K`/`k` = 1617: `rig pr create` publishes NIP-34
 *     patches, so a 1617 is the PR shape rig's own contributors produce.
 */

import type { UnsignedEvent } from '../nip34-events.js';
import type { NostrEvent } from '../remote-state.js';

// ---------------------------------------------------------------------------
// Kinds + constants
// ---------------------------------------------------------------------------

export const CI_ADVERTISEMENT_KIND = 19843;
export const CI_SERVICE_REQUEST_KIND = 9843;
export const CI_SERVICE_STOP_KIND = 9844;
export const CI_SECRET_UPDATE_KIND = 29846;
export const CI_MANUAL_TRIGGER_KIND = 9840;
export const CI_JOB_RESULT_KIND = 9841;
export const CI_WORKFLOW_RESULT_KIND = 9842;
export const CI_WORKFLOW_PROGRESS_KIND = 39842;
/**
 * rig's NIP-C1 EXTENSION kind (ADR-0002, docs/specs/nip-c1-live-log-tail.md):
 * the live log tail of a run in flight. Not in the vendored spec — the number
 * is rig's choice, offered upstream to ngit-ci, and renumbering it is a deploy
 * rather than a migration because the event holds no durable data.
 */
export const CI_LIVE_LOG_TAIL_KIND = 39841;

/** The one runner family rig supports (`W` tag / `R` prefix). */
export const CI_RUNNER_FAMILY = 'act';
/** The `software` tag name rig advertises under. */
export const CI_SOFTWARE = 'rig';

/** NIP-40 bound on Advertisement + Progress lifetime (seconds). */
export const CI_MAX_ADVERTISEMENT_TTL = 30 * 60;
export const CI_MAX_PROGRESS_TTL = 30 * 60;
/** The same NIP-40 bound on a Live Log Tail (seconds). */
export const CI_MAX_LIVE_LOG_TAIL_TTL = 30 * 60;

// --- Live Log Tail decisions (ADR-0002) ------------------------------------
// These four numbers are decisions, not tuning knobs, and they are declared
// HERE so the coordinator that publishes the stream and the cost estimate that
// prices it cannot disagree about one.

/**
 * How often a run in flight republishes its tail. Fixed — a fixed interval is
 * what makes the worst case budgetable — and expressed in milliseconds because
 * both consumers (the coordinator's scheduler seam and `estimateRunCost`'s run
 * timeout) work in milliseconds.
 */
export const CI_LIVE_LOG_TAIL_INTERVAL_MS = 10_000;

/**
 * Bytes of tail one live job gets by default: deliberately far more than the
 * 4 KiB that rides in a Job Result, because the relay fee ignores event size
 * and the difference between one screen and several is the difference between
 * "is it alive" and "what is it doing".
 */
export const CI_LIVE_LOG_TAIL_JOB_BYTES = 16 * 1024;

/**
 * Ceiling on the tail bytes ONE event may carry, so a run with many live jobs
 * stays relay-safe. Beyond it the budget is divided evenly — see
 * {@link liveLogTailBudget}.
 */
export const CI_LIVE_LOG_TAIL_MAX_BYTES = 64 * 1024;

/**
 * The distinguished key naming the runner channel in a coordinator's per-job
 * buffers. It is not a job id and can never collide with one (a workflow job id
 * matches `[A-Za-z_][A-Za-z0-9_-]*`), and it never appears in the wire event's
 * `jobs` array — the runner channel has its own `runner` slot.
 */
export const CI_RUNNER_CHANNEL_KEY = '~runner';

/** Kind of the NIP-34 repository announcement the `a` coordinates point at. */
const REPO_ANNOUNCEMENT_KIND = 30617;

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

export function isCiConclusion(value: string): value is CiConclusion {
  return CONCLUSIONS.has(value);
}

export type CiProgressStatus = 'queued' | 'in_progress' | 'concluded';

const PROGRESS_STATUSES: ReadonlySet<string> = new Set<CiProgressStatus>([
  'queued',
  'in_progress',
  'concluded',
]);

/** Normalized trigger reasons rig runs (`schedule` is out of scope). */
export type CiTriggerReason = 'push' | 'pull_request' | 'manual';

const TRIGGER_REASONS: ReadonlySet<string> = new Set<CiTriggerReason>([
  'push',
  'pull_request',
  'manual',
]);

export type CiAdmissionPolicy =
  'operator-selected' | 'maintainer-request' | 'open';
export type CiExecutionPolicy = 'automatic' | 'request-required';
export type CiBillingPolicy = 'not-required' | 'out-of-band';

const ADMISSIONS: ReadonlySet<string> = new Set<CiAdmissionPolicy>([
  'operator-selected',
  'maintainer-request',
  'open',
]);
const EXECUTIONS: ReadonlySet<string> = new Set<CiExecutionPolicy>([
  'automatic',
  'request-required',
]);
const BILLINGS: ReadonlySet<string> = new Set<CiBillingPolicy>([
  'not-required',
  'out-of-band',
]);

// ---------------------------------------------------------------------------
// Repo address
// ---------------------------------------------------------------------------

/** Repo address string `30617:<owner-hex>:<repo-id>`. */
export type RepoAddress = string;

const HEX64 = /^[0-9a-f]{64}$/;
/** A git object id: SHA-1 (40 hex) or SHA-256 (64 hex). */
const GIT_OID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const REPO_ADDR_RE = /^30617:([0-9a-fA-F]{64}):(.+)$/;

export function repoAddress(ownerPubkey: string, repoId: string): RepoAddress {
  return `${REPO_ANNOUNCEMENT_KIND}:${ownerPubkey.toLowerCase()}:${repoId}`;
}

export function parseRepoAddress(
  a: string
): { ownerPubkey: string; repoId: string } | null {
  const m = REPO_ADDR_RE.exec(a);
  if (!m) return null;
  return {
    ownerPubkey: (m[1] as string).toLowerCase(),
    repoId: m[2] as string,
  };
}

// ---------------------------------------------------------------------------
// Trigger context (the common + trigger-context tags every CI event carries)
// ---------------------------------------------------------------------------

export interface CiWorkflowRef {
  /** Workflow file path, relative to the repo root (`w` tag). */
  path: string;
  /** SHA-256 (hex) of the workflow file content at the run's commit. */
  sha256: string;
}

/**
 * NIP-22 PR context of a `pull_request` run: the PR event as root (`E`/`K`/
 * `P`) and the PR or PR-update event that supplied the commit as parent
 * (`e`/`k`/`p`). `prKind`/`sourceKind` 1617 is rig's departure — see the
 * module header.
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
  /** The repo the run is for — the FIRST `a` tag. */
  repoAddr: RepoAddress;
  /** Further `a` tags: the same repo id under other maintainers' announcements. */
  extraRepoAddrs?: string[];
  /** The commit the workflow ran against — the FIRST `c` tag. */
  commit: string;
  /** Extra `c` tags: annotated tag object ids peeling to `commit`. */
  tagObjectIds?: string[];
  workflow: CiWorkflowRef;
  reason: CiTriggerReason;
  /** `r` tag — push runs (and optionally manual runs); never with `pr`. */
  ref?: string;
  pr?: CiPrContext;
}

/** The frozen request-provenance quote a run carries (`q … service-request|manual-trigger`). */
export type CiProvenance =
  | {
      kind: 'service-request';
      eventId: string;
      relayUrl: string;
      pubkey: string;
    }
  | {
      kind: 'manual-trigger';
      eventId: string;
      relayUrl: string;
      pubkey: string;
    };

const PROVENANCE_MARKERS: ReadonlySet<string> = new Set([
  'service-request',
  'manual-trigger',
]);

interface TriggerTagOptions {
  /** Manual Triggers carry no `o` (they are always `manual`). */
  omitReason?: boolean;
  /** Manual Triggers' ONLY lowercase `p` is the coordinator. */
  omitPrParentAuthor?: boolean;
}

function triggerTags(
  trigger: Omit<CiTriggerContext, 'reason'> & { reason?: CiTriggerReason },
  opts: TriggerTagOptions = {}
): string[][] {
  const tags: string[][] = [['a', trigger.repoAddr]];
  for (const a of trigger.extraRepoAddrs ?? []) tags.push(['a', a]);
  tags.push(['c', trigger.commit]);
  for (const c of trigger.tagObjectIds ?? []) tags.push(['c', c]);
  tags.push(['w', trigger.workflow.path, trigger.workflow.sha256]);
  if (!opts.omitReason && trigger.reason !== undefined) {
    tags.push(['o', trigger.reason]);
  }
  if (trigger.pr) {
    tags.push(['E', trigger.pr.prEventId]);
    tags.push(['K', String(trigger.pr.prKind)]);
    tags.push(['P', trigger.pr.prAuthor]);
    tags.push(['e', trigger.pr.sourceEventId]);
    tags.push(['k', String(trigger.pr.sourceKind)]);
    if (!opts.omitPrParentAuthor) tags.push(['p', trigger.pr.sourceAuthor]);
  } else if (trigger.ref !== undefined) {
    // A pull_request run carries NO git-ref `r` tag (NIP-C1 trigger context).
    tags.push(['r', trigger.ref]);
  }
  return tags;
}

/** The common + trigger-context tags (`a*`, `c*`, `w`, `o`, then `r` | `E K P e k p`). */
export function commonTriggerTags(trigger: CiTriggerContext): string[][] {
  return triggerTags(trigger);
}

function values(tags: string[][], name: string): string[][] {
  return tags.filter((t) => t[0] === name);
}

function single(tags: string[][], name: string): string[] | null {
  const found = values(tags, name);
  return found.length === 1 ? (found[0] as string[]) : null;
}

function optionalSingle(
  tags: string[][],
  name: string
): string[] | null | undefined {
  const found = values(tags, name);
  if (found.length === 0) return undefined;
  return found.length === 1 ? (found[0] as string[]) : null;
}

function parsePrKind(value: string | undefined, allowUpdate: boolean) {
  if (value === '1617') return 1617 as const;
  if (value === '1618') return 1618 as const;
  if (allowUpdate && value === '1619') return 1619 as const;
  return null;
}

/**
 * Parse the common + trigger-context tags. `defaultReason` supplies the
 * reason when no `o` tag is present (Manual Triggers omit it and are always
 * `manual`); without it a missing `o` is malformed.
 */
export function parseCiTriggerContext(
  tags: string[][],
  opts: { defaultReason?: CiTriggerReason } = {}
): CiTriggerContext | null {
  const aTags = values(tags, 'a');
  if (aTags.length === 0) return null;
  const addrs: string[] = [];
  let repoId: string | null = null;
  for (const t of aTags) {
    const parsed = t[1] === undefined ? null : parseRepoAddress(t[1]);
    if (!parsed) return null;
    // Every `a` MUST describe the same <repo-id>.
    if (repoId !== null && parsed.repoId !== repoId) return null;
    repoId = parsed.repoId;
    addrs.push(repoAddress(parsed.ownerPubkey, parsed.repoId));
  }

  const cTags = values(tags, 'c');
  if (cTags.length === 0) return null;
  const commits: string[] = [];
  for (const t of cTags) {
    const c = t[1]?.toLowerCase();
    if (c === undefined || !GIT_OID.test(c)) return null;
    commits.push(c);
  }

  const w = single(tags, 'w');
  if (
    !w ||
    w.length < 3 ||
    !w[1] ||
    !HEX64.test((w[2] as string).toLowerCase())
  )
    return null;

  const o = optionalSingle(tags, 'o');
  if (o === null) return null;
  let reason: CiTriggerReason;
  if (o === undefined) {
    if (opts.defaultReason === undefined) return null;
    reason = opts.defaultReason;
  } else {
    const v = o[1] ?? '';
    if (!TRIGGER_REASONS.has(v)) return null;
    reason = v as CiTriggerReason;
  }

  const trigger: CiTriggerContext = {
    repoAddr: addrs[0] as string,
    commit: commits[0] as string,
    workflow: { path: w[1], sha256: (w[2] as string).toLowerCase() },
    reason,
  };
  if (addrs.length > 1) trigger.extraRepoAddrs = addrs.slice(1);
  if (commits.length > 1) trigger.tagObjectIds = commits.slice(1);

  const E = optionalSingle(tags, 'E');
  if (E === null) return null;
  if (E !== undefined) {
    const K = single(tags, 'K');
    const P = single(tags, 'P');
    const prKind = parsePrKind(K?.[1], false) as 1617 | 1618 | null;
    const prEventId = E[1]?.toLowerCase();
    const prAuthor = P?.[1]?.toLowerCase();
    if (
      prKind === null ||
      prEventId === undefined ||
      !HEX64.test(prEventId) ||
      prAuthor === undefined ||
      !HEX64.test(prAuthor)
    ) {
      return null;
    }
    const e = optionalSingle(tags, 'e');
    const k = optionalSingle(tags, 'k');
    const p = optionalSingle(tags, 'p');
    if (e === null || k === null || p === null) return null;
    let sourceEventId = prEventId;
    let sourceKind: 1617 | 1618 | 1619 = prKind;
    if (e !== undefined) {
      const id = e[1]?.toLowerCase();
      if (id === undefined || !HEX64.test(id)) return null;
      sourceEventId = id;
      const parsedKind = parsePrKind(k?.[1], true);
      if (k !== undefined && parsedKind === null) return null;
      sourceKind = parsedKind ?? prKind;
    }
    // The manual-trigger PR form carries no parent `p` (its only lowercase
    // `p` is the coordinator, stripped by parseCiManualTrigger before we get
    // here); the source author then defaults to the PR author.
    let sourceAuthor = prAuthor;
    if (p !== undefined) {
      const author = p[1]?.toLowerCase();
      if (author === undefined || !HEX64.test(author)) return null;
      sourceAuthor = author;
    }
    trigger.pr = {
      prEventId,
      prAuthor,
      prKind,
      sourceEventId,
      sourceAuthor,
      sourceKind,
    };
    if (values(tags, 'r').some((t) => t[1]?.startsWith('refs/'))) return null;
  } else {
    const refs = values(tags, 'r').filter((t) => t[1]?.startsWith('refs/'));
    if (refs.length > 1) return null;
    if (refs.length === 1) trigger.ref = (refs[0] as string[])[1] as string;
  }
  return trigger;
}

function provenanceTag(p: CiProvenance): string[] {
  return ['q', p.eventId, p.relayUrl, p.pubkey, p.kind];
}

function parseProvenance(tags: string[][]): CiProvenance | null | undefined {
  const quotes = values(tags, 'q').filter(
    (t) => t[4] !== undefined && PROVENANCE_MARKERS.has(t[4])
  );
  if (quotes.length === 0) return undefined;
  if (quotes.length > 1) return null;
  const q = quotes[0] as string[];
  const eventId = q[1]?.toLowerCase();
  const pubkey = q[3]?.toLowerCase();
  if (
    eventId === undefined ||
    !HEX64.test(eventId) ||
    pubkey === undefined ||
    !HEX64.test(pubkey)
  ) {
    return null;
  }
  return {
    kind: q[4] as CiProvenance['kind'],
    eventId,
    relayUrl: q[2] ?? '',
    pubkey,
  };
}

// ---------------------------------------------------------------------------
// kind:19843 — Coordinator Advertisement
// ---------------------------------------------------------------------------

export interface CiAdvertisementInput {
  version: string;
  /** Accepted `act` selectors (emitted as `R = act:<selector>`). */
  selectors: string[];
  admission: CiAdmissionPolicy;
  execution: CiExecutionPolicy;
  billing?: CiBillingPolicy;
  secretsKey?: { pubkey: string; inboxRelays: string[] };
  /** NIP-40 expiration: > created_at, ≤ created_at + 30 min. */
  expiresAt: number;
}

export interface CiAdvertisement {
  eventId: string;
  pubkey: string;
  createdAt: number;
  version: string;
  /** Supported runner families (`W`), case-folded + deduplicated. */
  families: string[];
  /** Accepted `<family>:<selector>` values (`R`), case-folded + deduplicated. */
  selectors: string[];
  admission: CiAdmissionPolicy;
  execution: CiExecutionPolicy;
  billing?: CiBillingPolicy;
  secretsKey?: { pubkey: string; inboxRelays: string[] };
  expiresAt: number;
}

function now(): number {
  return Math.floor(Date.now() / 1000);
}

function assertExpiration(
  createdAt: number,
  expiresAt: number,
  maxTtl: number
): void {
  if (!Number.isInteger(expiresAt) || expiresAt <= createdAt) {
    throw new Error('expiration must be later than created_at');
  }
  if (expiresAt - createdAt > maxTtl) {
    throw new Error(
      `expiration must be no more than ${maxTtl}s after created_at`
    );
  }
}

function foldUnique(items: Iterable<string>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of items) {
    const v = raw.toLowerCase();
    if (!seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  return out;
}

export function buildCiAdvertisement(
  input: CiAdvertisementInput,
  createdAt: number = now()
): UnsignedEvent {
  const selectors = foldUnique(input.selectors);
  if (selectors.length === 0) {
    throw new Error('an advertisement needs at least one runner selector');
  }
  if (input.secretsKey && input.secretsKey.inboxRelays.length === 0) {
    throw new Error('secrets-key needs at least one secret-inbox relay');
  }
  assertExpiration(createdAt, input.expiresAt, CI_MAX_ADVERTISEMENT_TTL);
  const tags: string[][] = [
    ['software', CI_SOFTWARE, input.version],
    ['W', CI_RUNNER_FAMILY],
    ...selectors.map((s) => ['R', `${CI_RUNNER_FAMILY}:${s}`]),
    ['M', input.admission],
    ['X', input.execution],
  ];
  if (input.billing) tags.push(['B', input.billing]);
  if (input.secretsKey) {
    tags.push([
      'secrets-key',
      'nip44-v2',
      input.secretsKey.pubkey.toLowerCase(),
      ...input.secretsKey.inboxRelays,
    ]);
  }
  tags.push(['expiration', String(input.expiresAt)]);
  return {
    kind: CI_ADVERTISEMENT_KIND,
    content: '',
    tags,
    created_at: createdAt,
  };
}

export function parseCiAdvertisement(ev: NostrEvent): CiAdvertisement | null {
  if (ev.kind !== CI_ADVERTISEMENT_KIND || ev.content !== '') return null;
  const { tags } = ev;
  if (values(tags, 'd').length > 0) return null;
  const M = single(tags, 'M');
  const X = single(tags, 'X');
  const exp = single(tags, 'expiration');
  if (!M || !X || !exp) return null;
  if (!ADMISSIONS.has(M[1] ?? '') || !EXECUTIONS.has(X[1] ?? '')) return null;
  const B = optionalSingle(tags, 'B');
  if (B === null || (B !== undefined && !BILLINGS.has(B[1] ?? ''))) return null;
  const expiresAt = Number(exp[1]);
  if (!Number.isInteger(expiresAt) || expiresAt <= ev.created_at) return null;

  const families = foldUnique(
    values(tags, 'W')
      .map((t) => t[1] ?? '')
      .filter((v) => v !== '')
  );
  const selectors = foldUnique(
    values(tags, 'R')
      .map((t) => t[1] ?? '')
      .filter((v) => v !== '')
  );
  if (families.length === 0 || selectors.length === 0) return null;
  // Every R's family must be advertised and every family must have an R.
  const covered = new Set<string>();
  for (const s of selectors) {
    const family = s.slice(0, s.indexOf(':'));
    if (!family || !families.includes(family)) return null;
    covered.add(family);
  }
  if (covered.size !== families.length) return null;

  const software = optionalSingle(tags, 'software');
  if (software === null) return null;

  const sk = optionalSingle(tags, 'secrets-key');
  if (sk === null) return null;
  let secretsKey: CiAdvertisement['secretsKey'];
  if (sk !== undefined) {
    const pubkey = sk[2]?.toLowerCase();
    const inboxRelays = sk.slice(3).filter((u) => /^wss?:\/\//i.test(u));
    if (
      sk[1] !== 'nip44-v2' ||
      pubkey === undefined ||
      !HEX64.test(pubkey) ||
      inboxRelays.length === 0
    ) {
      return null;
    }
    secretsKey = { pubkey, inboxRelays };
  }

  const result: CiAdvertisement = {
    eventId: ev.id,
    pubkey: ev.pubkey.toLowerCase(),
    createdAt: ev.created_at,
    version: software?.[2] ?? '',
    families,
    selectors,
    admission: M[1] as CiAdmissionPolicy,
    execution: X[1] as CiExecutionPolicy,
    expiresAt,
  };
  if (B !== undefined) result.billing = B[1] as CiBillingPolicy;
  if (secretsKey) result.secretsKey = secretsKey;
  return result;
}

// ---------------------------------------------------------------------------
// kind:9843 / 9844 — Service Request / Stop
// ---------------------------------------------------------------------------

export interface ServiceControl {
  kind: 'request' | 'stop';
  eventId: string;
  pubkey: string;
  createdAt: number;
  repoAddr: RepoAddress;
  coordinatorPubkey: string;
  relayHint?: string;
}

function buildServiceControl(
  kind: number,
  repoAddr: RepoAddress,
  coordinatorPubkey: string,
  relayHint: string | undefined,
  createdAt: number
): UnsignedEvent {
  const a = relayHint ? ['a', repoAddr, relayHint] : ['a', repoAddr];
  return {
    kind,
    content: '',
    tags: [a, ['p', coordinatorPubkey.toLowerCase()]],
    created_at: createdAt,
  };
}

export function buildCiServiceRequest(
  repoAddr: RepoAddress,
  coordinatorPubkey: string,
  relayHint?: string,
  createdAt: number = now()
): UnsignedEvent {
  return buildServiceControl(
    CI_SERVICE_REQUEST_KIND,
    repoAddr,
    coordinatorPubkey,
    relayHint,
    createdAt
  );
}

export function buildCiServiceStop(
  repoAddr: RepoAddress,
  coordinatorPubkey: string,
  relayHint?: string,
  createdAt: number = now()
): UnsignedEvent {
  return buildServiceControl(
    CI_SERVICE_STOP_KIND,
    repoAddr,
    coordinatorPubkey,
    relayHint,
    createdAt
  );
}

export function parseCiServiceControl(ev: NostrEvent): ServiceControl | null {
  if (ev.kind !== CI_SERVICE_REQUEST_KIND && ev.kind !== CI_SERVICE_STOP_KIND)
    return null;
  if (ev.content !== '') return null;
  const { tags } = ev;
  if (values(tags, 'd').length > 0 || values(tags, 'expiration').length > 0)
    return null;
  const a = single(tags, 'a');
  const p = single(tags, 'p');
  if (!a || !p) return null;
  const addr = a[1] === undefined ? null : parseRepoAddress(a[1]);
  const coordinator = p[1]?.toLowerCase();
  if (!addr || coordinator === undefined || !HEX64.test(coordinator))
    return null;
  const control: ServiceControl = {
    kind: ev.kind === CI_SERVICE_REQUEST_KIND ? 'request' : 'stop',
    eventId: ev.id,
    pubkey: ev.pubkey.toLowerCase(),
    createdAt: ev.created_at,
    repoAddr: repoAddress(addr.ownerPubkey, addr.repoId),
    coordinatorPubkey: coordinator,
  };
  if (a[2]) control.relayHint = a[2];
  return control;
}

/**
 * NIP-C1 total order for controls (and secret updates): a greater
 * `created_at` is later; at equal timestamps the lexicographically LOWER
 * event id is later. Returns <0 when `a` is earlier than `b`.
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
  /** When given, controls for other repo addresses are ignored. */
  repoAddr?: RepoAddress;
  /** Current owner ∪ maintainers (lowercase hex) — the accepted requesters. */
  authorized: Set<string>;
  /**
   * Extra requester pubkeys the operator explicitly accepts (NIP-C1: "an
   * operator MAY explicitly accept other requester pubkeys"). Their Requests
   * count, but they stay non-maintainers: their Stops close only their own
   * Requests, and runs they cause carry lower trust.
   */
  acceptedRequesters?: Set<string>;
}

export interface SelectedServiceRequests {
  /** The newest accepted, unstopped Request — service is eligible iff non-null. */
  active: ServiceControl | null;
  /** Every accepted Request still open, earliest first. */
  open: ServiceControl[];
}

/**
 * Reduce the Service Request / Stop history for one coordinator + repo
 * perspective under the default policy (only current maintainers' Requests
 * are accepted). A maintainer's Stop closes every earlier Request; any other
 * author's Stop closes only that author's own earlier Requests — so a removed
 * maintainer keeps the author-local effect but loses the repo-wide one.
 */
export function selectServiceRequests(
  controls: ServiceControl[],
  opts: SelectServiceRequestsOptions
): SelectedServiceRequests {
  const coordinator = opts.coordinatorPubkey.toLowerCase();
  const authorized = new Set([...opts.authorized].map((p) => p.toLowerCase()));
  const accepted = new Set([
    ...authorized,
    ...[...(opts.acceptedRequesters ?? [])].map((p) => p.toLowerCase()),
  ]);
  const relevant = controls
    .filter(
      (c) =>
        c.coordinatorPubkey.toLowerCase() === coordinator &&
        (opts.repoAddr === undefined || c.repoAddr === opts.repoAddr)
    )
    .sort(controlOrder);

  let open: ServiceControl[] = [];
  for (const control of relevant) {
    const author = control.pubkey.toLowerCase();
    if (control.kind === 'request') {
      if (accepted.has(author)) open.push(control);
      continue;
    }
    open = authorized.has(author)
      ? []
      : open.filter((r) => r.pubkey.toLowerCase() !== author);
  }
  return {
    active: open.length > 0 ? (open[open.length - 1] as ServiceControl) : null,
    open,
  };
}

// ---------------------------------------------------------------------------
// kind:9840 — Manual Trigger
// ---------------------------------------------------------------------------

export interface CiManualTrigger {
  eventId: string;
  pubkey: string;
  createdAt: number;
  coordinatorPubkey: string;
  trigger: Omit<CiTriggerContext, 'reason'>;
}

export function buildCiManualTrigger(
  coordinatorPubkey: string,
  trigger: Omit<CiTriggerContext, 'reason'>,
  createdAt: number = now()
): UnsignedEvent {
  return {
    kind: CI_MANUAL_TRIGGER_KIND,
    content: '',
    tags: [
      ['p', coordinatorPubkey.toLowerCase()],
      ...triggerTags(trigger, { omitReason: true, omitPrParentAuthor: true }),
    ],
    created_at: createdAt,
  };
}

/**
 * Parse a Manual Trigger. With `coordinatorPubkey` given, a request addressed
 * to any other coordinator is ignored (`null`). The ONLY lowercase `p` on a
 * Manual Trigger is the coordinator — a second one is malformed.
 */
export function parseCiManualTrigger(
  ev: NostrEvent,
  coordinatorPubkey?: string
): CiManualTrigger | null {
  if (ev.kind !== CI_MANUAL_TRIGGER_KIND || ev.content !== '') return null;
  const p = single(ev.tags, 'p');
  const coordinator = p?.[1]?.toLowerCase();
  if (!p || coordinator === undefined || !HEX64.test(coordinator)) return null;
  if (
    coordinatorPubkey !== undefined &&
    coordinator !== coordinatorPubkey.toLowerCase()
  )
    return null;
  if (values(ev.tags, 'o').length > 0) return null;
  const rest = ev.tags.filter((t) => t[0] !== 'p');
  const parsed = parseCiTriggerContext(rest, { defaultReason: 'manual' });
  if (!parsed) return null;
  const { reason: _reason, ...trigger } = parsed;
  return {
    eventId: ev.id,
    pubkey: ev.pubkey.toLowerCase(),
    createdAt: ev.created_at,
    coordinatorPubkey: coordinator,
    trigger,
  };
}

// ---------------------------------------------------------------------------
// kind:29846 — Repository Secret Update (envelope only; ../ci/secrets.ts
// owns the NIP-44 payload)
// ---------------------------------------------------------------------------

export interface CiSecretUpdateArgs {
  repoAddr: RepoAddress;
  coordinatorPubkey: string;
  advertisementId: string;
  advertisementRelayHint?: string;
  senderPubkey: string;
  recipientPubkey: string;
  ciphertext: string;
  createdAt: number;
}

export interface CiSecretUpdate {
  eventId: string;
  pubkey: string;
  createdAt: number;
  repoAddr: RepoAddress;
  coordinatorPubkey: string;
  advertisementId: string;
  senderPubkey: string;
  recipientPubkey: string;
  ciphertext: string;
}

const SECRET_UPDATE_TAGS = ['a', 'p', 'e', 'sender', 'recipient', 'encryption'];

export function buildCiSecretUpdate(args: CiSecretUpdateArgs): UnsignedEvent {
  return {
    kind: CI_SECRET_UPDATE_KIND,
    content: args.ciphertext,
    tags: [
      ['a', args.repoAddr],
      ['p', args.coordinatorPubkey.toLowerCase()],
      [
        'e',
        args.advertisementId,
        args.advertisementRelayHint ?? '',
        'secrets-key',
      ],
      ['sender', args.senderPubkey.toLowerCase()],
      ['recipient', args.recipientPubkey.toLowerCase()],
      ['encryption', 'nip44-v2'],
    ],
    created_at: args.createdAt,
  };
}

export function parseCiSecretUpdate(ev: NostrEvent): CiSecretUpdate | null {
  if (ev.kind !== CI_SECRET_UPDATE_KIND) return null;
  if (ev.content === '' || ev.content.length > 100 * 1024) return null;
  const { tags } = ev;
  if (tags.length !== SECRET_UPDATE_TAGS.length) return null;
  for (const name of SECRET_UPDATE_TAGS) {
    if (values(tags, name).length !== 1) return null;
  }
  const a = single(tags, 'a') as string[];
  const p = single(tags, 'p') as string[];
  const e = single(tags, 'e') as string[];
  const sender = single(tags, 'sender') as string[];
  const recipient = single(tags, 'recipient') as string[];
  const encryption = single(tags, 'encryption') as string[];

  const addr = a[1] === undefined ? null : parseRepoAddress(a[1]);
  if (!addr || addr.ownerPubkey !== ev.pubkey.toLowerCase()) return null;
  const coordinator = p[1]?.toLowerCase();
  const advertisementId = e[1]?.toLowerCase();
  const senderPubkey = sender[1]?.toLowerCase();
  const recipientPubkey = recipient[1]?.toLowerCase();
  if (
    coordinator === undefined ||
    !HEX64.test(coordinator) ||
    advertisementId === undefined ||
    !HEX64.test(advertisementId) ||
    e[3] !== 'secrets-key' ||
    senderPubkey === undefined ||
    !HEX64.test(senderPubkey) ||
    recipientPubkey === undefined ||
    !HEX64.test(recipientPubkey) ||
    encryption[1] !== 'nip44-v2'
  ) {
    return null;
  }
  return {
    eventId: ev.id,
    pubkey: ev.pubkey.toLowerCase(),
    createdAt: ev.created_at,
    repoAddr: repoAddress(addr.ownerPubkey, addr.repoId),
    coordinatorPubkey: coordinator,
    advertisementId,
    senderPubkey,
    recipientPubkey,
    ciphertext: ev.content,
  };
}

// ---------------------------------------------------------------------------
// kind:9841 — Job Result
// ---------------------------------------------------------------------------

export interface CiArtifact {
  url: string;
  filename: string;
  name: string;
}

export interface CiJobResultInput {
  trigger: CiTriggerContext;
  /** `39842:<coordinator>:<runId>` — the run's Workflow Progress address. */
  progressAddress: string;
  /** Relay the Progress event was published to (the `q` relay hint). */
  relayUrl: string;
  jobId: string;
  name?: string;
  conclusion: CiConclusion;
  logsUrl: string;
  logTail: string;
  logOmittedBytes: number;
  artifacts?: CiArtifact[];
  queuedAt?: number;
  startedAt?: number;
  exitCode?: number;
  runsOn?: string[];
  /** MAY be carried on a Job Result (never a service-request by rig's coordinator). */
  provenance?: CiProvenance;
}

export interface CiJobResult {
  eventId: string;
  pubkey: string;
  createdAt: number;
  trigger: CiTriggerContext;
  progressAddress: string;
  jobId: string;
  name?: string;
  conclusion: CiConclusion;
  logsUrl?: string;
  logTail: string;
  logOmittedBytes: number;
  artifacts: CiArtifact[];
  queuedAt?: number;
  startedAt?: number;
  exitCode?: number;
  runsOn: string[];
  provenance?: CiProvenance;
}

const LOG_TAIL_HEADER = /^\[log-tail omitted=(\d+)\]\n?/;

const PROGRESS_ADDR_RE = /^39842:[0-9a-f]{64}:.+$/i;

export function buildCiJobResult(
  input: CiJobResultInput,
  createdAt: number = now()
): UnsignedEvent {
  const tags: string[][] = [
    ...commonTriggerTags(input.trigger),
    ['q', input.progressAddress, input.relayUrl],
    ['job', input.jobId],
  ];
  if (input.name !== undefined) tags.push(['name', input.name]);
  tags.push(['conclusion', input.conclusion]);
  tags.push(['logs', input.logsUrl]);
  for (const a of input.artifacts ?? []) {
    tags.push(['artifact', a.url, a.filename, a.name]);
  }
  if (input.queuedAt !== undefined)
    tags.push(['queued_at', String(input.queuedAt)]);
  if (input.startedAt !== undefined)
    tags.push(['started_at', String(input.startedAt)]);
  if (input.exitCode !== undefined)
    tags.push(['exit_code', String(input.exitCode)]);
  if (input.runsOn && input.runsOn.length > 0)
    tags.push(['runs_on', ...input.runsOn]);
  if (input.provenance) tags.push(provenanceTag(input.provenance));
  return {
    kind: CI_JOB_RESULT_KIND,
    content: `[log-tail omitted=${input.logOmittedBytes}]\n${input.logTail}`,
    tags,
    created_at: createdAt,
  };
}

function optionalInt(
  tags: string[][],
  name: string
): number | null | undefined {
  const t = optionalSingle(tags, name);
  if (t === null) return null;
  if (t === undefined) return undefined;
  const n = Number(t[1]);
  return Number.isInteger(n) ? n : null;
}

export function parseCiJobResult(ev: NostrEvent): CiJobResult | null {
  if (ev.kind !== CI_JOB_RESULT_KIND) return null;
  const { tags } = ev;
  const trigger = parseCiTriggerContext(tags);
  if (!trigger) return null;
  const progress = values(tags, 'q').filter(
    (t) => t[1] !== undefined && PROGRESS_ADDR_RE.test(t[1])
  );
  if (progress.length !== 1) return null;
  const job = single(tags, 'job');
  const conclusion = single(tags, 'conclusion');
  if (!job || !job[1] || !conclusion || !isCiConclusion(conclusion[1] ?? ''))
    return null;
  const name = optionalSingle(tags, 'name');
  const logs = optionalSingle(tags, 'logs');
  if (name === null || logs === null) return null;
  const queuedAt = optionalInt(tags, 'queued_at');
  const startedAt = optionalInt(tags, 'started_at');
  const exitCode = optionalInt(tags, 'exit_code');
  if (queuedAt === null || startedAt === null || exitCode === null) return null;
  const runsOn = optionalSingle(tags, 'runs_on');
  if (runsOn === null) return null;
  const provenance = parseProvenance(tags);
  if (provenance === null) return null;

  const artifacts: CiArtifact[] = [];
  for (const t of values(tags, 'artifact')) {
    if (!t[1] || t[2] === undefined || t[3] === undefined) return null;
    artifacts.push({ url: t[1], filename: t[2], name: t[3] });
  }

  const header = LOG_TAIL_HEADER.exec(ev.content);
  const logOmittedBytes = header ? Number(header[1]) : 0;
  const logTail = header ? ev.content.slice(header[0].length) : ev.content;

  const result: CiJobResult = {
    eventId: ev.id,
    pubkey: ev.pubkey.toLowerCase(),
    createdAt: ev.created_at,
    trigger,
    progressAddress: (progress[0] as string[])[1] as string,
    jobId: job[1],
    conclusion: conclusion[1] as CiConclusion,
    logTail,
    logOmittedBytes,
    artifacts,
    runsOn: runsOn ? runsOn.slice(1) : [],
  };
  if (name?.[1] !== undefined) result.name = name[1];
  if (logs?.[1]) result.logsUrl = logs[1];
  if (queuedAt !== undefined) result.queuedAt = queuedAt;
  if (startedAt !== undefined) result.startedAt = startedAt;
  if (exitCode !== undefined) result.exitCode = exitCode;
  if (provenance) result.provenance = provenance;
  return result;
}

// ---------------------------------------------------------------------------
// kind:9842 — Workflow Result
// ---------------------------------------------------------------------------

/** A `q` quote of one Job Result (job id as the marker). */
export interface CiJobQuote {
  eventId: string;
  relayUrl: string;
  pubkey: string;
  jobId: string;
}

export interface CiWorkflowResultInput {
  trigger: CiTriggerContext;
  runId: string;
  conclusion: CiConclusion;
  queuedAt?: number;
  startedAt?: number;
  provenance?: CiProvenance;
  jobs: CiJobQuote[];
}

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

function jobQuoteTag(j: CiJobQuote): string[] {
  return ['q', j.eventId, j.relayUrl, j.pubkey, j.jobId];
}

function parseJobQuotes(tags: string[][]): CiJobQuote[] | null {
  const jobs: CiJobQuote[] = [];
  for (const t of values(tags, 'q')) {
    const marker = t[4];
    if (marker === undefined || PROVENANCE_MARKERS.has(marker)) continue;
    if (t[1] !== undefined && PROGRESS_ADDR_RE.test(t[1])) continue;
    const eventId = t[1]?.toLowerCase();
    const pubkey = t[3]?.toLowerCase();
    if (
      eventId === undefined ||
      !HEX64.test(eventId) ||
      pubkey === undefined ||
      !HEX64.test(pubkey) ||
      marker === ''
    ) {
      return null;
    }
    jobs.push({ eventId, relayUrl: t[2] ?? '', pubkey, jobId: marker });
  }
  return jobs;
}

export function buildCiWorkflowResult(
  input: CiWorkflowResultInput,
  createdAt: number = now()
): UnsignedEvent {
  const tags: string[][] = [
    ...commonTriggerTags(input.trigger),
    ['r', input.runId],
    ['conclusion', input.conclusion],
  ];
  if (input.queuedAt !== undefined)
    tags.push(['queued_at', String(input.queuedAt)]);
  if (input.startedAt !== undefined)
    tags.push(['started_at', String(input.startedAt)]);
  if (input.provenance) tags.push(provenanceTag(input.provenance));
  for (const j of input.jobs) tags.push(jobQuoteTag(j));
  return {
    kind: CI_WORKFLOW_RESULT_KIND,
    content: '',
    tags,
    created_at: createdAt,
  };
}

export function parseCiWorkflowResult(ev: NostrEvent): CiWorkflowResult | null {
  if (ev.kind !== CI_WORKFLOW_RESULT_KIND || ev.content !== '') return null;
  const { tags } = ev;
  const trigger = parseCiTriggerContext(tags);
  if (!trigger) return null;
  // On push results the git ref and the run id share `r`; the run id is the
  // one NOT starting with `refs/`.
  const runIds = values(tags, 'r').filter(
    (t) => t[1] && !t[1].startsWith('refs/')
  );
  if (runIds.length !== 1) return null;
  const conclusion = single(tags, 'conclusion');
  if (!conclusion || !isCiConclusion(conclusion[1] ?? '')) return null;
  const queuedAt = optionalInt(tags, 'queued_at');
  const startedAt = optionalInt(tags, 'started_at');
  if (queuedAt === null || startedAt === null) return null;
  const provenance = parseProvenance(tags);
  if (provenance === null) return null;
  const jobs = parseJobQuotes(tags);
  if (!jobs) return null;

  const result: CiWorkflowResult = {
    eventId: ev.id,
    pubkey: ev.pubkey.toLowerCase(),
    createdAt: ev.created_at,
    trigger,
    runId: (runIds[0] as string[])[1] as string,
    conclusion: conclusion[1] as CiConclusion,
    jobs,
  };
  if (queuedAt !== undefined) result.queuedAt = queuedAt;
  if (startedAt !== undefined) result.startedAt = startedAt;
  if (provenance) result.provenance = provenance;
  return result;
}

// ---------------------------------------------------------------------------
// kind:39842 — Workflow Progress
// ---------------------------------------------------------------------------

export interface CiWorkflowProgressInput extends Omit<
  CiWorkflowResultInput,
  'conclusion'
> {
  status: CiProgressStatus;
  /** Required iff `status === 'concluded'`. */
  conclusion?: CiConclusion;
  /** Capacity rounds before start (queued only). */
  queue?: number;
  /** Job ids currently executing. */
  inProgress?: string[];
  /** NIP-40 expiration: > created_at, ≤ created_at + 30 min. */
  expiresAt: number;
}

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
  queuedAt?: number;
  startedAt?: number;
  expiresAt: number;
  provenance?: CiProvenance;
  jobs: CiJobQuote[];
}

export function buildCiWorkflowProgress(
  input: CiWorkflowProgressInput,
  createdAt: number = now()
): UnsignedEvent {
  if (input.status === 'concluded' && input.conclusion === undefined) {
    throw new Error('a concluded progress event needs a conclusion');
  }
  if (input.status !== 'concluded' && input.conclusion !== undefined) {
    throw new Error('only a concluded progress event may carry a conclusion');
  }
  assertExpiration(createdAt, input.expiresAt, CI_MAX_PROGRESS_TTL);
  const tags: string[][] = [
    ...commonTriggerTags(input.trigger),
    ['d', input.runId],
    ['status', input.status],
  ];
  if (input.queue !== undefined) tags.push(['queue', String(input.queue)]);
  if (input.inProgress && input.inProgress.length > 0) {
    tags.push(['in-progress', ...input.inProgress]);
  }
  if (input.conclusion !== undefined)
    tags.push(['conclusion', input.conclusion]);
  if (input.queuedAt !== undefined)
    tags.push(['queued_at', String(input.queuedAt)]);
  if (input.startedAt !== undefined)
    tags.push(['started_at', String(input.startedAt)]);
  tags.push(['expiration', String(input.expiresAt)]);
  // A queued standing-service marker MUST omit the service-request quote:
  // final authorization is only selected at runner handoff.
  if (
    input.provenance &&
    !(input.status === 'queued' && input.provenance.kind === 'service-request')
  ) {
    tags.push(provenanceTag(input.provenance));
  }
  for (const j of input.jobs) tags.push(jobQuoteTag(j));
  return {
    kind: CI_WORKFLOW_PROGRESS_KIND,
    content: '',
    tags,
    created_at: createdAt,
  };
}

export function parseCiWorkflowProgress(
  ev: NostrEvent
): CiWorkflowProgress | null {
  if (ev.kind !== CI_WORKFLOW_PROGRESS_KIND || ev.content !== '') return null;
  const { tags } = ev;
  const trigger = parseCiTriggerContext(tags);
  if (!trigger) return null;
  const d = single(tags, 'd');
  const status = single(tags, 'status');
  const exp = single(tags, 'expiration');
  if (!d || !d[1] || !status || !PROGRESS_STATUSES.has(status[1] ?? '') || !exp)
    return null;
  const expiresAt = Number(exp[1]);
  if (!Number.isInteger(expiresAt)) return null;
  const conclusion = optionalSingle(tags, 'conclusion');
  if (conclusion === null) return null;
  if (status[1] === 'concluded') {
    if (!conclusion || !isCiConclusion(conclusion[1] ?? '')) return null;
  } else if (conclusion !== undefined) {
    return null;
  }
  const queue = optionalInt(tags, 'queue');
  const queuedAt = optionalInt(tags, 'queued_at');
  const startedAt = optionalInt(tags, 'started_at');
  if (queue === null || queuedAt === null || startedAt === null) return null;
  const inProgress = optionalSingle(tags, 'in-progress');
  if (inProgress === null) return null;
  const provenance = parseProvenance(tags);
  if (provenance === null) return null;
  const jobs = parseJobQuotes(tags);
  if (!jobs) return null;

  const result: CiWorkflowProgress = {
    eventId: ev.id,
    pubkey: ev.pubkey.toLowerCase(),
    createdAt: ev.created_at,
    trigger,
    runId: d[1],
    status: status[1] as CiProgressStatus,
    inProgress: inProgress ? inProgress.slice(1) : [],
    expiresAt,
    jobs,
  };
  if (conclusion?.[1] !== undefined)
    result.conclusion = conclusion[1] as CiConclusion;
  if (queue !== undefined) result.queue = queue;
  if (queuedAt !== undefined) result.queuedAt = queuedAt;
  if (startedAt !== undefined) result.startedAt = startedAt;
  if (provenance) result.provenance = provenance;
  return result;
}

// ---------------------------------------------------------------------------
// kind:39841 — Live Log Tail (rig's NIP-C1 EXTENSION — ADR-0002)
//
// One addressable event per RUN, replaced on a fixed cadence while the run is
// in flight, carrying the recent output of every unfinished job plus the
// runner channel. Its `d` is the run id — the same value as the run's Workflow
// Progress `d` — so a client holding a run addresses its tail without a second
// lookup. It is only ever a VIEW: the job log named by the Job Result is the
// record, and this event expires under NIP-40 shortly after the run concludes.
//
// Wire shape and rationale: docs/specs/nip-c1-live-log-tail.md, ADR-0002.
// ---------------------------------------------------------------------------

/** One unfinished job's recent output. */
export interface CiLiveLogTailJob {
  /** Job id as declared in the workflow file. */
  job: string;
  /** The most recent output, sliced from the END of the redacted log. */
  tail: string;
  /** Bytes of that job's output preceding `tail`. */
  omitted: number;
}

/** The runner channel: the runner's own account of the run, never a job. */
export interface CiLiveLogTailChannel {
  tail: string;
  omitted: number;
}

export interface CiLiveLogTailInput {
  trigger: CiTriggerContext;
  /** The run's Workflow Progress `d`. */
  runId: string;
  /** Every unfinished job; a job drops out once its Job Result is published. */
  jobs: CiLiveLogTailJob[];
  runner?: CiLiveLogTailChannel;
  /** NIP-40 expiration: > created_at, ≤ created_at + 30 min. */
  expiresAt: number;
}

export interface CiLiveLogTail {
  eventId: string;
  pubkey: string;
  createdAt: number;
  trigger: CiTriggerContext;
  runId: string;
  jobs: CiLiveLogTailJob[];
  runner?: CiLiveLogTailChannel;
  expiresAt: number;
}

/**
 * Bytes of tail each live entry gets when `entries` of them share one event:
 * the per-job default until that many entries would breach the per-event
 * ceiling, then the ceiling divided evenly. Entries are unfinished jobs PLUS
 * the runner channel when it has output — everything that occupies bytes in
 * the event.
 */
export function liveLogTailBudget(entries: number): number {
  if (!Number.isFinite(entries) || entries <= 1) {
    return CI_LIVE_LOG_TAIL_JOB_BYTES;
  }
  const share = Math.floor(CI_LIVE_LOG_TAIL_MAX_BYTES / entries);
  return Math.max(1, Math.min(CI_LIVE_LOG_TAIL_JOB_BYTES, share));
}

/**
 * Worst-case number of Live Log Tail events a run of at most `runTimeoutMs`
 * can publish: one per cadence tick plus the closing replacement. This is what
 * the coordinator must be able to afford BEFORE it starts the run — there is
 * no best-effort mode, because a stream that silently stops is
 * indistinguishable to a viewer from a stalled job.
 */
export function liveLogTailEventBudget(runTimeoutMs: number): number {
  if (!Number.isFinite(runTimeoutMs) || runTimeoutMs <= 0) return 1;
  return Math.ceil(runTimeoutMs / CI_LIVE_LOG_TAIL_INTERVAL_MS) + 1;
}

/**
 * Take the last `maxBytes` UTF-8 bytes of `text`, reporting how many bytes
 * precede them. The slice never splits a multi-byte character, and `omitted`
 * counts BYTES (what a reader comparing against the job log's size needs), not
 * characters. Callers slice REDACTED output — never the reverse (ADR-0002).
 */
export function sliceLogTail(
  text: string,
  maxBytes: number
): { tail: string; omitted: number } {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= maxBytes) return { tail: text, omitted: 0 };
  if (maxBytes <= 0) return { tail: '', omitted: bytes.length };
  let start = bytes.length - maxBytes;
  // Never begin inside a multi-byte sequence: continuation bytes are 10xxxxxx.
  while (start < bytes.length && ((bytes[start] as number) & 0xc0) === 0x80) {
    start += 1;
  }
  return { tail: bytes.subarray(start).toString('utf8'), omitted: start };
}

function assertOmitted(omitted: number, what: string): void {
  if (!Number.isSafeInteger(omitted) || omitted < 0) {
    throw new Error(`${what}: omitted must be a non-negative byte count`);
  }
}

export function buildCiLiveLogTail(
  input: CiLiveLogTailInput,
  createdAt: number = now()
): UnsignedEvent {
  if (input.runId === '') throw new Error('a live log tail needs a run id');
  assertExpiration(createdAt, input.expiresAt, CI_MAX_LIVE_LOG_TAIL_TTL);
  const seen = new Set<string>();
  for (const job of input.jobs) {
    if (job.job === '') throw new Error('a live log tail job needs a job id');
    if (job.job === CI_RUNNER_CHANNEL_KEY) {
      throw new Error(
        `the runner channel is not a job: ${CI_RUNNER_CHANNEL_KEY} may not appear in jobs`
      );
    }
    if (seen.has(job.job)) {
      throw new Error(`job ${job.job} appears twice in one live log tail`);
    }
    seen.add(job.job);
    assertOmitted(job.omitted, `job ${job.job}`);
  }
  if (input.runner) assertOmitted(input.runner.omitted, 'runner channel');

  const content: {
    jobs: CiLiveLogTailJob[];
    runner?: CiLiveLogTailChannel;
  } = {
    jobs: input.jobs.map((j) => ({
      job: j.job,
      tail: j.tail,
      omitted: j.omitted,
    })),
  };
  if (input.runner) {
    content.runner = {
      tail: input.runner.tail,
      omitted: input.runner.omitted,
    };
  }
  return {
    kind: CI_LIVE_LOG_TAIL_KIND,
    content: JSON.stringify(content),
    tags: [
      ...commonTriggerTags(input.trigger),
      ['d', input.runId],
      ['expiration', String(input.expiresAt)],
    ],
    created_at: createdAt,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `omitted` is optional on the wire and defaults to 0; a bad one is fatal. */
function parseOmitted(value: unknown): number | null {
  if (value === undefined) return 0;
  if (!Number.isSafeInteger(value) || (value as number) < 0) return null;
  return value as number;
}

function parseTailChannel(value: unknown): CiLiveLogTailChannel | null {
  if (!isRecord(value)) return null;
  const omitted = parseOmitted(value['omitted']);
  const tail = value['tail'];
  if (typeof tail !== 'string' || omitted === null) return null;
  return { tail, omitted };
}

/**
 * Parse a Live Log Tail. Unknown fields — anywhere in the content, and unknown
 * tags — are ignored, so a later rig may add to the shape without breaking a
 * client; anything the shape does NOT allow (bad JSON, a jobs entry without a
 * job id, a duplicated job, a runner channel smuggled in as a job, an
 * expiration beyond the 30-minute bound) is `null` rather than a throw or a
 * half-populated result.
 */
export function parseCiLiveLogTail(ev: NostrEvent): CiLiveLogTail | null {
  if (ev.kind !== CI_LIVE_LOG_TAIL_KIND) return null;
  const { tags } = ev;
  const trigger = parseCiTriggerContext(tags);
  if (!trigger) return null;
  const d = single(tags, 'd');
  const exp = single(tags, 'expiration');
  if (!d || !d[1] || !exp) return null;
  const expiresAt = Number(exp[1]);
  if (
    !Number.isInteger(expiresAt) ||
    expiresAt <= ev.created_at ||
    expiresAt - ev.created_at > CI_MAX_LIVE_LOG_TAIL_TTL
  ) {
    return null;
  }

  let content: unknown;
  try {
    content = JSON.parse(ev.content);
  } catch {
    return null;
  }
  if (!isRecord(content) || !Array.isArray(content['jobs'])) return null;

  const jobs: CiLiveLogTailJob[] = [];
  const seen = new Set<string>();
  for (const entry of content['jobs']) {
    if (!isRecord(entry)) return null;
    const job = entry['job'];
    if (typeof job !== 'string' || job === '') return null;
    // The runner channel is never a job — two representations of one thing
    // would be ambiguous, so an event claiming both is malformed.
    if (job === CI_RUNNER_CHANNEL_KEY || seen.has(job)) return null;
    const channel = parseTailChannel(entry);
    if (!channel) return null;
    seen.add(job);
    jobs.push({ job, tail: channel.tail, omitted: channel.omitted });
  }

  let runner: CiLiveLogTailChannel | undefined;
  if (content['runner'] !== undefined) {
    const parsed = parseTailChannel(content['runner']);
    if (!parsed) return null;
    runner = parsed;
  }

  const result: CiLiveLogTail = {
    eventId: ev.id,
    pubkey: ev.pubkey.toLowerCase(),
    createdAt: ev.created_at,
    trigger,
    runId: d[1],
    jobs,
    expiresAt,
  };
  if (runner) result.runner = runner;
  return result;
}
