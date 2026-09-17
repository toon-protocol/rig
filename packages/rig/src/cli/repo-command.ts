/**
 * Shared scaffolding for the rig-owned commands that read or republish a
 * repo's kind:30617 announcement (`rig maintainers`, `rig payout`,
 * `rig refresh`): the common flag set
 * (`--repo-id/--owner/--remote/--relay/--yes/--json`), the resolution of the
 * repo address + relays from those flags plus the repo's `toon.*` git config,
 * and the whole prologue a PAID republish must clear before it may spend
 * anything ({@link openAnnouncementRepublish}).
 *
 * These commands are deliberately identical at the edges — same flags, same
 * repo-address resolution, same relay rules, same owner-only and
 * unannounced-repo refusals — and differ only in WHICH tag of the
 * announcement they touch. Keeping the edges in one place is what makes that
 * sameness real rather than aspirational: a money-safety refusal fixed here is
 * fixed for every one of them, instead of in whichever copy someone
 * remembered.
 */

import { ownerToHex } from '../npub.js';
import {
  earliestUniqueCommit,
  type ConformanceFacts,
} from '../repo-announcement.js';
import { GitRepoReader } from '../repo-reader.js';
import { repoWebUrl } from '../rig-pointer.js';
import { fetchRemoteState, type RemoteState } from '../remote-state.js';
import type { EventCommandDeps } from './events.js';
import { InvalidRelayUrlError, UnconfiguredRepoAddressError } from './errors.js';
import { readToonConfig, resolveRepoRoot } from './git-config.js';
import {
  defaultLoadStandalone,
  identityReport,
  type IdentityReport,
} from './push.js';
import {
  resolveRelays,
  singleRelayRefusal,
  type ResolvedRelays,
} from './remote.js';
import type { StandaloneContext } from './standalone-context.js';

/** Relay URLs rig can actually talk to (reads and paid publishes alike). */
export const WS_URL_RE = /^wss?:\/\//i;

/** The flags every kind:30617 command accepts. */
export interface RepoCommandFlags {
  json: boolean;
  yes: boolean;
  help: boolean;
  relay: string[];
  remote?: string;
  repoId?: string;
  owner?: string;
}

/** `parseArgs` option spec matching {@link RepoCommandFlags}. */
export const REPO_COMMAND_OPTIONS = {
  json: { type: 'boolean', default: false },
  yes: { type: 'boolean', default: false },
  relay: { type: 'string', multiple: true },
  remote: { type: 'string' },
  'repo-id': { type: 'string' },
  owner: { type: 'string' },
  help: { type: 'boolean', short: 'h', default: false },
} as const;

/** Narrow `parseArgs` values into {@link RepoCommandFlags} (`--owner` → hex). */
export function pickRepoCommandFlags(
  values: Record<string, unknown>
): RepoCommandFlags {
  const flags: RepoCommandFlags = {
    json: values['json'] === true,
    yes: values['yes'] === true,
    help: values['help'] === true,
    relay: Array.isArray(values['relay']) ? (values['relay'] as string[]) : [],
  };
  if (typeof values['remote'] === 'string') flags.remote = values['remote'];
  if (typeof values['repo-id'] === 'string') flags.repoId = values['repo-id'];
  if (typeof values['owner'] === 'string')
    flags.owner = ownerToHex(values['owner']);
  return flags;
}

export interface RepoContext {
  repoId: string;
  owner: string;
  relays: string[];
  /** The full relay resolution (source/nudge) — for the single-relay refusal. */
  resolved: ResolvedRelays;
  repoRoot?: string;
}

/** Resolve repo address (repoId + owner) and relays from flags + git config. */
export async function resolveRepoContext(
  flags: RepoCommandFlags,
  deps: EventCommandDeps
): Promise<RepoContext> {
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

  const resolved = await resolveRelays({
    relayFlags: flags.relay,
    remoteName: flags.remote,
    repoRoot,
    toonRelays: toonConfig.relays,
  });
  if (resolved.nudge !== undefined) deps.io.err(resolved.nudge);
  return {
    repoId,
    owner,
    relays: resolved.relays,
    resolved,
    ...(repoRoot !== undefined ? { repoRoot } : {}),
  };
}

// ---------------------------------------------------------------------------
// Conformance tags (#158)
// ---------------------------------------------------------------------------

/**
 * The NIP-34 conformance facts (#158) for an owner-initiated republish:
 * the relay this publish goes to, the repo's rig-web viewer URL, and the
 * `euc` computed from the LOCAL repository.
 *
 * Every owner-initiated republish backfills these, so a repo announced before
 * #158 becomes conformant on the next `rig maintainers`, `rig payout` or
 * `rig refresh` with no special step. A command run OUTSIDE a git repo (all of
 * them accept `--repo-id`/`--owner`) still backfills `relays` and `web`; the
 * `euc` needs local history, and reporting none is honest — the announcement
 * keeps whatever it already declares.
 */
