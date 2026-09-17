/**
 * The kind:30617 repository announcement — build and amend (#154).
 *
 * A kind:30617 is NIP-33 replaceable: publishing a new one REPLACES the old
 * one wholesale, so a republish that rebuilds the event from the handful of
 * fields rig models destroys every tag rig does not model — another client's
 * maintainer role tags (`M`/`m`/`o`), `clone`, `blossoms`, `t`, `alt`, or any
 * tag invented after this file was written.
 *
 * This module owns the whole "next announcement" question so no caller has to
 * think about it: give it the current announcement (or `null` for a repo's
 * first) plus the fields you are editing, and it returns the next unsigned
 * event. The known-tag set is explicit and small; **carrying a tag over
 * verbatim is the default**, and unknown tags keep their original relative
 * order. Same pattern as ngit's `is_known_tag_name` + `extra_tags`
 * (`ngit:src/lib/repo_ref.rs`).
 *
 * Every kind:30617 rig publishes — first push, `rig maintainers`,
 * `rig payout` — is built here.
 */

import { REPOSITORY_ANNOUNCEMENT_KIND } from '@toon-protocol/core/nip34';
import {
  MAINTAINERS_TAG,
  PAYOUT_TAG,
  parseMaintainers,
  type PayoutPointer,
  type UnsignedEvent,
} from './nip34-events.js';

/** NIP-34 tag naming the relays a repo's events are published to. */
export const RELAYS_TAG = 'relays';
/** NIP-34 tag naming a web URL where the repo can be browsed. */
export const WEB_TAG = 'web';
/**
 * The marker that makes an `["r", "<sha>", "euc"]` tag the repo's *earliest
 * unique commit* — its fork-identity root — rather than any other `r` tag.
 */
export const EARLIEST_UNIQUE_COMMIT_MARKER = 'euc';

/** The current announcement, as read off the relay. */
export interface ExistingAnnouncement {
  tags: string[][];
  /** kind:30617 content is conventionally empty, but it is preserved. */
  content?: string;
}

/**
 * The fields an amendment can change. **Omit a field to leave it exactly as
 * the current announcement has it** — that, not deletion, is the default.
 * Pass a value to rewrite it, and `null`/`[]` to remove it.
 */
export interface AnnouncementEdits {
  /** The `d` tag. Always written — an announcement is nothing without it. */
  repoId: string;
  name?: string;
  description?: string;
  /**
   * Declared maintainer pubkeys (hex). Emitted as ONE multi-valued
   * `["maintainers", …]` tag; duplicates and non-64-hex values are dropped,
   * and an empty result emits no tag. The owner is an implicit maintainer.
   */
  maintainers?: readonly string[];
  /** The `["payout", "<chain>", "<address>"]` pointer (rig#92). */
  payout?: PayoutPointer | null;
  /** Relay URLs, as ONE multi-valued `["relays", …]` tag. */
  relays?: readonly string[] | null;
  /** Web viewer URLs, as ONE multi-valued `["web", …]` tag. */
  web?: readonly string[] | null;
  /**
   * The repo's earliest unique commit, emitted as `["r", "<sha>", "euc"]`.
   * Omit to keep whatever the announcement already declares: a repo's fork
   * identity must never change under its owner.
   */
  earliestUniqueCommit?: string | null;
}

/** One multi-valued tag from a list, deduped and blank-stripped; `[]` if empty. */
function multiValueTag(name: string, values: readonly string[]): string[][] {
  const kept: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) continue;
    seen.add(trimmed);
    kept.push(trimmed);
  }
  return kept.length > 0 ? [[name, ...kept]] : [];
}

/**
 * One tag slot rig models: how to recognize it on an existing announcement,
 * and what an edit turns it into. Everything a slot knows lives in its entry,
 * so adding a field to {@link AnnouncementEdits} is a one-place change.
 */
interface SlotSpec {
  /** Does this tag occupy the slot? */
  readonly matches: (tag: string[]) => boolean;
  /**
   * The tags the slot becomes for these edits — `[]` when the edit removes it,
   * `null` when the edits leave the slot alone and it must be carried over.
   */
  readonly rewrite: (edits: AnnouncementEdits) => string[][] | null;
}

/** True for a tag named `name` — the common case. */
const named =
  (name: string) =>
  (tag: string[]): boolean =>
    tag[0] === name;

/**
 * Every slot this module models, in the order tags are emitted when the
 * current announcement has no place to keep them (a first announcement, or a
 * field being added). Anything NOT matched here is unknown by definition and
 * is carried over untouched — that is the whole point of the module.
 */
