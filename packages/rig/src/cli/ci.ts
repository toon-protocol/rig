/**
 * `rig ci` — the maintainer side of relay-native CI (#125).
 *
 * The relay is the ONLY control plane: every verb here that changes a
 * coordinator's behaviour is a signed, paid NIP-C1 event published from the
 * maintainer's own identity, and every observation is a free relay read.
 * There is no HTTP between maintainer and coordinator.
 *
 *   request <coordinator>   kind:9843 Service Request — a standing
 *                           authorization for one coordinator to run this
 *                           repo's workflows (paid)
 *   stop <coordinator>      kind:9844 Service Stop (paid)
 *   trigger <coordinator>   kind:9840 Manual Trigger — run one exact workflow
 *                           file (by content SHA-256) on one commit (paid)
 *   secret set|remove       kind:29846 Repository Secret Update — NIP-44 v2
 *                           encrypted to the coordinator's ADVERTISED
 *                           secrets-key with a fresh sender key; the relay
 *                           sees who sent it and where, never the names or
 *                           values (paid)
 *   status <commit>         every run + job for a commit, with NIP-C1 trust
 *                           levels; a one-command merge gate (free — see
 *                           ./ci-status.ts)
 *   serve                   the coordinator itself (./ci-serve.ts)
 *
 * The paid verbs mirror ./events.ts exactly — repo addressing from the
 * `toon.*` git config (`--repo-id`/`--owner` override), relay resolution via
 * `rig remote` (#249), the fee-quoting confirm gate (`--yes`; non-TTY
 * refuses; `--json` without `--yes` is a pure estimate), and the strict
 * `--json` contract (#265). They ALWAYS run embedded (standalone): the
 * toon-clientd daemon has no `/git/*` route for NIP-C1 kinds, so there is
 * nothing to delegate to.
 *
 * Coordinator identifiers accept npub or 64-char hex everywhere.
 */

import { parseArgs } from 'node:util';
import {
  buildCiManualTrigger,
  buildCiSecretUpdate,
  buildCiServiceRequest,
  buildCiServiceStop,
  CI_ADVERTISEMENT_KIND,
  parseCiAdvertisement,
  repoAddress,
  type CiAdvertisement,
} from '../ci/nip-c1-events.js';
import type { CanAfford } from '../ci/coordinator.js';
import type { Runner } from '../ci/runner.js';
import {
  encryptSecretUpdate,
  generateSecretsKey,
  MAX_SECRET_VALUE_BYTES,
  RESERVED_SECRET_NAMES,
  SECRET_NAME_RE,
  type SecretUpdatePlaintext,
} from '../ci/secrets.js';
import { sha256Hex } from '../ci/workflows.js';
import { runGit } from '../materialize.js';
import type { UnsignedEvent } from '../nip34-events.js';
import { ownerToHex } from '../npub.js';
import {
  defaultWebSocketFactory,
  queryRelay,
  type NostrEvent,
  type WebSocketFactory,
} from '../remote-state.js';
import {
  serializeEventReceipt,
  type GitEventResponse,
  type GitRepoAddr,
} from '../routes.js';
import { emitCliError, UnconfiguredRepoAddressError } from './errors.js';
import type { EventCommandDeps } from './events.js';
import {
  readToonConfig,
  resolveRepoRoot,
  type ToonRepoConfig,
} from './git-config.js';
import {
  identityReport,
  loadPaidSession,
  withForcedStandalone,
  type IdentityReport,
} from './push.js';
import { resolveRelays, singleRelayRefusal } from './remote.js';
import { feeLabel, renderEventPlan, renderEventReceipt } from './render.js';
import type { StandaloneContext } from './standalone-context.js';
import { CI_STATUS_USAGE, runCiStatus } from './ci-status.js';

// ---------------------------------------------------------------------------
// Deps
// ---------------------------------------------------------------------------

/**
 * The event-command deps (paid session, read seams, stdin) plus the
 * coordinator's injectable seams (`rig ci serve`): the Runner, a clock, the
 * state directory, and an abort signal. Tests inject all of them.
 */
export interface CiDeps extends EventCommandDeps {
  /** Runner implementation for `serve` (default: the act/Docker runner). */
  runner?: Runner;
  /** Unix-seconds clock (default: `Date.now()/1000`). */
  clock?: () => number;
  /** Coordinator state directory override (cursor + secret inventory). */
  stateDir?: string;
  /** Stops a running coordinator (default: SIGINT/SIGTERM). */
  signal?: AbortSignal;
  /**
   * Affordability seam for `serve` (default: the recorded-channel / wallet
   * check in ./ci-serve.ts). Tests inject a scripted answer.
   */
  canAfford?: CanAfford;
}

