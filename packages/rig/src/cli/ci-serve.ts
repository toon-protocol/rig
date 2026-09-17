/**
 * `rig ci serve` — run a CI coordinator (#125).
 *
 * The coordinator is an ORDINARY rig identity: the same seed-phrase chain,
 * wallet, channel, and connector configuration every paid command uses
 * (`rig identity create` under a separate `TOON_CLIENT_HOME` or account, `rig
 * entry <url>`, `rig fund`). Its spend is bounded by what its operator put in
 * its wallet — there is no separate cap. The maintainer's seed is never on
 * this host: authorization arrives as kind:9843 Service Requests on the
 * relay, and `rig ci serve` just listens.
 *
 * This module is the thin CLI shell around ../ci/coordinator.ts: flags →
 * paid session (always embedded; the daemon has no NIP-C1 routes) → Runner
 * (act on the host's Docker, or an injected one) → `startCoordinator` →
 * block until SIGINT/SIGTERM (or the injected abort signal) → clean stop.
 * Under `--once` the block also ends when the first run concludes — its
 * Workflow Result and final progress marker are on the relay — so one
 * `rig ci trigger` can be answered by one bounded `rig ci serve --once`
 * (#127); ignored or refused triggers publish nothing and do not count.
 * Everything the coordinator says goes to stderr; under `--json` stdout
 * carries exactly ONE document, emitted at start, describing what is being
 * served.
 *
 * Loaded lazily from ./ci.ts so one-shot `rig ci` verbs never pay for the
 * coordinator's imports.
 */

import { join } from 'node:path';
import { parseArgs } from 'node:util';
import {
  ActRunner,
  DEFAULT_ACT_PLATFORMS,
  type ActRunnerOptions,
} from '../ci/act-runner.js';
import {
  DEFAULT_CONCURRENCY,
  DEFAULT_RUN_TIMEOUT_MS,
  startCoordinator,
  type CanAfford,
  type ConcludedRun,
  type CoordinatorHandle,
  type CoordinatorRepo,
  type RunCostEstimate,
} from '../ci/coordinator.js';
import { uploadChargeFor } from '../publisher.js';
import {
  ChannelMapStore,
  channelStatus,
  resolveChannelPaths,
} from '../standalone/channel-map.js';
import type { Runner } from '../ci/runner.js';
import { defaultCoordinatorStateDir } from '../ci/state.js';
import { ARWEAVE_GATEWAYS } from '@toon-protocol/arweave';
import { PREFERRED_GATEWAY } from '../gateway-preference.js';
import { hexToNpub, ownerToHex } from '../npub.js';
import type { CiDeps } from './ci.js';
import { rigVersion } from './dispatch.js';
import { emitCliError } from './errors.js';
import {
  identityReport,
  loadPaidSession,
  withForcedStandalone,
} from './push.js';
import { WS_URL_RE } from './repo-command.js';
import { renderIdentityLine } from './render.js';
import type { StandaloneContext } from './standalone-context.js';