const SLOTS = new Map<string, SlotSpec>([
  ['d', { matches: named('d'), rewrite: (e) => [['d', e.repoId]] }],
  [
    'name',
    {
      matches: named('name'),
      rewrite: (e) => (e.name === undefined ? null : [['name', e.name]]),
    },
  ],
  [
    'description',
    {
      matches: named('description'),
      rewrite: (e) =>
        e.description === undefined ? null : [['description', e.description]],
    },
  ],
  [
    'maintainers',
    {
      matches: named(MAINTAINERS_TAG),
      rewrite: (e) => {
        if (e.maintainers === undefined) return null;
        // Normalize through the reader so writing and reading share one rule.
        const declared = parseMaintainers([
          [MAINTAINERS_TAG, ...e.maintainers],
        ]);
        return declared.length > 0 ? [[MAINTAINERS_TAG, ...declared]] : [];
      },
    },
  ],
  [
    'payout',
    {
      matches: named(PAYOUT_TAG),
      rewrite: (e) =>
        e.payout === undefined
          ? null
          : e.payout
            ? [[PAYOUT_TAG, e.payout.chain, e.payout.address]]
            : [],
    },
  ],
  [
    'relays',
    {
      matches: named(RELAYS_TAG),
      rewrite: (e) =>
        e.relays === undefined
          ? null
          : e.relays
            ? multiValueTag(RELAYS_TAG, e.relays)
            : [],
    },
  ],
  [
    'web',
    {
      matches: named(WEB_TAG),
      rewrite: (e) =>
        e.web === undefined ? null : e.web ? multiValueTag(WEB_TAG, e.web) : [],
    },
  ],
  [
    'euc',
    {
      // Only the euc marker is ours. Every other `r` tag is someone else's.
      matches: (tag) =>
        tag[0] === 'r' && tag[2] === EARLIEST_UNIQUE_COMMIT_MARKER,
      rewrite: (e) =>
        e.earliestUniqueCommit === undefined
          ? null
          : e.earliestUniqueCommit
            ? [['r', e.earliestUniqueCommit, EARLIEST_UNIQUE_COMMIT_MARKER]]
            : [],
    },
  ],
]);

/** The slot a tag occupies, or `null` when rig does not model it. */
function slotOf(tag: string[]): string | null {
  for (const [slot, spec] of SLOTS) {
    if (spec.matches(tag)) return slot;
  }
  return null;
}

/** The tags each EDITED slot becomes; slots left alone are absent. */
function rewrittenSlots(edits: AnnouncementEdits): Map<string, string[][]> {
  const out = new Map<string, string[][]>();
  for (const [slot, spec] of SLOTS) {
    const next = spec.rewrite(edits);
    if (next !== null) out.set(slot, next);
  }
  return out;
}

/**
 * The next kind:30617 for a repo: `current` with `edits` applied, and
 * everything else — known-but-unedited tags AND tags rig has never heard of —
 * carried over verbatim in place.
 *
 * An edited slot is rewritten where the current announcement first mentions
 * it, so a republish moves nothing; repeated tags for one slot collapse into
 * the single edited value. Slots the current announcement lacks are appended
 * in {@link SLOTS} order. `d` always leads.
 *
 * @param current - The announcement being amended, or `null` for a repo's first.
 * @param edits - The fields to change; omitted fields are left as they are.
 */
export function amendRepoAnnouncement(
  current: ExistingAnnouncement | null,
  edits: AnnouncementEdits
): UnsignedEvent {
  const rewritten = rewrittenSlots(edits);
  const tags: string[][] = [['d', edits.repoId]];
  const emitted = new Set<string>(['d']);

  for (const tag of current?.tags ?? []) {
    const slot = slotOf(tag);
    const replacement = slot === null ? undefined : rewritten.get(slot);
    if (slot === null || replacement === undefined) {
      tags.push([...tag]); // unknown, or known but not edited → verbatim
      continue;
    }
    if (emitted.has(slot)) continue; // a repeat of a slot already rewritten
    for (const next of replacement) tags.push([...next]);
    emitted.add(slot);
  }

  for (const [slot, replacement] of rewritten) {
    if (emitted.has(slot)) continue;
    for (const next of replacement) tags.push([...next]);
    emitted.add(slot);
  }

  return {
    kind: REPOSITORY_ANNOUNCEMENT_KIND,
    content: current?.content ?? '',
    tags,
    created_at: Math.floor(Date.now() / 1000),
  };
}