const defaultReadStdin = async (): Promise<string> => {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf-8');
};

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

const COMMON_FLAGS_USAGE = `  --repo-id <id>       repository id / NIP-34 d-tag (default: git config
                       toon.repoid — run \`rig init\` to set it)
  --owner <pubkey>     repository owner pubkey, npub or 64-char hex (default:
                       git config toon.owner, then the active identity)
  --remote <name>      publish via this configured git remote (default: the
                       "origin" remote — \`rig remote add origin <relay-url>\`)
  --relay <url>        ad-hoc relay override (exactly one) — bypasses the
                       configured remotes
  --yes                skip the fee confirmation (required when not a TTY)
  --json               machine-readable receipt; without --yes it is a pure
                       estimate (nothing published, exit 0)
  --standalone         accepted for symmetry with the other paid verbs; rig ci
                       always runs embedded (alias: --no-daemon)
  -h, --help           show this help`;

export const CI_REQUEST_USAGE = `Usage: rig ci request <coordinator> [options]

Publish a Service Request (kind:9843): a standing authorization for
<coordinator> (npub or hex) to run this repo's workflows — a paid publish;
writes are permanent and non-refundable. A coordinator serves a repo only
while a Request from the repo owner or a declared maintainer is in force
(until a Service Stop). Rig's coordinator, \`rig ci serve\`, is
request-required: it never runs a repo nobody asked it to.

Options:
${COMMON_FLAGS_USAGE}`;

export const CI_STOP_USAGE = `Usage: rig ci stop <coordinator> [options]

Publish a Service Stop (kind:9844) so <coordinator> stops running this
repo's workflows — a paid publish; writes are permanent and non-refundable.
A Stop from the owner or a declared maintainer closes every earlier Request
for the repo; a Stop from anyone else closes only their own Requests.

Options:
${COMMON_FLAGS_USAGE}`;

export const CI_TRIGGER_USAGE = `Usage: rig ci trigger <coordinator> --workflow <path> [--commit <sha>] [--ref <refs/…>] [options]

Publish a Manual Trigger (kind:9840): ask <coordinator> to run ONE exact
workflow file on ONE commit — a paid publish; writes are permanent and
non-refundable. The workflow is identified by its path AND its content
SHA-256 at that commit (read from the LOCAL repository with
\`git show <commit>:<path>\`), so the coordinator can prove which file ran.
Use it to re-run a push workflow, or to run one outside push/PR events; a
manual replay does not need a standing Service Request, but the author must
be the repo owner or a declared maintainer.

Options:
  --workflow <path>    workflow file path in the repo, e.g.
                       .github/workflows/ci.yml [required]
  --commit <sha>       commit to run (any local revision; default: HEAD)
  --ref <refname>      optional \`refs/heads/…\` context for workflows that
                       read it
${COMMON_FLAGS_USAGE}`;

export const CI_SECRET_USAGE = `Usage: rig ci secret set <coordinator> NAME[=value] [NAME=value …] [options]
       rig ci secret remove <coordinator> NAME [NAME …] [options]

Set or remove CI secrets for this repo on <coordinator> — a paid publish of
ONE Repository Secret Update (kind:29846); writes are permanent and
non-refundable. Values are NIP-44 v2 encrypted to the secrets-key the
coordinator advertises (kind:19843) with a FRESH sender key, so the relay
sees who sent the update and which repo/coordinator it addresses, but never
the names or values. The coordinator injects secrets only into runs the repo
owner or a declared maintainer caused (pushes, manual triggers) — never into
a stranger's pull request.

Values: \`NAME=value\` on the command line, or a bare \`NAME\` to read the
value from stdin (one bare name per invocation). Names must match
[A-Z_][A-Z0-9_]*; values are never echoed anywhere. Per NIP-C1 the update
is scoped to YOUR repository perspective (30617:<your-pubkey>:<repo-id>).

Options:
${COMMON_FLAGS_USAGE}`;

