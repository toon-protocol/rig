/**
 * The coordinator loop (#125): what `rig ci serve` runs.
 *
 * A Coordinator is an ordinary rig identity (its own seed, wallet, and
 * channel) that watches served repos on ONE relay and turns triggers into
 * runs, publishing NIP-C1 progress and results as paid writes from its own
 * channel. The relay is the only control plane: every input is a relay
 * event, every output is a relay event or a store upload.
 *
 *   inputs   kind:30617/30618 (owner's announcement + state → maintainers,
 *            default branch, pushes), kind:1617/1618/1619 (pull requests and
 *            their updates), and the coordinator inbox — kind:9843/9844
 *            (Service Request / Stop), kind:9840 (Manual Trigger), kind:29846
 *            (Repository Secret Update), all with `p` = this coordinator.
 *   outputs  kind:19843 Advertisement (renewed before it expires), and per
 *            run the NIP-C1 sequence: 39842 `queued` → 39842 `in_progress`
 *            (frozen provenance, job list) → per job a log upload + 9841 +
 *            a renewed 39842 quoting it → 9842 → 39842 `concluded`.
 *
 * Authorization (user story 12): a repo is served only while
 * `selectServiceRequests` finds an accepted, unstopped 9843 from the owner or
 * a declared maintainer — or from a pubkey the operator explicitly accepts
 * (`acceptedRequesters`, NIP-C1's operator policy; story 21: a contributor
 * serving a repo they do not maintain, at lower trust) — re-evaluated at
 * EVERY trigger and again at runner handoff (the frozen `service-request`
 * quote). A Manual Trigger needs its author to be a maintainer and no
 * standing request. Secrets (story 7) are
 * injected only when the trigger's author is a maintainer; a stranger's pull
 * request runs with an empty secret set.
 *
 * Money (story 15): before a run publishes anything the coordinator asks the
 * publisher for its fee rates (a failure means the channel is not usable)
 * and consults the injectable `canAfford` seam; a refused run is logged and
 * never half-published. Every relay write and store upload goes through the
 * ONE `Publisher` rig already has (story 28), serialized — the standalone
 * publisher is a sequential, nonce-guarded transport.
 *
 * Restart safety (story 13): ./state.ts persists a per-repo cursor (last
 * processed event, the ref map pushes are diffed against, processed ids) and
 * the secret inventory; ./relay-subscription.ts reconnects with backoff and
 * resumes from the cursor. The very first sight of a repo records its refs
 * WITHOUT running anything, so a fresh coordinator never storms through a
 * repository's existing history.
 *
 * Runner seam (story 22): the coordinator materializes the commit itself
 * (./materialize-commit.ts, rig's free read path) and hands a checkout to a
 * `Runner`; nothing here knows about act or Docker.
 *
 * Deliberate departures from ngit's reference coordinator, all noted in the
 * spec: logs and artifacts go to the TOON store and are referenced by
 * gateway URL; the advertisement carries `B = out-of-band`; the repo's own
 * relay doubles as the secret inbox; kind:1617 patches (what `rig pr
 * create` publishes) are pull-request triggers too — the base is materialized
 * and the patch applied with `git am`, so the run's commit is the resulting
 * HEAD, with the patch's declared tip kept as a second `c` tag so a `#c`
 * lookup by either id finds the run.
 */

import { randomUUID } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { REPOSITORY_ANNOUNCEMENT_KIND } from '@toon-protocol/core/nip34';
import { contentTypeForPath } from '../mime.js';
import {
  REPOSITORY_STATE_KIND,
  authorizedStatusAuthors,
} from '../nip34-events.js';
import type { UnsignedEvent } from '../nip34-events.js';
import type { FetchLike } from '../object-fetch.js';
import type { FeeRates, Publisher } from '../publisher.js';
import {
  defaultWebSocketFactory,
  fetchRemoteState,
  queryRelay,
  type NostrEvent,
  type NostrFilter,
  type WebSocketFactory,
} from '../remote-state.js';
import { runGit } from '../materialize.js';
import {
  MaterializeError,
  materializeCommit,
  type MaterializeCommit,
} from './materialize-commit.js';
import {
  CI_MANUAL_TRIGGER_KIND,
  CI_SECRET_UPDATE_KIND,
  CI_SERVICE_REQUEST_KIND,
  CI_SERVICE_STOP_KIND,
  CI_WORKFLOW_PROGRESS_KIND,
  buildCiAdvertisement,
  buildCiJobResult,
  buildCiWorkflowProgress,
  buildCiWorkflowResult,
  parseCiManualTrigger,
  parseCiSecretUpdate,
  parseCiServiceControl,
  parseRepoAddress,
  repoAddress,
  selectServiceRequests,
  type CiConclusion,
  type CiJobQuote,
  type CiPrContext,
  type CiProvenance,
  type CiTriggerContext,
  type CiTriggerReason,
  type CiWorkflowRef,
  type RepoAddress,
  type ServiceControl,
} from './nip-c1-events.js';
import {
  subscribeRelay,
  realScheduler,
  type RelaySubscription,
  type Scheduler,
} from './relay-subscription.js';
import type { Runner, RunnerRunResult } from './runner.js';
import {
  applySecretUpdate,
  decryptSecretUpdate,
  effectiveSecrets,
  generateSecretsKey,
  validateSecretUpdate,
  type SecretInventory,
} from './secrets.js';
import {
  loadCoordinatorState,
  saveCursor,
  saveSecrets,
  type CoordinatorCursor,
  type InboxCursor,
  type RepoCursor,
} from './state.js';
import {
  discoverWorkflows,
  matchesPullRequest,
  matchesPush,
  type DiscoveredWorkflow,
} from './workflows.js';

// ---------------------------------------------------------------------------
// Options + handle
// ---------------------------------------------------------------------------

export interface CoordinatorRepo {
  ownerPubkey: string;
  repoId: string;
}

/** What one run is expected to cost, for the affordability seam. */
export interface RunCostEstimate {
  /** Relay events the run will publish (progress, job results, result). */
  events: number;
  /** Store uploads (one log per job, plus artifacts). */
  uploads: number;
  rates: FeeRates;
}

export type CanAfford = (estimate: RunCostEstimate) => Promise<boolean>;

/** What {@link CoordinatorOptions.onRunConcluded} reports: a run whose result is on the relay. */
export interface ConcludedRun {
  runId: string;
  repoAddr: RepoAddress;
  trigger: CiTriggerContext;
  conclusion: CiConclusion;
  /** Event id of the run's Workflow Result (9842). */
  resultEventId: string;
}