export const CI_SERVE_USAGE = `Usage: rig ci serve --relay <ws-url> --repo <owner>/<repo-id> [--repo …] [options]

Run a CI coordinator: watch the named repos on the relay, run their
GitHub-Actions-syntax workflows with act on this host's Docker, and publish
NIP-C1 progress and results back to the relay as PAID writes from THIS
identity's channel. Every run is a handful of relay writes (one per progress
update, job, and result) plus one store upload per job log and artifact.

A repo is served only while one of its maintainers has published a Service
Request (\`rig ci request <this-coordinator>\`) with no later Stop; a
maintainer's \`rig ci trigger\` runs one workflow without a standing request.
Secrets set with \`rig ci secret\` are injected only into runs authored by a
maintainer — never into a third-party pull request.

Options:
  --relay <url>          the relay to watch AND publish to (ws:// or wss://)
                         [required, exactly one]
  --repo <owner>/<id>    a repo to serve (owner as npub or hex); repeatable
  --requester <pubkey>   also accept Service Requests from this pubkey (npub
                         or hex; NIP-C1 operator policy); repeatable — for
                         running your own coordinator against a repo you do
                         not maintain; such runs show as lower trust
  --concurrency <n>      runs executed at once (default ${DEFAULT_CONCURRENCY}); more queue
  --timeout <seconds>    wall-clock budget per run → timed_out
                         (default ${DEFAULT_RUN_TIMEOUT_MS / 1000})
  --gateway <url>        gateway that serves the store's raw bytes: where log +
                         artifact links point, and the first place the
                         coordinator reads objects from (<url>/raw/<txId>)
                         before the shared gateway list (default:
                         RIG_ARWEAVE_GATEWAY, else ${PREFERRED_GATEWAY})
  --act-bin <path>       the act executable (default: RIG_ACT_BIN, else PATH)
  --platform <label=img> runs-on label → Docker image; repeatable
                         (default: ubuntu-latest=${DEFAULT_ACT_PLATFORMS['ubuntu-latest']})
  --pull                 pull the runner image before each run (act's default)
  --no-pull              never pull: run the image already on this host —
                         what a locally built or otherwise private runner
                         image needs, since act cannot pull it (act's own
                         spelling, --pull=false, is accepted too)
  --workdir <dir>        where commits are checked out for runs (default:
                         <state-dir>/work)
  --once                 stop after the first run concludes (its Workflow
                         Result and final progress marker are on the relay);
                         ignored or refused triggers do not count
  --json                 emit ONE JSON document describing the coordinator
                         at start; everything else goes to stderr
  --standalone           accepted for symmetry; the coordinator always runs
                         embedded (alias: --no-daemon)
  -h, --help             show this help

State (cursor, secret inventory) lives under
<TOON_CLIENT_HOME|~/.toon-client>/rig-ci/<coordinator-pubkey>/ so a restart
resumes from the last processed event. The NIP-44 secrets-key is generated
fresh every start and never written to disk: after a restart maintainers
re-send \`rig ci secret set\`; values already accepted survive.

Before each run the coordinator checks that a recorded payment channel (or,
before the first channel opens, the wallet's USDC) can cover the run's writes;
otherwise it says so on stderr and starts nothing, so a run is never
half-published (story 15).

Stop with Ctrl-C (SIGINT) or SIGTERM: active runs conclude \`cancelled\`.`;

export interface ServeFlags {
  relay: string;
  repos: CoordinatorRepo[];
  /** Operator-accepted requester pubkeys (lowercase hex). */
  requesters: string[];
  concurrency: number;
  timeoutMs: number;
  /** `--gateway` as given; absent → RIG_ARWEAVE_GATEWAY, else the preferred one. */
  gateway?: string;
  actBin?: string;
  platforms?: Record<string, string>;
  /**
   * `--pull` / `--no-pull`. Absent → act's own default (force-pull), which is
   * what an image pulled from a registry wants; `false` is what a runner image
   * built or loaded on this host needs (#175).
   */
  pull?: boolean;
  workdir?: string;
  /** Stop after the first run concludes. */
  once: boolean;
  json: boolean;
}

class ServeUsageError extends Error {}

/**
 * act spells the pull policy `--pull=false`, and so does the issue this flag
 * came from (#175); node's `parseArgs` would reject that on a boolean option
 * with "does not take an argument". Rewrite act's spelling to ours, and say
 * what to type for anything else attached to `--pull`.
 */
function pullSpelling(arg: string): string {
  if (!arg.startsWith('--pull=')) return arg;
  const value = arg.slice('--pull='.length);
  if (value === 'false') return '--no-pull';
  if (value === 'true') return '--pull';
  throw new ServeUsageError(
    `--pull takes no value — use --pull or --no-pull, got ${JSON.stringify(arg)}`
  );
}