export const CI_USAGE = `Usage: rig ci <request|stop|trigger|secret|status|serve> …

Relay-native CI: the relay is the only control plane. A coordinator
(\`rig ci serve\`) watches repos on the relay, runs their GitHub-Actions-syntax
workflows with act on Docker, and publishes NIP-C1 progress and results as
paid writes from its own identity. Maintainers manage the relationship with
paid events from theirs, and everyone reads outcomes for free.

Paid (permanent, non-refundable):
  request <coordinator>                       authorize a coordinator (9843)
  stop <coordinator>                          revoke it (9844)
  trigger <coordinator> --workflow <path>     run one workflow on a commit (9840)
  secret set|remove <coordinator> NAME[=v]    encrypted CI secrets (29846)

Free:
  status <commit> [--json] [--require-ci-trust <level>]
                                              runs + jobs for a commit; exits
                                              non-zero unless every run is green

Coordinator:
  serve --relay <url> --repo <owner>/<id>     run a coordinator

Run \`rig ci <verb> --help\` for a verb's flags.`;

// ---------------------------------------------------------------------------
// Shared flag parsing (mirrors ./events.ts)
// ---------------------------------------------------------------------------

const HEX64_RE = /^[0-9a-f]{64}$/;

const COMMON_OPTIONS = {
  yes: { type: 'boolean', default: false },
  json: { type: 'boolean', default: false },
  relay: { type: 'string', multiple: true },
  remote: { type: 'string' },
  'repo-id': { type: 'string' },
  owner: { type: 'string' },
  standalone: { type: 'boolean', default: false },
  'no-daemon': { type: 'boolean', default: false },
  help: { type: 'boolean', short: 'h', default: false },
} as const;

interface CommonFlags {
  yes: boolean;
  json: boolean;
  relay: string[];
  remote?: string;
  repoId?: string;
  owner?: string;
  help: boolean;
}

function pickCommon(values: Record<string, unknown>): CommonFlags {
  const flags: CommonFlags = {
    yes: values['yes'] === true,
    json: values['json'] === true,
    relay: Array.isArray(values['relay']) ? (values['relay'] as string[]) : [],
    help: values['help'] === true,
  };
  if (typeof values['remote'] === 'string') flags.remote = values['remote'];
  if (typeof values['repo-id'] === 'string') flags.repoId = values['repo-id'];
  if (typeof values['owner'] === 'string')
    flags.owner = ownerToHex(values['owner']);
  return flags;
}

/** `<coordinator>` positional: npub or hex → lowercase hex. */
function parseCoordinator(positionals: string[]): string {
  const raw = positionals[0];
  if (raw === undefined)
    throw new Error('<coordinator> (npub or 64-char hex) is required');
  let hex: string;
  try {
    hex = ownerToHex(raw);
  } catch (err) {
    throw new Error(
      `<coordinator> must be an npub or a 64-char hex pubkey (got ${JSON.stringify(raw)}): ` +
        (err instanceof Error ? err.message : String(err))
    );
  }
  if (!HEX64_RE.test(hex)) {
    throw new Error(
      `<coordinator> must be an npub or a 64-char hex pubkey (got ${JSON.stringify(raw)})`
    );
  }
  return hex;
}

// ---------------------------------------------------------------------------
// Shared paid pipeline (estimate → confirm → publish; standalone only)
// ---------------------------------------------------------------------------

type CiCommand =
  | 'ci request'
  | 'ci stop'
  | 'ci trigger'
  | 'ci secret set'
  | 'ci secret remove';

/** What `buildEvent` can see: the resolved address, identity, and relay. */
interface BuildContext {
  addr: GitRepoAddr;
  identity: IdentityReport;
  relayUrl: string;
  webSocketFactory: WebSocketFactory;
  /** Unix seconds — the event's `created_at`. */
  createdAt: number;
}

interface RunCiEventOptions {
  command: CiCommand;
  flags: CommonFlags;
  deps: CiDeps;
  actionLabel: string;
  buildEvent: (ctx: BuildContext) => Promise<UnsignedEvent>;
  /** Extra fields for the JSON envelope (never secret values). */
  extra?: Record<string, unknown>;
}

interface CiEventJsonOutput {
  command: CiCommand;
  repoAddr: GitRepoAddr;
  coordinator: string;
  path: 'standalone';
  identity: IdentityReport;
  kind: number;
  executed: boolean;
  feeEstimate: string | null;
  result?: GitEventResponse;
  hint?: string;
  [extra: string]: unknown;
}