/**
 * Build a repo's FIRST kind:30617 announcement — {@link amendRepoAnnouncement}
 * with nothing to amend.
 *
 * @param repoId - Repository identifier (d tag)
 * @param name - Human-readable repository name
 * @param description - Repository description
 * @param maintainers - Optional declared maintainer pubkeys (hex). Emitted as
 *   a single `["maintainers", …]` tag when non-empty; duplicate and non-64-hex
 *   values are dropped. The owner (the signer) is an implicit maintainer and
 *   need not be listed — if passed it is emitted, which is harmless since the
 *   owner is authorized regardless. See {@link MAINTAINERS_TAG}.
 * @param payout - Optional declared payout pointer (rig#92). Emitted as a
 *   single `["payout", "evm", <address>]` tag when given; omit (or pass
 *   `null`) to leave the repo with no payout pointer. See {@link PAYOUT_TAG}.
 */
export function buildRepoAnnouncement(
  repoId: string,
  name: string,
  description: string,
  maintainers: string[] = [],
  payout?: PayoutPointer | null
): UnsignedEvent {
  return amendRepoAnnouncement(null, {
    repoId,
    name,
    description,
    maintainers,
    payout: payout ?? null,
  });
}

// ---------------------------------------------------------------------------
// Earliest unique commit (#158)
// ---------------------------------------------------------------------------

/** The local-git capability {@link earliestUniqueCommit} needs. */
export interface RootCommitSource {
  /** Root (parentless) commits of the repo, or of `rev` when given. */
  rootCommits(rev?: string): Promise<string[]>;
}

/**
 * The repo's *earliest unique commit* — the SHA that goes in
 * `["r", "<sha>", "euc"]` and groups a repo with its forks across NIP-34
 * clients.
 *
 * Every collaborator must compute the SAME value from the same history, so
 * the rule is total and has no dependence on rev-list ordering:
 *
 * 1. One root commit → that root.
 * 2. Several roots → only the roots reachable from the default branch are
 *    candidates; a repo whose default branch resolves to nothing falls back
 *    to all roots.
 * 3. Still several candidates → the lexicographically lowest SHA.
 *
 * "The default branch" is read as `HEAD`, because a local git repository has
 * no other notion of one — `HEAD` IS the branch a clone lands on, and it is
 * what ngit reads for the same tag. The residual ambiguity is narrow (a
 * multi-root repo whose first push is made from a checked-out branch that
 * reaches a different root than the default one does) and it closes after
 * that first push: once an announcement carries an `euc`, every republish
 * preserves it rather than recomputing, so the value can never drift.
 *
 * @returns The chosen SHA, or `null` for a repo with no commits.
 */
export async function earliestUniqueCommit(
  reader: RootCommitSource
): Promise<string | null> {
  const all = await reader.rootCommits();
  if (all.length === 0) return null;
  if (all.length === 1) return all[0] ?? null;
  const onDefaultBranch = await reader.rootCommits('HEAD');
  const candidates = onDefaultBranch.length > 0 ? onDefaultBranch : all;
  return [...candidates].sort()[0] ?? null;
}

/**
 * The `euc` an announcement already declares, or `null`.
 *
 * A repo's fork identity must never change under its owner, so a republish
 * reads this FIRST and recomputes nothing when it is non-null.
 */