export function parseServeArgs(args: string[]): ServeFlags | 'help' {
  const { values } = parseArgs({
    args: args.map(pullSpelling),
    options: {
      relay: { type: 'string' },
      repo: { type: 'string', multiple: true },
      requester: { type: 'string', multiple: true },
      concurrency: { type: 'string' },
      timeout: { type: 'string' },
      gateway: { type: 'string' },
      'act-bin': { type: 'string' },
      platform: { type: 'string', multiple: true },
      pull: { type: 'boolean' },
      'no-pull': { type: 'boolean' },
      workdir: { type: 'string' },
      once: { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      standalone: { type: 'boolean', default: false },
      'no-daemon': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: false,
    strict: true,
  });
  if (values.help) return 'help';
  if (!values.relay) throw new ServeUsageError('--relay <ws-url> is required');
  // A long-lived subscription needs a WebSocket relay URL (the http(s) relay
  // spellings other rig commands accept only work for paid publishes).
  if (!WS_URL_RE.test(values.relay)) {
    throw new ServeUsageError(
      `--relay must be a ws:// or wss:// URL, got ${JSON.stringify(values.relay)}`
    );
  }

  const repos: CoordinatorRepo[] = [];
  for (const spec of values.repo ?? []) {
    const slash = spec.indexOf('/');
    if (slash <= 0 || slash === spec.length - 1) {
      throw new ServeUsageError(
        `--repo expects <owner>/<repo-id>, got ${JSON.stringify(spec)}`
      );
    }
    let ownerPubkey: string;
    try {
      ownerPubkey = ownerToHex(spec.slice(0, slash));
    } catch (err) {
      throw new ServeUsageError(
        `--repo ${JSON.stringify(spec)}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    repos.push({ ownerPubkey, repoId: spec.slice(slash + 1) });
  }
  if (repos.length === 0)
    throw new ServeUsageError(
      'at least one --repo <owner>/<repo-id> is required'
    );

  const requesters: string[] = [];
  for (const spec of values.requester ?? []) {
    try {
      requesters.push(ownerToHex(spec));
    } catch (err) {
      throw new ServeUsageError(
        `--requester ${JSON.stringify(spec)}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  const positiveInt = (
    flag: string,
    raw: string | undefined,
    fallback: number
  ): number => {
    if (raw === undefined) return fallback;
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0)
      throw new ServeUsageError(`${flag} expects a positive integer`);
    return n;
  };
  const concurrency = positiveInt(
    '--concurrency',
    values.concurrency,
    DEFAULT_CONCURRENCY
  );
  const timeoutMs =
    positiveInt('--timeout', values.timeout, DEFAULT_RUN_TIMEOUT_MS / 1000) *
    1000;

  let platforms: Record<string, string> | undefined;
  if (values.platform && values.platform.length > 0) {
    platforms = {};
    for (const spec of values.platform) {
      const eq = spec.indexOf('=');
      if (eq <= 0 || eq === spec.length - 1) {
        throw new ServeUsageError(
          `--platform expects <label>=<image>, got ${JSON.stringify(spec)}`
        );
      }
      platforms[spec.slice(0, eq)] = spec.slice(eq + 1);
    }
  }

  // The pull policy is a tri-state: neither flag leaves act's own default in
  // place, so `rig ci serve` never has to restate it.
  if (values.pull && values['no-pull']) {
    throw new ServeUsageError('--pull and --no-pull cannot both be given');
  }
  const pull = values.pull ? true : values['no-pull'] ? false : undefined;

  return {
    relay: values.relay,
    repos,
    requesters,
    concurrency,
    timeoutMs,
    ...(values.gateway !== undefined ? { gateway: values.gateway } : {}),
    ...(values['act-bin'] !== undefined ? { actBin: values['act-bin'] } : {}),
    ...(platforms ? { platforms } : {}),
    ...(pull !== undefined ? { pull } : {}),
    ...(values.workdir !== undefined ? { workdir: values.workdir } : {}),
    once: values.once,
    json: values.json,
  };
}

/**
 * The ActRunner options the runner-shaped flags describe. A flag the operator
 * did not give leaves no key behind, so ActRunner's own defaults (act on PATH,
 * the community ubuntu image, act's force-pull) stand.
 */
export function actRunnerOptions(
  flags: Pick<ServeFlags, 'actBin' | 'platforms' | 'pull'>
): ActRunnerOptions {
  return {
    ...(flags.actBin !== undefined ? { actBin: flags.actBin } : {}),
    ...(flags.platforms ? { platforms: flags.platforms } : {}),
    ...(flags.pull !== undefined ? { pull: flags.pull } : {}),
  };
}

// ---------------------------------------------------------------------------
// Affordability (story 15)
// ---------------------------------------------------------------------------

/** What one run is estimated to cost, in the smallest asset unit. */
export function estimateRunCost(estimate: RunCostEstimate): bigint {
  // Logs and artifacts are metered per KiB on the store route; 64 KiB is a
  // generous per-upload envelope for a log tail's full file.
  return (
    BigInt(estimate.events) * estimate.rates.eventFee +
    BigInt(estimate.uploads) * uploadChargeFor(estimate.rates, 64 * 1024)
  );
}

/**
 * The coordinator's wallet check: a run is affordable when a recorded, still
 * open payment channel of THIS identity has `deposited − claimed ≥ cost`, or —
 * before any channel is recorded (the first paid write opens one lazily
 * from the wallet) — when the wallet holds that much USDC on some chain. An
 * unreadable wallet is NOT affordable: the coordinator must never start a
 * run it may not be able to finish publishing.
 */
export function makeAffordabilityCheck(args: {
  ctx: StandaloneContext;
  env: NodeJS.ProcessEnv;
  log: (line: string) => void;
}): CanAfford {
  const { ctx, env, log } = args;
  return async (estimate) => {
    const cost = estimateRunCost(estimate);
    const store = new ChannelMapStore(resolveChannelPaths(env));
    const mine = store
      .list()
      .filter(
        (record) =>
          record.identity.toLowerCase() === ctx.ownerPubkey.toLowerCase() &&
          record.supersededAt === undefined
      );
    if (mine.length > 0) {
      let best = 0n;
      for (const record of mine) {
        const watermark = store.readWatermark(record.channelId);
        if (channelStatus(watermark) !== 'open') continue;
        if (record.depositTotal === undefined) continue;
        const remaining =
          BigInt(record.depositTotal) -
          BigInt(watermark?.cumulativeAmount ?? '0');
        if (remaining > best) best = remaining;
      }
      if (best >= cost) return true;
      log(
        `[ci] wallet check: the best open channel has ${best} available, the run needs ~${cost} — ` +
          'fund this coordinator (rig fund / rig channel open --deposit) to resume'
      );
      return false;
    }
    if (!ctx.money) {
      log(
        '[ci] wallet check: no channel recorded and no wallet reader — refusing'
      );
      return false;
    }
    let chains;
    try {
      chains = await ctx.money.walletChainBalances();
    } catch (err) {
      log(
        `[ci] wallet check: wallet unreadable (${err instanceof Error ? err.message : String(err)}) — refusing`
      );
      return false;
    }
    let best = 0n;
    for (const chain of chains) {
      if (chain.unreadable) continue;
      for (const token of chain.tokens) {
        if (token.symbol !== undefined && !/usdc/i.test(token.symbol)) continue;
        const amount = BigInt(token.amount);
        if (amount > best) best = amount;
      }
    }
    if (best >= cost) return true;
    log(
      `[ci] wallet check: no channel recorded yet and the wallet holds ${best} USDC base units, the run needs ~${cost} — ` +
        'fund this coordinator (rig fund) to resume'
    );
    return false;
  };
}

/**
 * Resolve on SIGINT/SIGTERM, when `signal` aborts, or — under `--once` —
 * when `firstRun` settles, whichever first. The value says why.
 */
function untilStopRequested(
  signal: AbortSignal | undefined,
  firstRun?: Promise<ConcludedRun>
): Promise<string | ConcludedRun> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (reason: string | ConcludedRun): void => {
      if (settled) return;
      settled = true;
      process.off('SIGINT', onSigint);
      process.off('SIGTERM', onSigterm);
      resolve(reason);
    };
    const onSigint = (): void => finish('SIGINT');
    const onSigterm = (): void => finish('SIGTERM');
    if (signal?.aborted) return finish('abort');
    signal?.addEventListener('abort', () => finish('abort'), { once: true });
    process.once('SIGINT', onSigint);
    process.once('SIGTERM', onSigterm);
    void firstRun?.then(finish);
  });
}

export async function runCiServe(
  args: string[],
  deps: CiDeps
): Promise<number> {
  // Always embedded: the coordinator signs and pays as itself.
  const forced = withForcedStandalone(deps);
  const { io } = forced;

  let flags: ServeFlags;
  try {
    const parsed = parseServeArgs(args);
    if (parsed === 'help') {
      io.out(CI_SERVE_USAGE);
      return 0;
    }
    flags = parsed;
  } catch (err) {
    io.err(err instanceof Error ? err.message : String(err));
    io.err(CI_SERVE_USAGE);
    return 2;
  }

  // The gateway that serves the store's raw bytes — `--gateway`, else
  // RIG_ARWEAVE_GATEWAY (the variable `rig push` and `rig site` honour), else
  // rig's preferred public gateway. It is where log/artifact links point AND
  // the first place the coordinator reads objects from, on the store's
  // raw-bytes route `<gateway>/raw/<txId>`, ahead of the shared public list:
  // a private or local gateway (the sandbox's answers only on /raw/) is
  // otherwise unreachable on the read path, and a public one serves the same
  // bytes there as at `/<txId>`.
  const gateway = (
    flags.gateway ??
    forced.env['RIG_ARWEAVE_GATEWAY'] ??
    PREFERRED_GATEWAY
  ).replace(/\/+$/, '');
  const readGateways = [`${gateway}/raw`, ...ARWEAVE_GATEWAYS];

  // Runner first: a missing act binary must fail BEFORE the identity is
  // loaded or anything is paid.
  let runner: Runner;
  if (forced.runner) {
    runner = forced.runner;
  } else {
    const act = new ActRunner(actRunnerOptions(flags));
    if (act.binary(forced.env) === null) {
      io.err(
        'rig ci serve: the act executable was not found — install nektos/act ' +
          '(https://github.com/nektos/act) on this host, or point --act-bin / RIG_ACT_BIN at it. ' +
          'Nothing was started or paid.'
      );
      return 1;
    }
    runner = act;
  }

  let ctx: StandaloneContext | undefined;
  let handle: CoordinatorHandle | undefined;
  try {
    const session = await loadPaidSession(forced, flags.relay);
    if (session.path !== 'standalone') {
      throw new Error('rig ci serve requires the standalone paid path');
    }
    ctx = session.ctx;
    const identity = identityReport(ctx);
    const coordinator = ctx.ownerPubkey.toLowerCase();
    const stateDir =
      forced.stateDir ?? defaultCoordinatorStateDir(forced.env, coordinator);
    const workdir = flags.workdir ?? join(stateDir, 'work');
    const version = rigVersion();

    // --once: the first concluded run ends the session (see the header).
    let concludeFirstRun: (run: ConcludedRun) => void = () => undefined;
    const firstRun = flags.once
      ? new Promise<ConcludedRun>((resolve) => {
          concludeFirstRun = resolve;
        })
      : undefined;

    handle = await startCoordinator({
      coordinatorPubkey: coordinator,
      publisher: ctx.publisher,
      relayUrl: flags.relay,
      gatewayUrl: gateway,
      gateways: readGateways,
      repos: flags.repos,
      runner,
      stateDir,
      workdir,
      version,
      concurrency: flags.concurrency,
      timeoutMs: flags.timeoutMs,
      acceptedRequesters: flags.requesters,
      canAfford:
        forced.canAfford ??
        makeAffordabilityCheck({
          ctx,
          env: forced.env,
          log: (line) => io.err(line),
        }),
      ...(forced.webSocketFactory
        ? { webSocketFactory: forced.webSocketFactory }
        : {}),
      ...(forced.fetchFn ? { fetchFn: forced.fetchFn } : {}),
      ...(forced.resolveSha ? { resolveSha: forced.resolveSha } : {}),
      ...(forced.clock ? { clock: forced.clock } : {}),
      ...(firstRun
        ? { onRunConcluded: (run: ConcludedRun) => concludeFirstRun(run) }
        : {}),
      log: (line) => io.err(line),
    });

    const npub = hexToNpub(coordinator);
    const repoLabels = flags.repos.map(
      (r) => `${hexToNpub(r.ownerPubkey)}/${r.repoId}`
    );
    if (flags.json) {
      io.emitJson({
        command: 'ci serve',
        path: 'standalone',
        identity,
        coordinator,
        coordinatorNpub: npub,
        relay: flags.relay,
        gateway,
        repos: flags.repos,
        requesters: flags.requesters,
        runner: { family: runner.family, selectors: runner.selectors },
        concurrency: flags.concurrency,
        timeoutSeconds: flags.timeoutMs / 1000,
        once: flags.once,
        stateDir,
        workdir,
        secretsKey: handle.secretsKeyPubkey,
        advertisementId: handle.advertisementId,
        version,
      });
    } else {
      io.out(renderIdentityLine(identity));
      io.out(`Coordinator: ${npub}`);
      io.out(`Relay:       ${flags.relay}`);
      io.out(`Serving:     ${repoLabels.join(', ')}`);
      if (flags.requesters.length > 0)
        io.out(
          `Requesters:  maintainers + ${flags.requesters.map(hexToNpub).join(', ')}`
        );
      io.out(
        `Runner:      ${runner.family} (${runner.selectors.join(', ')}); concurrency ${flags.concurrency}, timeout ${flags.timeoutMs / 1000}s`
      );
      io.out(`State:       ${stateDir}`);
      io.out('Maintainers authorize this coordinator with:');
      io.out(`  rig ci request ${npub}`);
      io.out(
        flags.once
          ? 'Listening for one run — stops after it concludes (or Ctrl-C).'
          : 'Listening — press Ctrl-C to stop.'
      );
    }

    const reason = await untilStopRequested(forced.signal, firstRun);
    io.err(
      typeof reason === 'string'
        ? `rig ci serve: ${reason} — stopping (active runs conclude cancelled)`
        : `rig ci serve: run ${reason.runId.slice(0, 8)} concluded ${reason.conclusion} ` +
            `(result ${reason.resultEventId.slice(0, 8)}) — --once, stopping`
    );
    await handle.stop();
    handle = undefined;
    return 0;
  } catch (err) {
    if (handle) await handle.stop().catch(() => undefined);
    return emitCliError(io, flags.json, 'ci serve', err);
  } finally {
    if (ctx) {
      try {
        await ctx.stop();
      } catch {
        // best-effort teardown
      }
    }
  }
}
