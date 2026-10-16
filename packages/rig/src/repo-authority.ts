/**
 * Who may speak for a repo — the shared, pure reader policy (ADR-0005).
 *
 * Two functions, no I/O, so the CLI and rig-web resolve the same refs and the
 * same statuses from the same events:
 *   - {@link authorizedAuthors}: owner ∪ the `maintainers` tag of the OWNER's
 *     own latest kind:30617. Maintainers named in another maintainer's
 *     announcement carry no authority (it does not spread transitively).
 *   - {@link honoredRepoState}: the newest kind:30618 signed by an authorized
 *     author; a `created_at` tie goes to the lowest event id.
 *   - {@link selectRevision}: the latest kind:1617 revision of a root patch
 *     signed by the root's author or an authorized author.
 */

/**
 * NIP-34 tag naming the repo's declared maintainers: one multi-valued tag
 * `["maintainers", "<hex-pubkey>", "<hex-pubkey>", …]` on the kind:30617
 * announcement (mirrors the spec's multi-valued `relays` tag). The repo
 * OWNER — the announcement event's own pubkey — is ALWAYS an implicit
 * maintainer and need not be listed. Consumers derive an issue/PR's status
 * ONLY from kind:1630-1633 events signed by owner ∪ maintainers (#287): the
 * relay is permissionless, so this is the CONSUMER-side authority filter.
 */
export const MAINTAINERS_TAG = 'maintainers';

const HEX64 = /^[0-9a-f]{64}$/;

/**
 * Collect the declared maintainer pubkeys (lowercased hex) from a kind:30617
 * event's tags. Tolerant of repeated `maintainers` tags and non-hex noise —
 * only 64-char hex values survive. Does NOT include the owner (implicit).
 */
export function parseMaintainers(tags: string[][]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const tag of tags) {
    if (tag[0] !== MAINTAINERS_TAG) continue;
    for (const value of tag.slice(1)) {
      const hex = value.toLowerCase();
      if (HEX64.test(hex) && !seen.has(hex)) {
        seen.add(hex);
        out.push(hex);
      }
    }
  }
  return out;
}

/** NIP-34 patch-revision marker: `[\"t\", \"root-revision\"]` on the revision. */
export const REVISION_ROOT_MARKER = 'root-revision';

/** The slice of a signed event the honoring rules read. */
export interface AuthorityEvent {
  id: string;
  pubkey: string;
  created_at: number;
  tags: string[][];
}

/**
 * The pubkeys (lowercased hex) allowed to move refs and set status: the owner,
 * plus the `maintainers` tag of `ownerAnnouncementTags` — the tags of the
 * owner's own latest kind:30617 (empty/undefined when unannounced).
 */
export function authorizedAuthors(
  ownerPubkey: string,
  ownerAnnouncementTags: string[][] = []
): Set<string> {
  return new Set([
    ownerPubkey.toLowerCase(),
    ...parseMaintainers(ownerAnnouncementTags),
  ]);
}

/** True when `candidate` beats `current`: newer `created_at`, a tie to the lowest id. */
export function supersedes(
  candidate: { created_at: number; id: string },
  current: { created_at: number; id: string }
): boolean {
  return (
    candidate.created_at > current.created_at ||
    (candidate.created_at === current.created_at && candidate.id < current.id)
  );
}

/**
 * The honored repo state: among `candidates` signed by an authorized author,
 * the highest `created_at`, ties broken by lowest event id. `null` when none
 * qualifies. Callers pre-filter kind and `d` tag.
 */
export function honoredRepoState<E extends AuthorityEvent>(
  authorized: ReadonlySet<string>,
  candidates: readonly E[]
): E | null {
  let winner: E | null = null;
  for (const event of candidates) {
    if (!authorized.has(event.pubkey.toLowerCase())) continue;
    if (winner === null || supersedes(event, winner)) winner = event;
  }
  return winner;
}

/** True when a kind:1617 carries the `root-revision` marker. */
export function isPatchRevision(event: { tags: string[][] }): boolean {
  return event.tags.some((t) => t[0] === 't' && t[1] === REVISION_ROOT_MARKER);
}

/** The event id a revision replies to (its NIP-10 `reply`-marked `e` tag). */
export function revisionRootId(event: {
  tags: string[][];
}): string | undefined {
  const replies = event.tags.filter((t) => t[0] === 'e' && t[1]);
  return (replies.find((t) => t[3] === 'reply') ?? replies[0])?.[1];
}

/** Result of {@link selectRevision}. */
export interface RevisionSelection<E extends AuthorityEvent> {
  /** The revision to review/merge — the root itself when none qualifies. */
  latest: E;
  /** Every earlier version, oldest first (the root first). */
  earlier: E[];
}

/**
 * Pick the revision of `root` to act on. A revision counts when it carries
 * the `root-revision` marker, replies to `root`, and is signed by the root's
 * author or an authorized author; anything else (a stranger's revision) is
 * ignored. Order is `created_at`, ties by lowest event id; the root, being
 * the original, sorts first. Callers pre-filter kind.
 */
export function selectRevision<E extends AuthorityEvent>(
  root: E,
  revisions: readonly E[],
  authorized: ReadonlySet<string>
): RevisionSelection<E> {
  const allowed = new Set([...authorized, root.pubkey.toLowerCase()]);
  const valid = revisions.filter(
    (r) =>
      r.id !== root.id &&
      isPatchRevision(r) &&
      revisionRootId(r) === root.id &&
      allowed.has(r.pubkey.toLowerCase())
  );
  const seen = new Set<string>();
  const chain = valid
    .filter((r) => !seen.has(r.id) && !!seen.add(r.id))
    .sort((a, b) => a.created_at - b.created_at || (a.id < b.id ? -1 : 1));
  const ordered = [root, ...chain];
  return {
    latest: ordered[ordered.length - 1] as E,
    earlier: ordered.slice(0, -1),
  };
}