async function runCiEvent(
  opts: RunCiEventOptions & { coordinator: string }
): Promise<number> {
  const { command, flags, actionLabel, coordinator } = opts;
  // Always embedded: no daemon route exists for NIP-C1 kinds.
  const deps = withForcedStandalone(opts.deps);
  const { io } = deps;

  let standaloneCtx: StandaloneContext | undefined;
  try {
    let repoRoot: string | undefined;
    let toonConfig: ToonRepoConfig = { relays: [] };
    try {
      repoRoot = await resolveRepoRoot(deps.cwd);
      toonConfig = await readToonConfig(repoRoot);
    } catch {
      // Not inside a git repository — --repo-id/--owner must carry the address.
    }
    const repoId = flags.repoId ?? toonConfig.repoId;
    if (!repoId) throw new UnconfiguredRepoAddressError('repository id');

    const resolved = await resolveRelays({
      relayFlags: flags.relay,
      remoteName: flags.remote,
      repoRoot,
      toonRelays: toonConfig.relays,
    });
    if (resolved.nudge !== undefined) io.err(resolved.nudge);
    const relaysUsed = resolved.relays;
    if (relaysUsed.length > 1) {
      io.err(singleRelayRefusal(resolved, 'Nothing was published or paid.'));
      return 1;
    }
    const relayUrl = relaysUsed[0] as string;

    const session = await loadPaidSession(deps, relayUrl);
    if (session.path !== 'standalone') {
      // Unreachable with the forced override; guard the type.
      throw new Error('rig ci requires the standalone paid path');
    }
    standaloneCtx = session.ctx;
    const identity = identityReport(standaloneCtx);
    const fee = (
      await standaloneCtx.publisher.getFeeRates()
    ).eventFee.toString();

    const owner = flags.owner ?? toonConfig.owner ?? identity.pubkey;
    const addr: GitRepoAddr = { ownerPubkey: owner, repoId };
    const createdAt = (deps.clock ?? (() => Math.floor(Date.now() / 1000)))();

    const event = await opts.buildEvent({
      addr,
      identity,
      relayUrl,
      webSocketFactory: deps.webSocketFactory ?? defaultWebSocketFactory,
      createdAt,
    });
    const action = `kind:${event.kind} ${actionLabel}`;

    const base = {
      command,
      repoAddr: addr,
      coordinator,
      path: 'standalone' as const,
      identity,
      kind: event.kind,
      feeEstimate: fee,
      ...(opts.extra ?? {}),
    };

    if (!flags.json) {
      for (const line of renderEventPlan({ action, addr, identity, fee }))
        io.out(line);
      io.out(`Coordinator: ${coordinator}`);
    }
    if (!flags.yes) {
      if (flags.json) {
        io.emitJson({
          ...base,
          executed: false,
          hint: 'estimate only — re-run with --yes to publish (permanent, non-refundable)',
        } satisfies CiEventJsonOutput);
        return 0;
      }
      if (!io.isInteractive) {
        io.err(
          'refusing to spend channel funds without confirmation in a non-interactive ' +
            'session — re-run with --yes (or use --json for an estimate)'
        );
        return 1;
      }
      const proceed = await io.confirm(
        `Proceed with paid publish (${feeLabel(fee)})? [y/N] `
      );
      if (!proceed) {
        io.err('aborted — nothing was published.');
        return 1;
      }
    }

    const receipt = await standaloneCtx.publisher.publishEvent(
      event,
      relaysUsed
    );
    const result = serializeEventReceipt(event.kind, receipt);
    if (flags.json) {
      io.emitJson({
        ...base,
        executed: true,
        result,
      } satisfies CiEventJsonOutput);
    } else {
      for (const line of renderEventReceipt(action, result)) io.out(line);
    }
    return 0;
  } catch (err) {
    return emitCliError(io, flags.json, command, err);
  } finally {
    if (standaloneCtx) {
      try {
        await standaloneCtx.stop();
      } catch {
        // best-effort teardown
      }
    }
  }
}

// ---------------------------------------------------------------------------
// rig ci request / stop
// ---------------------------------------------------------------------------

