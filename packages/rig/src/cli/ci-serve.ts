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
 * Everything the coordinator says goes to stderr; under `--json` stdout
 * carries exactly ONE document, emitted at start, describing what is being
 * served.
 *
 * Loaded lazily from ./ci.ts so one-shot `rig ci` verbs never pay for the
 * coordinator's imports.
 */

import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { ActRunner, DEFAULT_ACT_PLATFORMS } from '../ci/act-runner.js';
import {
  DEFAULT_RUN_TIMEOUT_MS,
  startCoordinator,
  type CoordinatorHandle,
  type CoordinatorRepo,
} from '../ci/coordinator.js';
import type { Runner } from '../ci/runner.js';
import { defaultCoordinatorStateDir } from '../ci/state.js';
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
  --concurrency <n>      runs executed at once (default 1); more queue
  --timeout <seconds>    wall-clock budget per run → timed_out (default 1800)
  --gateway <url>        gateway that serves the store's raw bytes, for log +
                         artifact links (default: ${PREFERRED_GATEWAY})
  --act-bin <path>       the act executable (default: RIG_ACT_BIN, else PATH)
  --platform <label=img> runs-on label → Docker image; repeatable
                         (default: ubuntu-latest=${DEFAULT_ACT_PLATFORMS['ubuntu-latest']})
  --workdir <dir>        where commits are checked out for runs (default:
                         <state-dir>/work)
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

Stop with Ctrl-C (SIGINT) or SIGTERM: active runs conclude \`cancelled\`.`;

interface ServeFlags {
  relay: string;
  repos: CoordinatorRepo[];
  concurrency: number;
  timeoutMs: number;
  gateway: string;
  actBin?: string;
  platforms?: Record<string, string>;
  workdir?: string;
  json: boolean;
}

class ServeUsageError extends Error {}

function parseServeArgs(args: string[]): ServeFlags | 'help' {
  const { values } = parseArgs({
    args,
    options: {
      relay: { type: 'string' },
      repo: { type: 'string', multiple: true },
      concurrency: { type: 'string' },
      timeout: { type: 'string' },
      gateway: { type: 'string' },
      'act-bin': { type: 'string' },
      platform: { type: 'string', multiple: true },
      workdir: { type: 'string' },
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
  const concurrency = positiveInt('--concurrency', values.concurrency, 1);
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

  return {
    relay: values.relay,
    repos,
    concurrency,
    timeoutMs,
    gateway: values.gateway ?? PREFERRED_GATEWAY,
    ...(values['act-bin'] !== undefined ? { actBin: values['act-bin'] } : {}),
    ...(platforms ? { platforms } : {}),
    ...(values.workdir !== undefined ? { workdir: values.workdir } : {}),
    json: values.json,
  };
}

/** Resolve on SIGINT/SIGTERM or when `signal` aborts, whichever first. */
function untilStopRequested(signal: AbortSignal | undefined): Promise<string> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (reason: string): void => {
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

  // Runner first: a missing act binary must fail BEFORE the identity is
  // loaded or anything is paid.
  let runner: Runner;
  if (forced.runner) {
    runner = forced.runner;
  } else {
    const act = new ActRunner({
      ...(flags.actBin !== undefined ? { actBin: flags.actBin } : {}),
      ...(flags.platforms ? { platforms: flags.platforms } : {}),
    });
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

    handle = await startCoordinator({
      coordinatorPubkey: coordinator,
      publisher: ctx.publisher,
      relayUrl: flags.relay,
      gatewayUrl: flags.gateway,
      repos: flags.repos,
      runner,
      stateDir,
      workdir,
      version,
      concurrency: flags.concurrency,
      timeoutMs: flags.timeoutMs,
      ...(forced.webSocketFactory
        ? { webSocketFactory: forced.webSocketFactory }
        : {}),
      ...(forced.fetchFn ? { fetchFn: forced.fetchFn } : {}),
      ...(forced.resolveSha ? { resolveSha: forced.resolveSha } : {}),
      ...(forced.clock ? { clock: forced.clock } : {}),
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
        gateway: flags.gateway,
        repos: flags.repos,
        runner: { family: runner.family, selectors: runner.selectors },
        concurrency: flags.concurrency,
        timeoutSeconds: flags.timeoutMs / 1000,
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
      io.out(
        `Runner:      ${runner.family} (${runner.selectors.join(', ')}); concurrency ${flags.concurrency}, timeout ${flags.timeoutMs / 1000}s`
      );
      io.out(`State:       ${stateDir}`);
      io.out('Maintainers authorize this coordinator with:');
      io.out(`  rig ci request ${npub}`);
      io.out('Listening — press Ctrl-C to stop.');
    }

    const reason = await untilStopRequested(forced.signal);
    io.err(
      `rig ci serve: ${reason} — stopping (active runs conclude cancelled)`
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
