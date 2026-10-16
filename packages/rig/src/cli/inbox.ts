/**
 * `rig inbox` (#234): the FREE one-shot read of everything new that touches
 * the user — patches and revisions, issues, comments, statuses and CI runs.
 *
 * Scope: repos the user owns or is listed as a maintainer of (the owner's own
 * latest kind:30617 `maintainers` tag), plus any event that `p`-tags the user.
 * Relays: the configured relays ∪ each watched repo's announcement `relays`
 * tag, deduplicated by event id. Statuses are shown only from authorized
 * authors (ADR-0005: owner ∪ maintainers ∪ the target's own author); the
 * live log tail (kind:39841) is never read.
 *
 * Read position: a per-identity cursor under the client state dir, so the
 * inbox works from any directory. It advances only after events were emitted;
 * `--since` and `--all` override it without moving it.
 *
 * No identity unlock, payment or channel: the user's pubkey is all it needs.
 */

import { parseArgs } from 'node:util';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ISSUE_KIND,
  PATCH_KIND,
  REPOSITORY_ANNOUNCEMENT_KIND,
  STATUS_APPLIED_KIND,
  STATUS_CLOSED_KIND,
  STATUS_DRAFT_KIND,
  STATUS_OPEN_KIND,
} from '@toon-protocol/core/nip34';
import {
  CI_JOB_RESULT_KIND,
  CI_SERVICE_REQUEST_KIND,
  CI_SERVICE_STOP_KIND,
  CI_WORKFLOW_PROGRESS_KIND,
  CI_WORKFLOW_RESULT_KIND,
} from '../ci/nip-c1-events.js';
import {
  COMMENT_KIND,
  firstTagValue,
  LEGACY_COMMENT_KIND,
  parseMaintainers,
} from '../nip34-events.js';
import { ownerToHex } from '../npub.js';
import { authorizedAuthors } from '../repo-authority.js';
import type { NostrEvent, WebSocketFactory } from '../remote-state.js';
import { defaultWebSocketFactory } from '../remote-state.js';
import { emitCliError, InvalidRelayUrlError } from './errors.js';
import { readToonConfig, resolveRepoRoot } from './git-config.js';
import { clientStateDir, resolveIdentity } from './identity.js';
import type { ReadCommandDeps } from './read-seams.js';
import { resolveRelays } from './remote.js';
import { WS_URL_RE } from './repo-command.js';
import { queryAll, withTargetAuthor } from './tracker.js';

export const INBOX_USAGE = `Usage: rig inbox [options]

Print everything new since you last checked (free — relay reads only):
patches and revisions, issues, comments, status changes and CI results for
repos you own or maintain, plus any event that tags your pubkey.

Options:
  --since <time>       read from a unix time, an ISO date, or a relative
                       age (30m, 2h, 7d); does not move the cursor
  --all                read everything, ignoring the cursor; does not move it
  --pubkey <pubkey>    act as this pubkey (npub or hex) instead of the
                       resolved identity
  --remote <name>      read via this configured git remote (default: origin)
  --relay <url>        ad-hoc relay override; repeatable — reads are merged
  --json               machine-readable array, one object per event
  -h, --help           show this help`;

/** Normalized event type of an inbox entry. */
export type InboxType =
  'patch' | 'revision' | 'issue' | 'comment' | 'status' | 'ci';

/** One inbox entry — the same shape `--json` emits for every event. */
export interface InboxEntry {
  id: string;
  kind: number;
  type: InboxType;
  /** `30617:<owner>:<repoId>`, or `null` when the event names no repo. */
  repo: string | null;
  /** The event this one is about (the event itself for patches/issues). */
  target: string;
  author: string;
  created_at: number;
}