async function runCiControl(
  kind: 'request' | 'stop',
  args: string[],
  deps: CiDeps
): Promise<number> {
  const { io } = deps;
  const usage = kind === 'request' ? CI_REQUEST_USAGE : CI_STOP_USAGE;
  let flags: CommonFlags;
  let coordinator: string;
  try {
    const { values, positionals } = parseArgs({
      args,
      options: COMMON_OPTIONS,
      allowPositionals: true,
    });
    flags = pickCommon(values);
    if (flags.help) {
      io.out(usage);
      return 0;
    }
    if (positionals.length > 1) {
      throw new Error(
        `expected exactly one <coordinator>, got ${positionals.length} positionals`
      );
    }
    coordinator = parseCoordinator(positionals);
  } catch (err) {
    io.err(err instanceof Error ? err.message : String(err));
    io.err(usage);
    return 2;
  }
  return runCiEvent({
    command: kind === 'request' ? 'ci request' : 'ci stop',
    flags,
    deps,
    coordinator,
    actionLabel: `CI service ${kind} → ${coordinator.slice(0, 8)}…`,
    buildEvent: async ({ addr, relayUrl, createdAt }) => {
      const a = repoAddress(addr.ownerPubkey, addr.repoId);
      return kind === 'request'
        ? buildCiServiceRequest(a, coordinator, relayUrl, createdAt)
        : buildCiServiceStop(a, coordinator, relayUrl, createdAt);
    },
  });
}

// ---------------------------------------------------------------------------
// rig ci trigger
// ---------------------------------------------------------------------------

const REF_RE = /^refs\/(heads|tags)\/[^\s]+$/;

async function runCiTrigger(args: string[], deps: CiDeps): Promise<number> {
  const { io } = deps;
  let flags: CommonFlags;
  let coordinator: string;
  let workflowPath: string;
  let commitArg: string;
  let ref: string | undefined;
  try {
    const { values, positionals } = parseArgs({
      args,
      options: {
        ...COMMON_OPTIONS,
        workflow: { type: 'string' },
        commit: { type: 'string' },
        ref: { type: 'string' },
      },
      allowPositionals: true,
    });
    flags = pickCommon(values);
    if (flags.help) {
      io.out(CI_TRIGGER_USAGE);
      return 0;
    }
    if (positionals.length > 1) {
      throw new Error(
        `expected exactly one <coordinator>, got ${positionals.length} positionals`
      );
    }
    coordinator = parseCoordinator(positionals);
    if (values.workflow === undefined || values.workflow === '') {
      throw new Error('--workflow <path> is required');
    }
    workflowPath = values.workflow.replace(/^\.\//, '');
    if (
      workflowPath.startsWith('/') ||
      workflowPath.split('/').includes('..')
    ) {
      throw new Error('--workflow must be a path relative to the repo root');
    }
    commitArg = values.commit ?? 'HEAD';
    ref = values.ref;
    if (ref !== undefined && !REF_RE.test(ref)) {
      throw new Error(
        `--ref must look like refs/heads/<name> or refs/tags/<name> (got ${JSON.stringify(ref)})`
      );
    }
  } catch (err) {
    io.err(err instanceof Error ? err.message : String(err));
    io.err(CI_TRIGGER_USAGE);
    return 2;
  }

  // The workflow's content hash comes from the LOCAL repository: resolve it
  // before anything is paid so a typo in --workflow/--commit costs nothing.
  let commit: string;
  let sha256: string;
  try {
    const repoRoot = await resolveRepoRoot(deps.cwd);
    commit = (
      await runGit(repoRoot, ['rev-parse', '--verify', `${commitArg}^{commit}`])
    ).trim();
    const content = await gitShowBytes(repoRoot, commit, workflowPath);
    sha256 = sha256Hex(content);
  } catch (err) {
    return emitCliError(io, flags.json, 'ci trigger', err);
  }

  return runCiEvent({
    command: 'ci trigger',
    flags,
    deps,
    coordinator,
    actionLabel: `manual trigger ${workflowPath} @ ${commit.slice(0, 8)} → ${coordinator.slice(0, 8)}…`,
    extra: {
      commit,
      workflow: { path: workflowPath, sha256 },
      ...(ref !== undefined ? { ref } : {}),
    },
    buildEvent: async ({ addr, createdAt }) =>
      buildCiManualTrigger(
        coordinator,
        {
          repoAddr: repoAddress(addr.ownerPubkey, addr.repoId),
          commit,
          workflow: { path: workflowPath, sha256 },
          ...(ref !== undefined ? { ref } : {}),
        },
        createdAt
      ),
  });
}

/** `git show <commit>:<path>` as raw bytes (binary-safe). */
async function gitShowBytes(
  repoRoot: string,
  commit: string,
  path: string
): Promise<Buffer> {
  const { execFile } = await import('node:child_process');
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['show', `${commit}:${path}`],
      { cwd: repoRoot, encoding: 'buffer', maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          reject(
            new Error(
              `cannot read ${path} at ${commit.slice(0, 12)} from the local repository: ` +
                `${stderr.toString('utf-8').trim() || err.message}`
            )
          );
          return;
        }
        resolve(stdout);
      }
    );
  });
}