export interface CoordinatorOptions {
  /** Hex pubkey of the coordinator identity (the publisher signs as it). */
  coordinatorPubkey: string;
  publisher: Publisher;
  /** The ONE relay: subscriptions and paid publishes alike. */
  relayUrl: string;
  /** Gateway base URL for log/artifact links (`<gateway>/raw/<txId>`). */
  gatewayUrl: string;
  repos: CoordinatorRepo[];
  runner: Runner;
  stateDir: string;
  /** Where checkouts are materialized (one directory per trigger). */
  workdir: string;
  /** rig version, for the advertisement's `software` tag. */
  version: string;
  /** Concurrent runs (default 1). */
  concurrency?: number;
  /** Wall-clock budget per run in ms (default 30 min) → `timed_out`. */
  timeoutMs?: number;
  webSocketFactory?: WebSocketFactory;
  fetchFn?: FetchLike;
  resolveSha?: (sha: string, repo: string) => Promise<string | null>;
  gateways?: readonly string[];
  /** Unix-seconds clock (default: Date.now()/1000). */
  clock?: () => number;
  /** Timer seam (default: real timers). */
  scheduler?: Scheduler;
  log?: (line: string) => void;
  /** Materialization seam (default: the free read path). */
  materialize?: MaterializeCommit;
  /** Affordability seam (default: always true once fee rates are readable). */
  canAfford?: CanAfford;
  /**
   * Requester pubkeys (hex) whose Service Requests are accepted in addition
   * to the repo's owner and maintainers (NIP-C1 operator policy). They are
   * NOT maintainers: their Stops close only their own Requests, their pushes
   * and PRs get no secrets, and runs they cause carry lower trust.
   */
  acceptedRequesters?: Iterable<string>;
  /** Advertisement TTL in seconds (≤ 1800; default 1800, renewed at 5/6). */
  advertisementTtlSeconds?: number;
  /** Keep checkouts after their runs (default: delete). */
  keepCheckouts?: boolean;
  /**
   * Called once per run after its Workflow Result (9842) and final
   * `concluded` progress marker are published — including runs that never
   * reached the Runner (`startup_failure`, `cancelled`). Ignored or refused
   * triggers publish nothing and never reach it. `rig ci serve --once`
   * stops on the first call.
   */
  onRunConcluded?: (run: ConcludedRun) => void;
}

export interface CoordinatorHandle {
  pubkey: string;
  /** The current NIP-44 recipient (`secrets-key`) pubkey. */
  readonly secretsKeyPubkey: string;
  /** Id of the current advertisement event, once published. */
  readonly advertisementId: string | null;
  /** Resolves after `stop()` has finished. */
  stopped: Promise<void>;
  stop(): Promise<void>;
  /** Resolves when no event is being handled and no run is queued or active. */
  idle(): Promise<void>;
  /** Which served repos currently have an accepted, unstopped Service Request. */
  serving(): { repoAddr: RepoAddress; serving: boolean }[];
}

// ---------------------------------------------------------------------------
// Internal shapes
// ---------------------------------------------------------------------------

interface RepoRuntime {
  addr: RepoAddress;
  ownerPubkey: string;
  repoId: string;
  authorized: Set<string>;
  /** Every 9843/9844 seen for this repo (by event id). */
  controls: Map<string, ServiceControl>;
  cursor: RepoCursor | undefined;
  secrets: SecretInventory;
  /** Known 1617/1618 events by id, so a 1619 update can find its PR. */
  prEvents: Map<string, NostrEvent>;
  defaultBranch: string | null;
}

interface PendingTrigger {
  repo: RepoRuntime;
  reason: CiTriggerReason;
  /** Who caused the trigger — decides whether secrets are injected. */
  authorPubkey: string;
  /** The commit (or tag object) to materialize; a patch's base when `patch`. */
  commit: string;
  ref?: string;
  pr?: CiPrContext;
  patch?: { content: string; declaredTip?: string };
  manual?: {
    eventId: string;
    pubkey: string;
    workflow: CiWorkflowRef;
    tagObjectIds?: string[];
  };
}

interface Checkout {
  dir: string;
  refs: number;
}

interface QueuedRun {
  repo: RepoRuntime;
  trigger: CiTriggerContext;
  workflow: DiscoveredWorkflow;
  checkout: Checkout;
  secrets: Record<string, string>;
  manualProvenance?: CiProvenance;
  runId: string;
  queuedAt: number;
}

export const DEFAULT_RUN_TIMEOUT_MS = 30 * 60 * 1000;
export const DEFAULT_ADVERTISEMENT_TTL = 30 * 60;
/** Renew progress markers and the advertisement at this fraction of their TTL. */
const RENEW_FRACTION = 5 / 6;
/** How much of a job log rides in the 9841 content. */
export const LOG_TAIL_BYTES = 4096;
/** Rotate the secrets key at least this often (NIP-C1: no later than 86,400 s). */
const SECRETS_KEY_MAX_AGE = 86_400;

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** The last {@link LOG_TAIL_BYTES} of a log, plus how many bytes were cut. */
export function logTail(log: string): { tail: string; omitted: number } {
  const bytes = Buffer.from(log, 'utf-8');
  if (bytes.byteLength <= LOG_TAIL_BYTES) return { tail: log, omitted: 0 };
  const cut = bytes.subarray(bytes.byteLength - LOG_TAIL_BYTES);
  return {
    tail: cut.toString('utf-8'),
    omitted: bytes.byteLength - LOG_TAIL_BYTES,
  };
}

/** `<gateway>/raw/<txId>` — the TOON store's raw-bytes route. */
export function gatewayRawUrl(gatewayUrl: string, txId: string): string {
  return `${gatewayUrl.replace(/\/+$/, '')}/raw/${txId}`;
}

/** Which refs moved between two ref maps (new or changed shas). */
export function movedRefs(
  before: Record<string, string>,
  after: Record<string, string>
): { ref: string; sha: string }[] {
  const moved: { ref: string; sha: string }[] = [];
  for (const [ref, sha] of Object.entries(after)) {
    if (before[ref] !== sha) moved.push({ ref, sha });
  }
  return moved;
}

function parseRefsTags(ev: NostrEvent): {
  refs: Record<string, string>;
  head: string | null;
} {
  const refs: Record<string, string> = {};
  let head: string | null = null;
  for (const [name, v1, v2] of ev.tags) {
    if (name === 'r' && v1 && v2) {
      if (v1 === 'HEAD' && v2.startsWith('ref: ')) head = v2.slice(5);
      else refs[v1] = v2;
    } else if (name === 'HEAD' && v1?.startsWith('ref: ')) {
      head = v1.slice(5);
    }
  }
  return { refs, head };
}

