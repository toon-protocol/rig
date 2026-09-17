/**
 * Shared scaffolding for the rig-owned commands that read or republish a
 * repo's kind:30617 announcement (`rig maintainers`, `rig payout`): the
 * common flag set (`--repo-id/--owner/--remote/--relay/--yes/--json`), and
 * the resolution of the repo address + relays from those flags plus the
 * repo's `toon.*` git config.
 *
 * These commands are deliberately identical at the edges — same flags, same
 * repo-address resolution, same relay rules — and differ only in WHICH tag of
 * the announcement they touch. Keeping the edges in one place is what makes
 * that sameness real rather than aspirational.
 */

import { ownerToHex } from '../npub.js';
import {
  earliestUniqueCommit,
  type ConformanceFacts,
} from '../repo-announcement.js';
import { GitRepoReader } from '../repo-reader.js';
import { repoWebUrl } from '../rig-pointer.js';
import type { EventCommandDeps } from './events.js';
import { UnconfiguredRepoAddressError } from './errors.js';
import { readToonConfig, resolveRepoRoot } from './git-config.js';
import {
  resolveRelays,
  type ResolvedRelays,
} from './remote.js';

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
  return {
    relays: [relayUrl],
    web: repoWebUrl({
      env: deps.env,
      relay: relayUrl,
      ownerPubkey: ctx.owner,
      repoId: ctx.repoId,
    }),
    earliestUniqueCommit: euc,
  };
}