// ---------------------------------------------------------------------------
// rig ci secret set | remove
// ---------------------------------------------------------------------------

function assertSecretName(name: string): void {
  if (!SECRET_NAME_RE.test(name)) {
    throw new Error(
      `invalid secret name ${JSON.stringify(name)} — must match [A-Z_][A-Z0-9_]*`
    );
  }
  if (RESERVED_SECRET_NAMES.includes(name)) {
    throw new Error(
      `secret name ${name} is reserved by NIP-C1 and cannot be set`
    );
  }
}

/** NIP-C1 value limits, checked before any relay or wallet is touched — never echoes the value. */
function assertSecretValue(name: string, value: string): void {
  if (value === '') throw new Error(`secret ${name} has an empty value`);
  if (Buffer.byteLength(value, 'utf-8') > MAX_SECRET_VALUE_BYTES) {
    throw new Error(
      `secret ${name} value exceeds ${MAX_SECRET_VALUE_BYTES} bytes`
    );
  }
}

async function runCiSecret(args: string[], deps: CiDeps): Promise<number> {
  const { io } = deps;
  const [sub, ...rest] = args;
  if (sub === '--help' || sub === '-h' || sub === 'help' || sub === undefined) {
    if (sub === undefined) {
      io.err('missing subcommand: rig ci secret <set|remove>');
      io.err(CI_SECRET_USAGE);
      return 2;
    }
    io.out(CI_SECRET_USAGE);
    return 0;
  }
  if (sub !== 'set' && sub !== 'remove') {
    io.err(`unknown rig ci secret subcommand: ${sub}`);
    io.err(CI_SECRET_USAGE);
    return 2;
  }

  let flags: CommonFlags;
  let coordinator: string;
  const set: Record<string, string> = {};
  const remove: string[] = [];
  let stdinName: string | undefined;
  try {
    const { values, positionals } = parseArgs({
      args: rest,
      options: COMMON_OPTIONS,
      allowPositionals: true,
    });
    flags = pickCommon(values);
    if (flags.help) {
      io.out(CI_SECRET_USAGE);
      return 0;
    }
    coordinator = parseCoordinator(positionals);
    const entries = positionals.slice(1);
    if (entries.length === 0) {
      throw new Error(
        sub === 'set'
          ? 'at least one NAME[=value] is required'
          : 'at least one NAME is required'
      );
    }
    const seen = new Set<string>();
    for (const entry of entries) {
      const eq = entry.indexOf('=');
      const name = eq === -1 ? entry : entry.slice(0, eq);
      assertSecretName(name);
      if (seen.has(name))
        throw new Error(`secret name ${name} given more than once`);
      seen.add(name);
      if (sub === 'remove') {
        if (eq !== -1)
          throw new Error(
            `rig ci secret remove takes bare names (got ${JSON.stringify(entry)})`
          );
        remove.push(name);
      } else if (eq === -1) {
        if (stdinName !== undefined) {
          throw new Error(
            'only one bare NAME can read its value from stdin per invocation'
          );
        }
        stdinName = name;
      } else {
        const value = entry.slice(eq + 1);
        assertSecretValue(name, value);
        set[name] = value;
      }
    }
  } catch (err) {
    io.err(err instanceof Error ? err.message : String(err));
    io.err(CI_SECRET_USAGE);
    return 2;
  }

  if (stdinName !== undefined) {
    const value = io.isInteractive
      ? ''
      : await (deps.readStdin ?? defaultReadStdin)();
    // Trailing newline from `echo`/heredocs is never part of a secret.
    const trimmed = value.replace(/\r?\n$/, '');
    if (trimmed === '') {
      io.err(
        `secret ${stdinName}: no value on stdin (pipe the value, or pass ${stdinName}=<value>)`
      );
      return 2;
    }
    try {
      assertSecretValue(stdinName, trimmed);
    } catch (err) {
      io.err(err instanceof Error ? err.message : String(err));
      return 2;
    }
    set[stdinName] = trimmed;
  }

  const names = [...Object.keys(set), ...remove];
  return runCiEvent({
    command: sub === 'set' ? 'ci secret set' : 'ci secret remove',
    flags,
    deps,
    coordinator,
    actionLabel: `secret ${sub} ${names.join(', ')} → ${coordinator.slice(0, 8)}…`,
    extra: { names, operation: sub },
    buildEvent: async ({
      addr,
      identity,
      relayUrl,
      webSocketFactory,
      createdAt,
    }) => {
      const advertisement = await fetchLiveAdvertisement(
        relayUrl,
        coordinator,
        webSocketFactory,
        createdAt
      );
      if (!advertisement.secretsKey) {
        throw new Error(
          `coordinator ${coordinator.slice(0, 12)}… advertises no secrets-key — it is not accepting secret updates`
        );
      }
      // NIP-C1: the plaintext binds to the signer + timestamp; the `a` tag's
      // pubkey MUST equal the signer, so the update is scoped to the
      // maintainer's OWN repository perspective.
      const plain: SecretUpdatePlaintext = {
        author: identity.pubkey,
        created_at: createdAt,
        set,
        remove,
      };
      const sender = generateSecretsKey();
      const ciphertext = encryptSecretUpdate(
        plain,
        sender.secretKey,
        advertisement.secretsKey.pubkey
      );
      sender.secretKey.fill(0);
      return buildCiSecretUpdate({
        repoAddr: repoAddress(identity.pubkey, addr.repoId),
        coordinatorPubkey: coordinator,
        advertisementId: advertisement.eventId,
        advertisementRelayHint: relayUrl,
        senderPubkey: sender.pubkey,
        recipientPubkey: advertisement.secretsKey.pubkey,
        ciphertext,
        createdAt,
      });
    },
  });
}