const STATUS_KINDS = [
  STATUS_OPEN_KIND,
  STATUS_APPLIED_KIND,
  STATUS_CLOSED_KIND,
  STATUS_DRAFT_KIND,
];
/** Every CI kind `rig ci status` parses (never the 39841 live log tail). */
const CI_KINDS = [
  CI_SERVICE_REQUEST_KIND,
  CI_SERVICE_STOP_KIND,
  CI_WORKFLOW_RESULT_KIND,
  CI_WORKFLOW_PROGRESS_KIND,
  CI_JOB_RESULT_KIND,
];
/** Everything the inbox reads (never the 39841 live log tail). */
const INBOX_KINDS = [
  PATCH_KIND,
  ISSUE_KIND,
  COMMENT_KIND,
  LEGACY_COMMENT_KIND,
  ...STATUS_KINDS,
  ...CI_KINDS,
];

const HEX64_RE = /^[0-9a-f]{64}$/;

// ---------------------------------------------------------------------------
// Cursor (per identity, outside any repo's git config)
// ---------------------------------------------------------------------------

/** The read position: newest emitted `created_at` and the ids already shown at it. */
interface Cursor {
  at: number;
  seen: string[];
}

export const INBOX_CURSOR_FILENAME = 'inbox-cursors.json';

function cursorPath(env: NodeJS.ProcessEnv): string {
  return join(clientStateDir(env), INBOX_CURSOR_FILENAME);
}

function readCursors(env: NodeJS.ProcessEnv): Record<string, Cursor> {
  try {
    const parsed = JSON.parse(readFileSync(cursorPath(env), 'utf8')) as unknown;
    if (parsed && typeof parsed === 'object') {
      return parsed as Record<string, Cursor>;
    }
  } catch {
    // Missing or corrupt → no cursor (a free read must never fail on this).
  }
  return {};
}