export async function conformanceFactsFor(options: {
  ctx: RepoContext;
  relayUrl: string;
  deps: EventCommandDeps;
}): Promise<ConformanceFacts> {
  const { ctx, relayUrl, deps } = options;
  const repoRoot = ctx.repoRoot;
  const rootCommits =
    deps.rootCommits ??
    (repoRoot === undefined
      ? undefined
      : (rev?: string) => new GitRepoReader(repoRoot).rootCommits(rev));
  let euc: string | null = null;
  if (rootCommits !== undefined) {
    try {
      euc = await earliestUniqueCommit({ rootCommits });
    } catch {
      // An unreadable local repo is no reason to refuse an announcement edit.
      euc = null;
    }
  }
  let web: string | null = null;
  try {
    web = repoWebUrl({
      env: deps.env,
      relay: relayUrl,
      ownerPubkey: ctx.owner,
      repoId: ctx.repoId,
    });
  } catch {
    // An owner pubkey that will not encode to an npub means no viewer URL —
    // never a reason to refuse the announcement edit the user actually asked
    // for, the same rule the euc lookup follows above.
    web = null;
  }
  return { relays: [relayUrl], web, earliestUniqueCommit: euc };
}

// ---------------------------------------------------------------------------
// The paid-republish prologue
// ---------------------------------------------------------------------------

/** A paid kind:30617 republish that has cleared every refusal and may proceed. */
export interface OpenedRepublish {
  ok: true;
  ctx: RepoContext;
  /** The single relay this republish reads from and publishes to. */
  relayUrl: string;
  /** The loaded standalone context — the caller MUST stop it when done. */
  standalone: StandaloneContext;
  identity: IdentityReport;
  /** The repo's current state, including the announcement being amended. */
  remote: RemoteState;
  /** The #158 conformance backfill for this republish. */
  facts: ConformanceFacts;
}

/** A republish that must not happen; the command returns `exitCode` as-is. */
export interface RefusedRepublish {
  ok: false;
  exitCode: number;
  /** Loaded before the refusal, when it was — the caller still stops it. */
  standalone?: StandaloneContext;
}

/**
 * Everything a paid kind:30617 republish must clear BEFORE it may spend
 * anything, in one place: exactly one ws/wss relay, the embedded standalone
 * publisher (the daemon has no announcement route), the owner-only check, the
 * current announcement read off the relay, and the refusal to republish a repo
 * that has never been announced.
 *
 * The last two are money-safety rules, not conveniences:
 *
 *   - only the OWNER's kind:30617 is authoritative, so a non-owner republish
 *     would pay to write that identity's own, ignored announcement;
 *   - republishing an UNANNOUNCED repo would mint a phantom announcement with
 *     a placeholder name for real money, and `rig push` only announces a repo
 *     that is not already announced — so the placeholder would permanently
 *     shadow the real name and description the first push intended.
 *
 * @param what - Verb phrase for the owner-only refusal, e.g. `change the
 *   maintainer set`.
 * @param before - Verb phrase for the unannounced refusal, e.g. `before
 *   managing maintainers`.
 * @returns The opened republish, or the exit code the command must return.
 *   Either way, `standalone` (when present) is the caller's to stop.
 */
export async function openAnnouncementRepublish(options: {
  deps: EventCommandDeps;
  flags: RepoCommandFlags;
  what: string;
  before: string;
}): Promise<OpenedRepublish | RefusedRepublish> {
  const { deps, flags, what, before } = options;
  const { io } = deps;

  const ctx = await resolveRepoContext(flags, deps);
  // A single relay for a paid publish (mirrors push/events guard).
  if (ctx.relays.length > 1) {
    io.err(singleRelayRefusal(ctx.resolved, 'Nothing was published or paid.'));
    return { ok: false, exitCode: 1 };
  }
  const relayUrl = ctx.relays[0];
  if (relayUrl === undefined || !WS_URL_RE.test(relayUrl)) {
    throw new InvalidRelayUrlError(
      relayUrl ?? '',
      'a paid publish needs a ws:// or wss:// relay'
    );
  }

  // Standalone only: the daemon has no announcement route.
  const load = deps.loadStandalone ?? defaultLoadStandalone;
  const standalone = await load({
    env: deps.env,
    cwd: deps.cwd,
    warn: (line) => io.err(line),
    relayUrl,
  });
  const identity = identityReport(standalone);

  if (identity.pubkey.toLowerCase() !== ctx.owner.toLowerCase()) {
    io.err(
      `rig: only the repo owner (${ctx.owner.slice(0, 8)}…) can ${what} — the ` +
        `active identity is ${identity.pubkey.slice(0, 8)}…. ` +
        'A non-owner republish would write your own (ignored) announcement. ' +
        'Nothing was published or paid.'
    );
    return { ok: false, exitCode: 1, standalone };
  }

  const remote = await fetchRemoteState({
    relayUrls: [relayUrl],
    ownerPubkey: ctx.owner,
    repoId: ctx.repoId,
    ...(deps.webSocketFactory
      ? { webSocketFactory: deps.webSocketFactory }
      : {}),
  });
  if (!remote.announced) {
    io.err(
      `rig: 30617:${ctx.owner.slice(0, 8)}…:${ctx.repoId} has no announcement ` +
        'yet — run `rig push` to publish the repo (with its real ' +
        `name/description) ${before}. Nothing was published or paid.`
    );
    return { ok: false, exitCode: 1, standalone };
  }

  return {
    ok: true,
    ctx,
    relayUrl,
    standalone,
    identity,
    remote,
    facts: await conformanceFactsFor({ ctx, relayUrl, deps }),
  };
}
