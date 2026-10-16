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
 */

import { parseMaintainers } from './nip34-events.js';

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
    if (
      winner === null ||
      event.created_at > winner.created_at ||
      (event.created_at === winner.created_at && event.id < winner.id)
    ) {
      winner = event;
    }
  }
  return winner;
}