function writeCursor(
  env: NodeJS.ProcessEnv,
  pubkey: string,
  cursor: Cursor
): void {
  const cursors = readCursors(env);
  cursors[pubkey] = cursor;
  mkdirSync(clientStateDir(env), { recursive: true });
  writeFileSync(cursorPath(env), JSON.stringify(cursors, null, 2) + '\n');
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Parse `--since`: unix seconds, an ISO date, or a relative age (`2h`). */
export function parseSince(value: string, nowSec: number): number {
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  const rel = /^(\d+)([smhdw])$/.exec(trimmed);
  if (rel) {
    const unit = { s: 1, m: 60, h: 3600, d: 86400, w: 604800 }[
      rel[2] as 's' | 'm' | 'h' | 'd' | 'w'
    ];
    return nowSec - Number(rel[1]) * unit;
  }
  const ms = Date.parse(trimmed);
  if (Number.isNaN(ms)) {
    throw new Error(
      `--since must be a unix time, an ISO date, or an age like 2h (got ${JSON.stringify(value)})`
    );
  }
  return Math.floor(ms / 1000);
}

/** Local alias for the shared, case-sensitive tag reader (../nip34-events.ts). */
const tagValue = firstTagValue;

function hasTopic(event: NostrEvent, topic: string): boolean {
  return event.tags.some((t) => t[0] === 't' && t[1] === topic);
}

function typeOf(event: NostrEvent): InboxType | null {
  if (event.kind === PATCH_KIND) {
    if (hasTopic(event, 'root-revision')) return 'revision';
    // A root patch is tagged `t root`, or (rig's own shape) replies to
    // nothing; a later patch in a series replies to the one before it.
    if (hasTopic(event, 'root') || tagValue(event.tags, 'e') === undefined) {
      return 'patch';
    }
    return null;
  }
  if (event.kind === ISSUE_KIND) return 'issue';
  if (event.kind === COMMENT_KIND || event.kind === LEGACY_COMMENT_KIND) {
    return 'comment';
  }
  if (STATUS_KINDS.includes(event.kind)) return 'status';
  if (CI_KINDS.includes(event.kind)) return 'ci';
  return null;
}

function targetOf(event: NostrEvent, type: InboxType): string {
  const root = tagValue(event.tags, 'E');
  const parent = tagValue(event.tags, 'e');
  switch (type) {
    case 'patch':
    case 'issue':
      return event.id;
    case 'revision':
      return parent ?? event.id;
    case 'comment':
      return root ?? parent ?? event.id;
    case 'status':
      return parent ?? event.id;
    case 'ci':
      return root ?? tagValue(event.tags, 'c') ?? event.id;
  }
}

/** Build the inbox entry for an event, or `null` for a kind the inbox skips. */
export function toInboxEntry(event: NostrEvent): InboxEntry | null {
  const type = typeOf(event);
  if (type === null) return null;
  const repo = event.tags.find(
    (t) => t[0] === 'a' && t[1]?.startsWith(`${REPOSITORY_ANNOUNCEMENT_KIND}:`)
  )?.[1];
  return {
    id: event.id,
    kind: event.kind,
    type,
    repo: repo ?? null,
    target: targetOf(event, type),
    author: event.pubkey,
    created_at: event.created_at,
  };
}

/** Latest replaceable by (created_at desc, id asc) — same tie rule as everywhere. */
function newest(events: NostrEvent[]): NostrEvent | null {
  let winner: NostrEvent | null = null;
  for (const e of events) {
    if (
      winner === null ||
      e.created_at > winner.created_at ||
      (e.created_at === winner.created_at && e.id < winner.id)
    ) {
      winner = e;
    }
  }
  return winner;
}

/** The owner's own latest kind:30617 for `repoId` — the only one with authority. */
async function ownerAnnouncement(
  relays: string[],
  owner: string,
  repoId: string,
  ws: WebSocketFactory
): Promise<NostrEvent | null> {
  const found = await queryAll(
    relays,
    [
      {
        kinds: [REPOSITORY_ANNOUNCEMENT_KIND],
        authors: [owner],
        '#d': [repoId],
      },
    ],
    ws
  ).catch(() => new Map<string, NostrEvent>());
  return newest(
    [...found.values()].filter(
      (e) =>
        e.kind === REPOSITORY_ANNOUNCEMENT_KIND &&
        e.pubkey.toLowerCase() === owner &&
        tagValue(e.tags, 'd') === repoId
    )
  );
}

function relaysTag(tags: string[][]): string[] {
  return tags
    .filter((t) => t[0] === 'relays')
    .flatMap((t) => t.slice(1))
    .filter((url) => WS_URL_RE.test(url));
}

interface WatchedRepo {
  address: string;
  ownerPubkey: string;
  authorized: Set<string>;
  relays: string[];
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

/** Dependency bag: the read seams plus an injectable identity resolver. */
export interface InboxDeps extends ReadCommandDeps {
  resolveIdentityImpl?: typeof resolveIdentity;
  /** Clock override (unix ms) for relative `--since` (tests). */
  now?: () => number;
}

const INBOX_OPTIONS = {
  json: { type: 'boolean', default: false },
  all: { type: 'boolean', default: false },
  since: { type: 'string' },
  pubkey: { type: 'string' },
  remote: { type: 'string' },
  relay: { type: 'string', multiple: true },
  help: { type: 'boolean', short: 'h', default: false },
} as const;

function renderLine(entry: InboxEntry): string {
  const when = new Date(entry.created_at * 1000)
    .toISOString()
    .slice(0, 16)
    .replace('T', ' ');
  const repo = entry.repo ?? '(no repo)';
  return (
    `${when}  ${entry.type.padEnd(8)}  ${entry.id.slice(0, 8)}` +
    `  → ${entry.target.slice(0, 8)}  ${repo}  (${entry.author.slice(0, 8)})`
  );
}

/** `rig inbox` */
export async function runInbox(
  args: string[],
  deps: InboxDeps
): Promise<number> {
  const { io } = deps;
  let json = false;
  let all = false;
  let sinceArg: string | undefined;
  let pubkeyArg: string | undefined;
  let remote: string | undefined;
  let relayFlags: string[] = [];
  try {
    const { values, positionals } = parseArgs({
      args,
      options: INBOX_OPTIONS,
      allowPositionals: true,
    });
    if (values.help) {
      io.out(INBOX_USAGE);
      return 0;
    }
    if (positionals.length > 0) {
      throw new Error('rig inbox takes no positional arguments');
    }
    json = values.json === true;
    all = values.all === true;
    sinceArg = values.since;
    if (values.pubkey !== undefined) pubkeyArg = ownerToHex(values.pubkey);
    remote = values.remote;
    relayFlags = values.relay ?? [];
    if (all && sinceArg !== undefined) {
      throw new Error('--all and --since are mutually exclusive');
    }
  } catch (err) {
    io.err(err instanceof Error ? err.message : String(err));
    io.err(INBOX_USAGE);
    return 2;
  }

  try {
    const nowSec = Math.floor((deps.now ?? Date.now)() / 1000);
    const override =
      sinceArg !== undefined ? parseSince(sinceArg, nowSec) : null;

    const me = (
      pubkeyArg ??
      (
        await (deps.resolveIdentityImpl ?? resolveIdentity)({
          env: deps.env,
          cwd: deps.cwd,
          warn: (line) => io.err(line),
        })
      ).pubkey
    ).toLowerCase();

    // ── Relays (configured; the git config is best-effort) ────────────────
    let repoRoot: string | undefined;
    let toonRelays: string[] = [];
    try {
      repoRoot = await resolveRepoRoot(deps.cwd);
      toonRelays = (await readToonConfig(repoRoot)).relays;
    } catch {
      // Not inside a git repo — the inbox works from any directory.
    }
    const resolved = await resolveRelays({
      relayFlags,
      remoteName: remote,
      repoRoot,
      toonRelays,
    });
    const configured = resolved.relays.filter((url) => WS_URL_RE.test(url));
    if (configured.length === 0) {
      throw new InvalidRelayUrlError(
        resolved.relays[0] ?? '',
        'reads need a ws:// or wss:// relay'
      );
    }
    const ws: WebSocketFactory =
      deps.webSocketFactory ?? defaultWebSocketFactory;

    // ── Watched repos: owned, or listing me in the owner's maintainers ────
    const announcements = await queryAll(
      configured,
      [
        { kinds: [REPOSITORY_ANNOUNCEMENT_KIND], authors: [me] },
        { kinds: [REPOSITORY_ANNOUNCEMENT_KIND], '#maintainers': [me] },
      ],
      ws
    );
    const byRepo = new Map<string, NostrEvent[]>();
    for (const e of announcements.values()) {
      if (e.kind !== REPOSITORY_ANNOUNCEMENT_KIND) continue;
      const d = tagValue(e.tags, 'd');
      if (!d) continue;
      const key = `${e.pubkey.toLowerCase()}:${d}`;
      byRepo.set(key, [...(byRepo.get(key) ?? []), e]);
    }
    const watched: WatchedRepo[] = [];
    for (const [key, events] of byRepo) {
      const owner = (events[0] as NostrEvent).pubkey.toLowerCase();
      const repoId = key.slice(owner.length + 1);
      // Only the owner's own latest announcement carries authority. A
      // `#maintainers` hit may be stale — the owner's newer announcement
      // that removed me doesn't match that filter — so re-read it (ADR-0005).
      const latest =
        owner === me
          ? newest(events)
          : await ownerAnnouncement(configured, owner, repoId, ws);
      if (latest === null) continue;
      if (owner !== me && !parseMaintainers(latest.tags).includes(me)) continue;
      watched.push({
        address: `${REPOSITORY_ANNOUNCEMENT_KIND}:${owner}:${repoId}`,
        ownerPubkey: owner,
        authorized: authorizedAuthors(owner, latest.tags),
        relays: relaysTag(latest.tags),
      });
    }

    // ── Events: per-repo (#a) and p-tagged (#p), merged by event id ───────
    const cursor = readCursors(deps.env)[me];
    const since = all ? undefined : override !== null ? override : cursor?.at;
    const base = since !== undefined ? { since } : {};
    const events = new Map<string, NostrEvent>();
    const collect = (found: Map<string, NostrEvent>): void => {
      for (const [id, e] of found) if (!events.has(id)) events.set(id, e);
    };
    collect(
      await queryAll(
        configured,
        [{ kinds: INBOX_KINDS, '#p': [me], ...base }],
        ws
      )
    );
    for (const repo of watched) {
      const relays = [...new Set([...configured, ...repo.relays])];
      collect(
        await queryAll(
          relays,
          [{ kinds: INBOX_KINDS, '#a': [repo.address], ...base }],
          ws
        )
      );
    }

    // ── Status authorization (owner ∪ maintainers ∪ target's author) ──────
    const authCache = new Map<string, Set<string>>();
    for (const repo of watched) authCache.set(repo.address, repo.authorized);
    const authorizedFor = async (address: string): Promise<Set<string>> => {
      const hit = authCache.get(address);
      if (hit) return hit;
      const m = /^30617:([0-9a-f]{64}):(.+)$/i.exec(address);
      let set = new Set<string>();
      if (m) {
        const owner = (m[1] as string).toLowerCase();
        const latest = await ownerAnnouncement(
          configured,
          owner,
          m[2] as string,
          ws
        );
        set = authorizedAuthors(owner, latest?.tags ?? []);
      }
      authCache.set(address, set);
      return set;
    };
    const targetAuthors = new Map<string, string>();
    const statusEvents = [...events.values()].filter((e) =>
      STATUS_KINDS.includes(e.kind)
    );
    const unknownTargets = new Set<string>();
    for (const e of statusEvents) {
      const target = tagValue(e.tags, 'e');
      if (!target || !HEX64_RE.test(target)) continue;
      const known = events.get(target);
      if (known) targetAuthors.set(target, known.pubkey.toLowerCase());
      else unknownTargets.add(target);
    }
    if (unknownTargets.size > 0) {
      const found = await queryAll(
        configured,
        [{ ids: [...unknownTargets] }],
        ws
      ).catch(() => new Map<string, NostrEvent>());
      for (const [id, e] of found)
        targetAuthors.set(id, e.pubkey.toLowerCase());
    }
    const entries: InboxEntry[] = [];
    for (const event of events.values()) {
      const entry = toInboxEntry(event);
      if (entry === null) continue;
      if (entry.type === 'status') {
        if (entry.repo === null) continue;
        const repoWide = await authorizedFor(entry.repo);
        const targetAuthor = targetAuthors.get(entry.target);
        const authors =
          targetAuthor === undefined
            ? repoWide
            : withTargetAuthor(repoWide, targetAuthor);
        if (!authors.has(event.pubkey.toLowerCase())) continue;
      }
      entries.push(entry);
    }

    // ── Cursor window: drop what a previous read already emitted ──────────
    const fresh = entries
      .filter(
        (e) =>
          all ||
          override !== null ||
          cursor === undefined ||
          e.created_at > cursor.at ||
          (e.created_at === cursor.at && !cursor.seen.includes(e.id))
      )
      .sort((a, b) => a.created_at - b.created_at || (a.id < b.id ? -1 : 1));

    if (json) {
      io.emitJson(fresh);
    } else if (fresh.length === 0) {
      io.out('inbox is empty');
    } else {
      for (const entry of fresh) io.out(renderLine(entry));
    }

    // The cursor moves only after emission, and never for --since / --all.
    if (!all && override === null && fresh.length > 0) {
      const at = Math.max(...fresh.map((e) => e.created_at));
      const seen = fresh.filter((e) => e.created_at === at).map((e) => e.id);
      if (cursor?.at === at) seen.push(...cursor.seen);
      writeCursor(deps.env, me, { at, seen: [...new Set(seen)] });
    }
    return 0;
  } catch (err) {
    return emitCliError(io, json, 'inbox', err);
  }
}