export function announcedEuc(current: ExistingAnnouncement | null): string | null {
  for (const tag of current?.tags ?? []) {
    if (tag[0] === 'r' && tag[2] === EARLIEST_UNIQUE_COMMIT_MARKER) {
      const sha = tag[1];
      if (sha !== undefined && sha.length > 0) return sha;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Conformance tags (#158)
// ---------------------------------------------------------------------------

/**
 * What rig knows, at publish time, about where this repo lives — the inputs
 * for the three NIP-34 conformance tags.
 */
export interface ConformanceFacts {
  /** Relay URLs this publish is going to. Emitted as ONE `relays` tag. */
  relays: readonly string[];
  /** The repo's rig-web viewer URL, or `null` when it cannot be derived. */
  web: string | null;
  /**
   * The `euc` computed from the LOCAL repository ({@link earliestUniqueCommit}),
   * or `null` when there is no local repo to compute it from. Ignored when the
   * announcement already carries one.
   */
  earliestUniqueCommit: string | null;
}

/**
 * Every value a multi-valued tag already carries on `current`, in order,
 * followed by `additions` that are not already there. Blank-stripped and
 * deduped, so a repeat republish adds nothing.
 */
function unionValues(
  current: ExistingAnnouncement | null,
  name: string,
  additions: readonly string[]
): string[] {
  const existing: string[] = [];
  for (const tag of current?.tags ?? []) {
    if (tag[0] === name) existing.push(...tag.slice(1));
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of [...existing, ...additions]) {
    const trimmed = value.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

/**
 * The conformance-tag edits to fold into an {@link amendRepoAnnouncement}
 * call — the backfill every owner-initiated republish performs.
 *
 * `relays` and `web` are UNIONED into what the announcement already declares,
 * never substituted for it. rig's statement is "this repo also lives at this
 * relay, and can also be browsed here" — a repo announced by another NIP-34
 * client keeps that client's relay list and viewer URL, and gains rig's. The
 * existing values lead, in their original order, so a second republish that
 * adds nothing new is a no-op and costs nothing (see
 * {@link diffAnnouncementTags}).
 *
 * Union, not rewrite, is what makes a rig republish safe on a repo rig does
 * not exclusively own: dropping another client's relay would strand that
 * client's readers, and #158's "the relay URLs the publish is going to" is
 * satisfied as long as rig's relay is IN the list. Removing a stale relay or
 * viewer URL is therefore never automatic — it is a deliberate edit.
 *
 * The `euc` is written only when the announcement does not already declare
 * one: a repo's fork identity must never change under its owner, even if the
 * local root commit differs (a shallow clone, a rewritten history, a
 * different worktree). Omitted slots are left exactly as they are, which is
 * what makes this composable with a `maintainers` or `payout` edit.
 *
 * `clone` is deliberately absent: rig has no git-clonable URL, and emitting
 * one would send other clients to a fetch that cannot succeed. An existing
 * `clone` tag is unknown to {@link SLOTS} and rides along verbatim.
 */
export function conformanceEdits(
  current: ExistingAnnouncement | null,
  facts: ConformanceFacts
): Pick<AnnouncementEdits, 'relays' | 'web' | 'earliestUniqueCommit'> {
  const edits: Pick<
    AnnouncementEdits,
    'relays' | 'web' | 'earliestUniqueCommit'
  > = {};
  const relays = unionValues(current, RELAYS_TAG, facts.relays);
  if (relays.length > 0) edits.relays = relays;
  const web = unionValues(current, WEB_TAG, facts.web === null ? [] : [facts.web]);
  if (web.length > 0) edits.web = web;
  if (announcedEuc(current) === null && facts.earliestUniqueCommit !== null) {
    edits.earliestUniqueCommit = facts.earliestUniqueCommit;
  }
  return edits;
}

// ---------------------------------------------------------------------------
// Diffing a republish (#158)
// ---------------------------------------------------------------------------

/** Tag-level difference between the current announcement and the next one. */
export interface AnnouncementDiff {
  /** Tags the republish adds (or changes into). */
  added: string[][];
  /** Tags the republish drops (or changes away from). */
  removed: string[][];
  /**
   * True when the republish would change nothing on the wire — derived from
   * `added`/`removed`, and named because "is this republish worth paying for?"
   * is the question every caller actually asks.
   */
  unchanged: boolean;
}

/** A tag as a comparison key — tag values are ordered, so this is exact. */
function tagKey(tag: string[]): string {
  return JSON.stringify(tag);
}

/**
 * What a republish would change, as a multiset difference over whole tags.
 *
 * This is what a confirmation gate shows the owner before they pay, and what
 * lets a refresh publish nothing when there is nothing to change. Tag ORDER is
 * not a difference — {@link amendRepoAnnouncement} already guarantees order is
 * preserved, and an owner should not be charged for a reordering.
 */
export function diffAnnouncementTags(
  current: ExistingAnnouncement | null,
  next: UnsignedEvent
): AnnouncementDiff {
  const remaining = new Map<string, number>();
  for (const tag of current?.tags ?? []) {
    remaining.set(tagKey(tag), (remaining.get(tagKey(tag)) ?? 0) + 1);
  }
  const added: string[][] = [];
  for (const tag of next.tags) {
    const key = tagKey(tag);
    const count = remaining.get(key) ?? 0;
    if (count > 0) remaining.set(key, count - 1);
    else added.push([...tag]);
  }
  const removed: string[][] = [];
  for (const [key, count] of remaining) {
    for (let i = 0; i < count; i += 1) {
      removed.push(JSON.parse(key) as string[]);
    }
  }
  return {
    added,
    removed,
    unchanged: added.length === 0 && removed.length === 0,
  };
}