function tagValues(tags: string[][], name: string): string[] {
  return tags
    .filter((t) => t[0] === name)
    .map((t) => t[1] ?? '')
    .filter((v) => v !== '');
}

/** A promise-based mutex: `publishEvent`/`uploadBlob` are called one at a time. */
class Serial {
  private chain: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => undefined);
    return next;
  }
}

// ---------------------------------------------------------------------------
// startCoordinator
// ---------------------------------------------------------------------------

export async function startCoordinator(
  opts: CoordinatorOptions
): Promise<CoordinatorHandle> {
  const me = opts.coordinatorPubkey.toLowerCase();
  const { publisher, relayUrl, runner } = opts;
  const concurrency = Math.max(1, opts.concurrency ?? 1);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
  const clock = opts.clock ?? nowSeconds;
  const scheduler = opts.scheduler ?? realScheduler;
  const log = opts.log ?? (() => undefined);
  const materialize = opts.materialize ?? materializeCommit;
  const canAfford: CanAfford = opts.canAfford ?? (async () => true);
  const acceptedRequesters = new Set(
    [...(opts.acceptedRequesters ?? [])].map((p) => p.toLowerCase())
  );
  const adTtl = Math.min(
    opts.advertisementTtlSeconds ?? DEFAULT_ADVERTISEMENT_TTL,
    1800
  );

  if (!publisher.uploadBlob) {
    throw new Error(
      'the coordinator needs a publisher that can upload blobs (job logs and artifacts) — ' +
        'the standalone publisher provides uploadBlob'
    );
  }
  const uploadBlob = publisher.uploadBlob.bind(publisher);
  if (opts.repos.length === 0)
    throw new Error('the coordinator needs at least one --repo to serve');

  const serial = new Serial();
  const publish = (event: UnsignedEvent): Promise<string> =>
    serial.run(
      async () => (await publisher.publishEvent(event, [relayUrl])).eventId
    );

  // ── State ────────────────────────────────────────────────────────────────
  const state = await loadCoordinatorState(opts.stateDir);
  const repos = new Map<RepoAddress, RepoRuntime>();
  for (const r of opts.repos) {
    const owner = r.ownerPubkey.toLowerCase();
    const addr = repoAddress(owner, r.repoId);
    repos.set(addr, {
      addr,
      ownerPubkey: owner,
      repoId: r.repoId,
      authorized: new Set([owner]),
      controls: new Map(),
      cursor: state.cursor[addr],
      secrets: state.secrets[addr] ?? {},
      prEvents: new Map(),
      defaultBranch: null,
    });
  }
  const inbox: InboxCursor = state.inbox;
  const inboxProcessed = new Set(inbox.processed);

  const persistCursor = async (): Promise<void> => {
    const cursor: CoordinatorCursor = {};
    for (const repo of repos.values())
      if (repo.cursor) cursor[repo.addr] = repo.cursor;
    inbox.processed = [...inboxProcessed];
    await saveCursor(opts.stateDir, cursor, inbox);
  };
  const persistSecrets = async (): Promise<void> => {
    const secrets: Record<string, SecretInventory> = {};
    for (const repo of repos.values()) secrets[repo.addr] = repo.secrets;
    await saveSecrets(opts.stateDir, secrets);
  };

  // ── Seed each repo from the relay (maintainers, default branch, refs) ────
  for (const repo of repos.values()) {
    const remote = await fetchRemoteState({
      relayUrls: [relayUrl],
      ownerPubkey: repo.ownerPubkey,
      repoId: repo.repoId,
      ...(opts.webSocketFactory
        ? { webSocketFactory: opts.webSocketFactory }
        : {}),
      ...(opts.resolveSha ? { resolveSha: opts.resolveSha } : {}),
    });
    if (remote.announceEvent) {
      repo.authorized = authorizedStatusAuthors(
        repo.ownerPubkey,
        remote.announceEvent.tags
      );
    }
    repo.defaultBranch = remote.headSymref;
    if (repo.cursor === undefined) {
      // First sight of this repo: remember where it stands, run nothing.
      repo.cursor = {
        lastCreatedAt: remote.refsEvent?.created_at ?? 0,
        lastEventId: remote.refsEvent?.id ?? '',
        refs: Object.fromEntries(remote.refs),
        processed: remote.refsEvent ? [remote.refsEvent.id] : [],
      };
      log(
        `[ci] ${repo.repoId}: recorded ${remote.refs.size} ref(s); watching for pushes`
      );
    }
  }
  await persistCursor();

  // ── Seed the Service Request / Stop history ─────────────────────────────
  // The live subscription replays it too, but a backlog push must not be
  // judged before the requests that authorize it have been read.
  const isServing = (repo: RepoRuntime): boolean =>
    selectServiceRequests([...repo.controls.values()], {
      coordinatorPubkey: me,
      repoAddr: repo.addr,
      authorized: repo.authorized,
      acceptedRequesters,
    }).active !== null;
  const handleControl = (ev: NostrEvent): void => {
    const control = parseCiServiceControl(ev);
    if (!control || control.coordinatorPubkey !== me) return;
    const repo = repos.get(control.repoAddr);
    if (!repo || repo.controls.has(control.eventId)) return;
    const before = isServing(repo);
    repo.controls.set(control.eventId, control);
    const after = isServing(repo);
    if (before !== after) {
      const who = repo.authorized.has(control.pubkey)
        ? 'maintainer'
        : 'operator-accepted requester';
      log(
        `[ci] ${repo.repoId}: ${after ? `serving (${who} Service Request accepted)` : 'service stopped'}`
      );
    } else if (
      control.kind === 'request' &&
      !repo.authorized.has(control.pubkey) &&
      !acceptedRequesters.has(control.pubkey.toLowerCase())
    ) {
      log(
        `[ci] ${repo.repoId}: Service Request from non-maintainer ${control.pubkey.slice(0, 8)} ignored`
      );
    }
  };
  const controlFilter: NostrFilter = {
    kinds: [CI_SERVICE_REQUEST_KIND, CI_SERVICE_STOP_KIND],
    '#p': [me],
  };
  try {
    const history = await queryRelay(
      relayUrl,
      controlFilter,
      10_000,
      opts.webSocketFactory ?? defaultWebSocketFactory
    );
    for (const ev of history) handleControl(ev);
  } catch (err) {
    log(
      `[ci] could not read the Service Request history: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  // ── Advertisement + secrets key ──────────────────────────────────────────
  let secretsKey = generateSecretsKey();
  let secretsKeyBorn = clock();
  let advertisementId: string | null = null;
  /** Advertisements naming the CURRENT secrets key (id → [created_at, expiration)). */
  const liveAdvertisements = new Map<
    string,
    { createdAt: number; expiresAt: number }
  >();
  let adTimer: unknown = null;
  let stopping = false;

  const advertise = async (): Promise<void> => {
    if (stopping) return;
    const now = clock();
    if (now - secretsKeyBorn >= SECRETS_KEY_MAX_AGE) {
      secretsKey = generateSecretsKey();
      secretsKeyBorn = now;
      liveAdvertisements.clear();
      log('[ci] rotated the secrets key');
    }
    const expiresAt = now + adTtl;
    const event = buildCiAdvertisement(
      {
        version: opts.version,
        selectors: runner.selectors,
        admission: 'maintainer-request',
        execution: 'request-required',
        billing: 'out-of-band',
        secretsKey: { pubkey: secretsKey.pubkey, inboxRelays: [relayUrl] },
        expiresAt,
      },
      now
    );
    try {
      advertisementId = await publish(event);
      liveAdvertisements.set(advertisementId, { createdAt: now, expiresAt });
    } catch (err) {
      log(
        `[ci] advertisement publish failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    if (!stopping) {
      adTimer = scheduler.setTimeout(
        () => void advertise(),
        adTtl * RENEW_FRACTION * 1000
      );
    }
  };
  await advertise();

  // ── Run queue + concurrency slots ───────────────────────────────────────
  const queue: QueuedRun[] = [];
  const activeAborts = new Set<AbortController>();
  let active = 0;
  let inflight = 0; // triggers being handled + runs active
  const idleWaiters: (() => void)[] = [];
  const checkIdle = (): void => {
    if (
      inflight === 0 &&
      queue.length === 0 &&
      eventQueue.length === 0 &&
      !draining
    ) {
      for (const w of idleWaiters.splice(0)) w();
    }
  };

  const releaseCheckout = async (checkout: Checkout): Promise<void> => {
    checkout.refs -= 1;
    if (checkout.refs <= 0 && !opts.keepCheckouts) {
      await rm(checkout.dir, { recursive: true, force: true }).catch(
        () => undefined
      );
    }
  };

  const progressAddress = (runId: string): string =>
    `${CI_WORKFLOW_PROGRESS_KIND}:${me}:${runId}`;

  const concludeWithoutJobs = async (
    run: QueuedRun,
    conclusion: CiConclusion,
    provenance: CiProvenance | undefined,
    startedAt?: number
  ): Promise<void> => {
    const base = {
      trigger: run.trigger,
      runId: run.runId,
      queuedAt: run.queuedAt,
      ...(startedAt !== undefined ? { startedAt } : {}),
      ...(provenance ? { provenance } : {}),
      jobs: [] as CiJobQuote[],
    };
    const now = clock();
    const resultEventId = await publish(
      buildCiWorkflowResult({ ...base, conclusion }, now)
    );
    await publish(
      buildCiWorkflowProgress(
        { ...base, status: 'concluded', conclusion, expiresAt: now + adTtl },
        now
      )
    );
    opts.onRunConcluded?.({
      runId: run.runId,
      repoAddr: run.repo.addr,
      trigger: run.trigger,
      conclusion,
      resultEventId,
    });
  };

  const executeRun = async (run: QueuedRun): Promise<void> => {
    const { repo, trigger, workflow } = run;
    const label = `${repo.repoId} ${workflow.path}@${trigger.commit.slice(0, 7)} [${run.runId.slice(0, 8)}]`;

    // Final handoff authorization: the frozen provenance quote.
    let provenance: CiProvenance | undefined = run.manualProvenance;
    if (!provenance) {
      const { active: request } = selectServiceRequests(
        [...repo.controls.values()],
        {
          coordinatorPubkey: me,
          repoAddr: repo.addr,
          authorized: repo.authorized,
          acceptedRequesters,
        }
      );
      if (!request) {
        log(`[ci] ${label}: service stopped before handoff — cancelled`);
        await concludeWithoutJobs(run, 'cancelled', undefined);
        return;
      }
      provenance = {
        kind: 'service-request',
        eventId: request.eventId,
        relayUrl,
        pubkey: request.pubkey,
      };
    }

    if (workflow.parseError !== undefined) {
      log(`[ci] ${label}: workflow parse error — startup_failure`);
      await concludeWithoutJobs(run, 'startup_failure', provenance, clock());
      return;
    }

    const startedAt = clock();
    const jobIds = workflow.jobs.map((j) => j.id);
    const quotes: CiJobQuote[] = [];
    const progress = (
      status: 'in_progress' | 'concluded',
      conclusion?: CiConclusion
    ) => {
      const now = clock();
      return buildCiWorkflowProgress(
        {
          trigger,
          runId: run.runId,
          status,
          ...(conclusion !== undefined ? { conclusion } : {}),
          inProgress:
            status === 'in_progress'
              ? jobIds.filter((id) => !quotes.some((q) => q.jobId === id))
              : [],
          queuedAt: run.queuedAt,
          startedAt,
          provenance: provenance as CiProvenance,
          jobs: quotes,
          expiresAt: now + adTtl,
        },
        now
      );
    };
    await publish(progress('in_progress'));
    log(`[ci] ${label}: in_progress (${jobIds.length} job(s))`);

    // Renew the in-progress marker before it expires on long runs.
    let renewTimer: unknown = null;
    const scheduleRenew = (): void => {
      renewTimer = scheduler.setTimeout(
        () => {
          void publish(progress('in_progress')).catch(() => undefined);
          scheduleRenew();
        },
        adTtl * RENEW_FRACTION * 1000
      );
    };
    scheduleRenew();

    const abort = new AbortController();
    activeAborts.add(abort);
    let timedOut = false;
    const timeoutHandle = scheduler.setTimeout(() => {
      timedOut = true;
      abort.abort();
    }, timeoutMs);

    let result: RunnerRunResult;
    try {
      result = await Promise.race([
        runner.run({
          checkoutDir: run.checkout.dir,
          workflow: { path: workflow.path, sha256: workflow.sha256 },
          trigger,
          secrets: run.secrets,
          timeoutMs,
          signal: abort.signal,
        }),
        new Promise<RunnerRunResult>((resolve) => {
          abort.signal.addEventListener(
            'abort',
            () => {
              // Give the runner a moment to report its own teardown; if it
              // does not, conclude on its behalf.
              scheduler.setTimeout(
                () =>
                  resolve({
                    conclusion: timedOut ? 'timed_out' : 'cancelled',
                    jobs: [],
                    startedAt,
                    finishedAt: clock(),
                  }),
                1000
              );
            },
            { once: true }
          );
        }),
      ]);
    } catch (err) {
      log(
        `[ci] ${label}: runner failed: ${err instanceof Error ? err.message : String(err)}`
      );
      result = {
        conclusion: 'startup_failure',
        jobs: [],
        startedAt,
        finishedAt: clock(),
      };
    } finally {
      scheduler.clearTimeout(timeoutHandle);
      scheduler.clearTimeout(renewTimer);
      activeAborts.delete(abort);
    }
    let conclusion = result.conclusion;
    if (timedOut) conclusion = 'timed_out';
    else if (stopping && abort.signal.aborted) conclusion = 'cancelled';

    // Per job: upload the log (+ artifacts), publish 9841, renew 39842.
    for (const job of result.jobs) {
      const { tail, omitted } = logTail(job.log);
      const logReceipt = await serial.run(() =>
        uploadBlob({
          body: Buffer.from(job.log, 'utf-8'),
          contentType: 'text/plain; charset=utf-8',
          repoId: repo.repoId,
        })
      );
      const artifacts: { url: string; filename: string; name: string }[] = [];
      for (const artifact of job.artifacts) {
        try {
          const body = await readFile(artifact.path);
          const receipt = await serial.run(() =>
            uploadBlob({
              body,
              contentType: contentTypeForPath(artifact.filename),
              repoId: repo.repoId,
            })
          );
          artifacts.push({
            url: gatewayRawUrl(opts.gatewayUrl, receipt.txId),
            filename: artifact.filename,
            name: artifact.name,
          });
        } catch (err) {
          log(
            `[ci] ${label}: artifact ${artifact.filename} skipped: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }
      const runsOn = workflow.jobs.find((j) => j.id === job.jobId)?.runsOn;
      const jobConclusion: CiConclusion =
        timedOut && job.conclusion === 'failure' ? 'timed_out' : job.conclusion;
      const jobEventId = await publish(
        buildCiJobResult(
          {
            trigger,
            progressAddress: progressAddress(run.runId),
            relayUrl,
            jobId: job.jobId,
            ...(job.name !== undefined ? { name: job.name } : {}),
            conclusion: jobConclusion,
            logsUrl: gatewayRawUrl(opts.gatewayUrl, logReceipt.txId),
            logTail: tail,
            logOmittedBytes: omitted,
            artifacts,
            queuedAt: run.queuedAt,
            startedAt: job.startedAt,
            ...(job.exitCode !== undefined ? { exitCode: job.exitCode } : {}),
            ...(runsOn ? { runsOn } : {}),
          },
          clock()
        )
      );
      quotes.push({
        eventId: jobEventId,
        relayUrl,
        pubkey: me,
        jobId: job.jobId,
      });
      await publish(progress('in_progress'));
    }

    const now = clock();
    const resultEventId = await publish(
      buildCiWorkflowResult(
        {
          trigger,
          runId: run.runId,
          conclusion,
          queuedAt: run.queuedAt,
          startedAt,
          provenance,
          jobs: quotes,
        },
        now
      )
    );
    await publish(progress('concluded', conclusion));
    log(`[ci] ${label}: ${conclusion}`);
    opts.onRunConcluded?.({
      runId: run.runId,
      repoAddr: repo.addr,
      trigger,
      conclusion,
      resultEventId,
    });
  };

  const pump = (): void => {
    while (active < concurrency && queue.length > 0 && !stopping) {
      const run = queue.shift() as QueuedRun;
      active += 1;
      inflight += 1;
      void executeRun(run)
        .catch((err) => {
          log(
            `[ci] run ${run.runId.slice(0, 8)} failed: ${err instanceof Error ? err.message : String(err)}`
          );
        })
        .finally(async () => {
          active -= 1;
          inflight -= 1;
          await releaseCheckout(run.checkout);
          pump();
          checkIdle();
        });
    }
  };

  const enqueueRun = async (
    repo: RepoRuntime,
    trigger: CiTriggerContext,
    workflow: DiscoveredWorkflow,
    checkout: Checkout,
    secrets: Record<string, string>,
    manualProvenance?: CiProvenance
  ): Promise<void> => {
    // Money first (story 15): unreadable fee rates or an unaffordable run
    // means nothing is published for it.
    let rates: FeeRates;
    try {
      rates = await publisher.getFeeRates();
    } catch (err) {
      log(
        `[ci] refusing run of ${workflow.path} for ${repo.repoId}: cannot read fee rates ` +
          `(${err instanceof Error ? err.message : String(err)}) — is the wallet funded?`
      );
      return;
    }
    const jobs = Math.max(1, workflow.jobs.length);
    if (!(await canAfford({ events: 4 + 2 * jobs, uploads: jobs, rates }))) {
      log(
        `[ci] refusing run of ${workflow.path} for ${repo.repoId}: wallet cannot cover its writes`
      );
      return;
    }
    const run: QueuedRun = {
      repo,
      trigger,
      workflow,
      checkout,
      secrets,
      ...(manualProvenance ? { manualProvenance } : {}),
      runId: randomUUID(),
      queuedAt: clock(),
    };
    checkout.refs += 1;
    const position = active + queue.length + 1;
    const now = clock();
    await publish(
      buildCiWorkflowProgress(
        {
          trigger,
          runId: run.runId,
          status: 'queued',
          queue: Math.ceil(position / concurrency),
          queuedAt: run.queuedAt,
          ...(manualProvenance ? { provenance: manualProvenance } : {}),
          jobs: [],
          expiresAt: now + adTtl,
        },
        now
      )
    );
    queue.push(run);
    log(
      `[ci] queued ${workflow.path} for ${repo.repoId}@${trigger.commit.slice(0, 7)} [${run.runId.slice(0, 8)}]`
    );
    pump();
  };

  // ── Trigger handling: materialize → discover → enqueue ──────────────────
  let checkoutCounter = 0;

  const handleTrigger = async (t: PendingTrigger): Promise<void> => {
    const { repo } = t;
    inflight += 1;
    try {
      const dir = join(
        opts.workdir,
        `${repo.repoId}-${t.commit.slice(0, 7)}-${++checkoutCounter}`
      );
      let materialized;
      try {
        materialized = await materialize({
          ownerPubkey: repo.ownerPubkey,
          repoId: repo.repoId,
          relayUrls: [relayUrl],
          commit: t.commit,
          dir,
          ...(t.patch ? { patch: { content: t.patch.content } } : {}),
          ...(t.manual?.tagObjectIds && t.manual.tagObjectIds.length > 0
            ? { extraObjectIds: t.manual.tagObjectIds }
            : {}),
          ...(opts.webSocketFactory
            ? { webSocketFactory: opts.webSocketFactory }
            : {}),
          ...(opts.fetchFn ? { fetchFn: opts.fetchFn } : {}),
          ...(opts.resolveSha ? { resolveSha: opts.resolveSha } : {}),
          ...(opts.gateways ? { gateways: opts.gateways } : {}),
        });
      } catch (err) {
        const reason =
          err instanceof MaterializeError
            ? err.message
            : `materialize failed: ${err instanceof Error ? err.message : String(err)}`;
        log(`[ci] ${repo.repoId}@${t.commit.slice(0, 7)}: ${reason}`);
        if (t.manual) {
          // The workflow is known from the request, so the failure can be published.
          const trigger: CiTriggerContext = {
            repoAddr: repo.addr,
            commit: t.commit,
            workflow: t.manual.workflow,
            reason: 'manual',
            ...(t.ref !== undefined ? { ref: t.ref } : {}),
            ...(t.pr ? { pr: t.pr } : {}),
          };
          const checkout: Checkout = { dir, refs: 0 };
          const provenance: CiProvenance = {
            kind: 'manual-trigger',
            eventId: t.manual.eventId,
            relayUrl,
            pubkey: t.manual.pubkey,
          };
          const broken: DiscoveredWorkflow = {
            ...t.manual.workflow,
            triggers: {},
            jobs: [],
            parseError: reason,
          };
          await enqueueRun(repo, trigger, broken, checkout, {}, provenance);
        }
        return;
      }

      const checkout: Checkout = { dir: materialized.dir, refs: 0 };
      const commit = materialized.commit;

      // NIP-C1 Manual Trigger: "A coordinator MUST resolve every supplied `c`
      // object and ignore the request unless all supplied object ids peel to
      // the same commit id." Extra `c` values are annotated tags; peel each
      // in the checkout and drop the request on any miss or mismatch.
      if (t.manual?.tagObjectIds && t.manual.tagObjectIds.length > 0) {
        const mismatch = await findUnpeelableTagId(
          materialized.dir,
          t.manual.tagObjectIds,
          commit
        );
        if (mismatch !== null) {
          log(
            `[ci] manual trigger ignored: c ${mismatch.slice(0, 7)} does not peel to ${commit.slice(0, 7)} (or is not in the repo)`
          );
          if (!opts.keepCheckouts)
            await rm(materialized.dir, { recursive: true, force: true }).catch(
              () => undefined
            );
          return;
        }
      }

      const workflows = await discoverWorkflows(materialized.dir);
      const tagObjectIds = [
        ...(t.manual?.tagObjectIds ?? []),
        ...(commit !== t.commit && !t.patch ? [t.commit] : []),
        ...(t.patch?.declaredTip && t.patch.declaredTip !== commit
          ? [t.patch.declaredTip]
          : []),
      ];
      const secretsAllowed = repo.authorized.has(t.authorPubkey.toLowerCase());
      const secrets = secretsAllowed ? effectiveSecrets(repo.secrets) : {};

      let selected: DiscoveredWorkflow[];
      let manualProvenance: CiProvenance | undefined;
      if (t.manual) {
        const wanted = t.manual.workflow;
        const wf = workflows.find((w) => w.path === wanted.path);
        if (!wf) {
          log(
            `[ci] manual trigger ignored: ${wanted.path} does not exist at ${commit.slice(0, 7)}`
          );
          selected = [];
        } else if (wf.sha256 !== wanted.sha256.toLowerCase()) {
          log(
            `[ci] manual trigger ignored: ${wanted.path} at ${commit.slice(0, 7)} has sha256 ${wf.sha256}, request named ${wanted.sha256}`
          );
          selected = [];
        } else {
          selected = [wf];
        }
        manualProvenance = {
          kind: 'manual-trigger',
          eventId: t.manual.eventId,
          relayUrl,
          pubkey: t.manual.pubkey,
        };
      } else if (t.reason === 'push') {
        selected = workflows.filter(
          (wf) =>
            wf.parseError !== undefined || matchesPush(wf, t.ref as string)
        );
      } else {
        const base = repo.defaultBranch ?? undefined;
        selected = workflows.filter(
          (wf) => wf.parseError !== undefined || matchesPullRequest(wf, base)
        );
      }

      if (selected.length === 0) {
        if (!opts.keepCheckouts)
          await rm(materialized.dir, { recursive: true, force: true }).catch(
            () => undefined
          );
        return;
      }
      for (const wf of selected) {
        // Only the served perspective is published as `a`. NIP-C1 lets a
        // Manual Trigger name other maintainers' announcements, but "a
        // coordinator MUST resolve every `a` tag independently and MUST NOT
        // run a workflow for a repository merely because it was named": rig
        // serves one perspective per repo and verifies only that one, so it
        // does not republish the others as if it had.
        const trigger: CiTriggerContext = {
          repoAddr: repo.addr,
          commit,
          ...(tagObjectIds.length > 0 ? { tagObjectIds } : {}),
          workflow: { path: wf.path, sha256: wf.sha256 },
          reason: t.reason,
          ...(t.pr ? { pr: t.pr } : t.ref !== undefined ? { ref: t.ref } : {}),
        };
        await enqueueRun(
          repo,
          trigger,
          wf,
          checkout,
          secrets,
          manualProvenance
        );
      }
      if (checkout.refs === 0 && !opts.keepCheckouts) {
        await rm(materialized.dir, { recursive: true, force: true }).catch(
          () => undefined
        );
      }
    } finally {
      inflight -= 1;
      checkIdle();
    }
  };

  // ── Event handling (serialized) ──────────────────────────────────────────
  const eventQueue: NostrEvent[] = [];
  let draining = false;

  const markRepoProcessed = (repo: RepoRuntime, ev: NostrEvent): void => {
    const cursor = repo.cursor as RepoCursor;
    cursor.processed.push(ev.id);
    if (ev.created_at > cursor.lastCreatedAt) {
      cursor.lastCreatedAt = ev.created_at;
      cursor.lastEventId = ev.id;
    }
  };
  const repoSeen = (repo: RepoRuntime, ev: NostrEvent): boolean =>
    (repo.cursor?.processed ?? []).includes(ev.id);

  const handleRepoState = async (
    repo: RepoRuntime,
    ev: NostrEvent
  ): Promise<void> => {
    const cursor = repo.cursor as RepoCursor;
    if (repoSeen(repo, ev) || ev.created_at < cursor.lastCreatedAt) return;
    const { refs, head } = parseRefsTags(ev);
    if (head) repo.defaultBranch = head;
    const moved = movedRefs(cursor.refs, refs);
    cursor.refs = refs;
    markRepoProcessed(repo, ev);
    await persistCursor();
    if (moved.length === 0) return;
    if (!isServing(repo)) {
      log(
        `[ci] ${repo.repoId}: push seen but no maintainer Service Request — not running`
      );
      return;
    }
    for (const { ref, sha } of moved) {
      if (!ref.startsWith('refs/heads/') && !ref.startsWith('refs/tags/'))
        continue;
      await handleTrigger({
        repo,
        reason: 'push',
        authorPubkey: ev.pubkey,
        commit: sha,
        ref,
      });
    }
  };

  const handlePullRequest = async (
    repo: RepoRuntime,
    ev: NostrEvent
  ): Promise<void> => {
    if (repoSeen(repo, ev)) return;
    if (ev.kind === 1617 || ev.kind === 1618) repo.prEvents.set(ev.id, ev);
    markRepoProcessed(repo, ev);
    await persistCursor();
    if (!isServing(repo)) {
      log(
        `[ci] ${repo.repoId}: pull request seen but no maintainer Service Request — not running`
      );
      return;
    }
    const author = ev.pubkey.toLowerCase();
    if (ev.kind === 1617) {
      const parents = tagValues(ev.tags, 'parent-commit');
      const commits = tagValues(ev.tags, 'commit');
      const base = parents[0];
      if (!base || ev.content.trim() === '') {
        log(
          `[ci] ${repo.repoId}: patch ${ev.id.slice(0, 8)} has no parent-commit/content — cannot run`
        );
        return;
      }
      const declaredTip = commits[commits.length - 1];
      await handleTrigger({
        repo,
        reason: 'pull_request',
        authorPubkey: author,
        commit: base,
        patch: { content: ev.content, ...(declaredTip ? { declaredTip } : {}) },
        pr: {
          prEventId: ev.id,
          prAuthor: author,
          prKind: 1617,
          sourceEventId: ev.id,
          sourceAuthor: author,
          sourceKind: 1617,
        },
      });
      return;
    }
    if (ev.kind === 1618) {
      const tip = tagValues(ev.tags, 'c')[0];
      if (!tip) {
        log(
          `[ci] ${repo.repoId}: pull request ${ev.id.slice(0, 8)} has no tip commit — cannot run`
        );
        return;
      }
      await handleTrigger({
        repo,
        reason: 'pull_request',
        authorPubkey: author,
        commit: tip,
        pr: {
          prEventId: ev.id,
          prAuthor: author,
          prKind: 1618,
          sourceEventId: ev.id,
          sourceAuthor: author,
          sourceKind: 1618,
        },
      });
      return;
    }
    // 1619: PR update — the PR it moves must be known.
    const prId = tagValues(ev.tags, 'E')[0];
    const pr = prId ? repo.prEvents.get(prId) : undefined;
    const tip = tagValues(ev.tags, 'c')[0];
    if (!pr || !tip) {
      log(
        `[ci] ${repo.repoId}: PR update ${ev.id.slice(0, 8)} references an unknown PR or no commit — ignored`
      );
      return;
    }
    await handleTrigger({
      repo,
      reason: 'pull_request',
      authorPubkey: author,
      commit: tip,
      pr: {
        prEventId: pr.id,
        prAuthor: pr.pubkey.toLowerCase(),
        prKind: pr.kind === 1617 ? 1617 : 1618,
        sourceEventId: ev.id,
        sourceAuthor: author,
        sourceKind: 1619,
      },
    });
  };

  const handleManualTrigger = async (ev: NostrEvent): Promise<void> => {
    if (inboxProcessed.has(ev.id)) return;
    inboxProcessed.add(ev.id);
    inbox.lastCreatedAt = Math.max(inbox.lastCreatedAt ?? 0, ev.created_at);
    await persistCursor();
    const manual = parseCiManualTrigger(ev, me);
    if (!manual) {
      log(`[ci] malformed manual trigger ${ev.id.slice(0, 8)} ignored`);
      return;
    }
    const repo = repos.get(manual.trigger.repoAddr);
    if (!repo) {
      log(
        `[ci] manual trigger for unserved repo ${manual.trigger.repoAddr} ignored`
      );
      return;
    }
    if (!repo.authorized.has(manual.pubkey)) {
      log(
        `[ci] manual trigger from non-maintainer ${manual.pubkey.slice(0, 8)} ignored`
      );
      return;
    }
    const t = manual.trigger;
    await handleTrigger({
      repo,
      reason: 'manual',
      authorPubkey: manual.pubkey,
      commit: t.commit,
      ...(t.ref !== undefined ? { ref: t.ref } : {}),
      ...(t.pr ? { pr: t.pr } : {}),
      manual: {
        eventId: manual.eventId,
        pubkey: manual.pubkey,
        workflow: t.workflow,
        ...(t.tagObjectIds ? { tagObjectIds: t.tagObjectIds } : {}),
      },
    });
  };

  const handleSecretUpdate = async (ev: NostrEvent): Promise<void> => {
    if (inboxProcessed.has(ev.id)) return;
    inboxProcessed.add(ev.id);
    inbox.lastCreatedAt = Math.max(inbox.lastCreatedAt ?? 0, ev.created_at);
    await persistCursor();
    const update = parseCiSecretUpdate(ev);
    if (!update || update.coordinatorPubkey !== me) return;
    // NIP-C1: the `a` coordinate is the MAINTAINER's own repository perspective
    // (`30617:<maintainer>:<repo-id>`, signer == its pubkey). rig serves one
    // perspective per repo id, so the update lands on the served repo with
    // that id — provided the signer is one of its maintainers.
    const perspective = parseRepoAddress(update.repoAddr);
    const repo = perspective
      ? [...repos.values()].find((r) => r.repoId === perspective.repoId)
      : undefined;
    if (!repo) {
      log(`[ci] secret update for unserved repo ${update.repoAddr} ignored`);
      return;
    }
    if (!repo.authorized.has(update.pubkey)) {
      log(
        `[ci] ${repo.repoId}: secret update from non-maintainer ${update.pubkey.slice(0, 8)} ignored`
      );
      return;
    }
    const ad = liveAdvertisements.get(update.advertisementId);
    if (!ad || update.recipientPubkey !== secretsKey.pubkey) {
      log(
        `[ci] ${repo.repoId}: secret update ${ev.id.slice(0, 8)} addressed to a stale secrets key — re-send it`
      );
      return;
    }
    if (update.createdAt < ad.createdAt || update.createdAt >= ad.expiresAt) {
      log(
        `[ci] ${repo.repoId}: secret update ${ev.id.slice(0, 8)} outside its advertisement window — ignored`
      );
      return;
    }
    try {
      const plain = decryptSecretUpdate(
        update.ciphertext,
        secretsKey.secretKey,
        update.senderPubkey
      );
      validateSecretUpdate(plain, {
        pubkey: ev.pubkey,
        created_at: ev.created_at,
      });
      repo.secrets = applySecretUpdate(repo.secrets, plain, ev.id);
      await persistSecrets();
      const names = [...Object.keys(plain.set), ...plain.remove];
      log(
        `[ci] ${repo.repoId}: secrets updated by ${update.pubkey.slice(0, 8)} (${names.join(', ')})`
      );
    } catch (err) {
      log(
        `[ci] ${repo.repoId}: secret update ${ev.id.slice(0, 8)} rejected: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  };

  const handleEvent = async (ev: NostrEvent): Promise<void> => {
    switch (ev.kind) {
      case REPOSITORY_ANNOUNCEMENT_KIND: {
        const repoId = tagValues(ev.tags, 'd')[0];
        const repo = repoId
          ? repos.get(repoAddress(ev.pubkey, repoId))
          : undefined;
        if (repo && ev.pubkey.toLowerCase() === repo.ownerPubkey) {
          repo.authorized = authorizedStatusAuthors(repo.ownerPubkey, ev.tags);
        }
        return;
      }
      case REPOSITORY_STATE_KIND: {
        const repoId = tagValues(ev.tags, 'd')[0];
        const repo = repoId
          ? repos.get(repoAddress(ev.pubkey, repoId))
          : undefined;
        if (repo && ev.pubkey.toLowerCase() === repo.ownerPubkey)
          await handleRepoState(repo, ev);
        return;
      }
      case 1617:
      case 1618:
      case 1619: {
        for (const addr of tagValues(ev.tags, 'a')) {
          const repo = repos.get(addr);
          if (repo) {
            await handlePullRequest(repo, ev);
            return;
          }
        }
        return;
      }
      case CI_SERVICE_REQUEST_KIND:
      case CI_SERVICE_STOP_KIND:
        handleControl(ev);
        return;
      case CI_MANUAL_TRIGGER_KIND:
        await handleManualTrigger(ev);
        return;
      case CI_SECRET_UPDATE_KIND:
        await handleSecretUpdate(ev);
        return;
      default:
        return;
    }
  };

  const drain = async (): Promise<void> => {
    if (draining) return;
    draining = true;
    try {
      while (eventQueue.length > 0) {
        const ev = eventQueue.shift() as NostrEvent;
        try {
          await handleEvent(ev);
        } catch (err) {
          log(
            `[ci] event ${ev.id.slice(0, 8)} (kind ${ev.kind}) failed: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }
    } finally {
      draining = false;
      checkIdle();
    }
  };

  // ── Subscriptions ────────────────────────────────────────────────────────
  const filters: NostrFilter[] = [controlFilter];
  const sinceFor: ((() => number | undefined) | null)[] = [null];
  for (const repo of repos.values()) {
    filters.push({
      kinds: [REPOSITORY_ANNOUNCEMENT_KIND, REPOSITORY_STATE_KIND],
      authors: [repo.ownerPubkey],
      '#d': [repo.repoId],
    });
    sinceFor.push(null);
    filters.push({ kinds: [1617, 1618, 1619], '#a': [repo.addr] });
    sinceFor.push(() => repo.cursor?.lastCreatedAt);
  }
  filters.push({
    kinds: [CI_MANUAL_TRIGGER_KIND, CI_SECRET_UPDATE_KIND],
    '#p': [me],
  });
  sinceFor.push(() => inbox.lastCreatedAt);

  const subscription: RelaySubscription = subscribeRelay({
    url: relayUrl,
    filters,
    webSocketFactory: opts.webSocketFactory ?? defaultWebSocketFactory,
    scheduler,
    onEvent: (ev) => {
      eventQueue.push(ev);
      void drain();
    },
    onStatus: (status, detail) => {
      if (status === 'open') log(`[ci] connected to ${relayUrl}`);
      else if (status === 'reconnecting')
        log(`[ci] relay connection lost (${detail ?? ''}) — reconnecting`);
    },
    since: (index) => sinceFor[index]?.() ?? undefined,
  });

  // ── Stop ─────────────────────────────────────────────────────────────────
  let stopResolve: () => void = () => undefined;
  const stopped = new Promise<void>((resolve) => {
    stopResolve = resolve;
  });
  let stopPromise: Promise<void> | null = null;

  const stop = (): Promise<void> => {
    if (stopPromise) return stopPromise;
    stopPromise = (async () => {
      stopping = true;
      subscription.close();
      if (adTimer !== null) scheduler.clearTimeout(adTimer);
      const dropped = queue.splice(0);
      for (const run of dropped) {
        log(
          `[ci] dropping queued run ${run.runId.slice(0, 8)} (its queued marker expires on its own)`
        );
        await releaseCheckout(run.checkout);
      }
      for (const abort of activeAborts) abort.abort();
      await new Promise<void>((resolve) => {
        if (inflight === 0 && !draining) return resolve();
        idleWaiters.push(resolve);
      });
      await persistCursor();
      stopResolve();
    })();
    return stopPromise;
  };

  return {
    pubkey: me,
    get secretsKeyPubkey() {
      return secretsKey.pubkey;
    },
    get advertisementId() {
      return advertisementId;
    },
    stopped,
    stop,
    idle: () =>
      new Promise<void>((resolve) => {
        if (
          inflight === 0 &&
          queue.length === 0 &&
          eventQueue.length === 0 &&
          !draining
        )
          return resolve();
        idleWaiters.push(resolve);
      }),
    serving: () =>
      [...repos.values()].map((repo) => ({
        repoAddr: repo.addr,
        serving: isServing(repo),
      })),
  };
}

/**
 * Peel every `c` tag id a Manual Trigger supplied and return the first one
 * that is missing from the checkout or peels to a different commit than the
 * run's, or null when they all agree (NIP-C1 Manual Trigger rule).
 */
async function findUnpeelableTagId(
  checkoutDir: string,
  tagObjectIds: readonly string[],
  commit: string
): Promise<string | null> {
  for (const id of tagObjectIds) {
    if (!/^[0-9a-f]{40}$/i.test(id)) return id;
    let peeled: string;
    try {
      peeled = (
        await runGit(checkoutDir, [
          'rev-parse',
          '--verify',
          '--quiet',
          `${id}^{commit}`,
        ])
      ).trim();
    } catch {
      return id;
    }
    if (peeled.toLowerCase() !== commit.toLowerCase()) return id;
  }
  return null;
}