/**
 * The coordinator's CURRENT kind:19843 (latest by created_at, ties → lowest
 * id) — unexpired as of `now`. Throws with a clear remedy when absent.
 */
async function fetchLiveAdvertisement(
  relayUrl: string,
  coordinator: string,
  webSocketFactory: WebSocketFactory,
  now: number
): Promise<CiAdvertisement> {
  const events = await queryRelay(
    relayUrl,
    { kinds: [CI_ADVERTISEMENT_KIND], authors: [coordinator] },
    10_000,
    webSocketFactory
  );
  let latest: NostrEvent | null = null;
  for (const ev of events) {
    if (ev.pubkey.toLowerCase() !== coordinator) continue;
    if (
      latest === null ||
      ev.created_at > latest.created_at ||
      (ev.created_at === latest.created_at && ev.id < latest.id)
    ) {
      latest = ev;
    }
  }
  const parsed = latest ? parseCiAdvertisement(latest) : null;
  if (!parsed) {
    throw new Error(
      `no Coordinator Advertisement (kind:19843) from ${coordinator.slice(0, 12)}… on ${relayUrl} — ` +
        'is the coordinator running (`rig ci serve`)?'
    );
  }
  if (parsed.expiresAt <= now) {
    throw new Error(
      `the Coordinator Advertisement from ${coordinator.slice(0, 12)}… expired at ${parsed.expiresAt} — ` +
        'the coordinator is not live; secrets cannot be delivered'
    );
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/** Run `rig ci …`; returns the process exit code. */
export async function runCi(args: string[], deps: CiDeps): Promise<number> {
  const { io } = deps;
  const [sub, ...rest] = args;
  switch (sub) {
    case 'request':
      return runCiControl('request', rest, deps);
    case 'stop':
      return runCiControl('stop', rest, deps);
    case 'trigger':
      return runCiTrigger(rest, deps);
    case 'secret':
      return runCiSecret(rest, deps);
    case 'status':
      return runCiStatus(rest, deps);
    case 'serve':
      return (await import('./ci-serve.js')).runCiServe(rest, deps);
    case '--help':
    case '-h':
    case 'help':
      io.out(CI_USAGE);
      io.out('');
      io.out(CI_STATUS_USAGE);
      return 0;
    default:
      io.err(
        sub === undefined
          ? 'missing subcommand: rig ci <request|stop|trigger|secret|status|serve>'
          : `unknown rig ci subcommand: ${sub}`
      );
      io.err(CI_USAGE);
      return 2;
  }
}
