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

/**
 * The tag slots this module models. Anything else on an announcement is
 * unknown by definition and is carried over untouched.
 *
 * Doubles as the emission order for tags that have no place to keep in the
 * current announcement (a first announcement, or a field being added).
 */
const SLOT_ORDER = [
  'd',
  'name',
  'description',
  'maintainers',
  'payout',
  'relays',
  'web',
  'euc',
] as const;

type Slot = (typeof SLOT_ORDER)[number];

/** The slot a tag occupies, or `null` when rig does not model it. */
function slotOf(tag: string[]): Slot | null {
  switch (tag[0]) {
    case 'd':
      return 'd';
    case 'name':
      return 'name';
    case 'description':
      return 'description';
    case MAINTAINERS_TAG:
      return 'maintainers';
    case PAYOUT_TAG:
      return 'payout';
    case RELAYS_TAG:
      return 'relays';
    case WEB_TAG:
      return 'web';
    case 'r':
      // Only the euc marker is ours. Every other `r` tag is someone else's.
      return tag[2] === EARLIEST_UNIQUE_COMMIT_MARKER ? 'euc' : null;
    default:
      return null;
  }
}

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

/** The tags each edited slot becomes — `[]` means "the edit removes it". */
function rewrittenSlots(edits: AnnouncementEdits): Map<Slot, string[][]> {
  const out = new Map<Slot, string[][]>();
  out.set('d', [['d', edits.repoId]]);
  if (edits.name !== undefined) out.set('name', [['name', edits.name]]);
  if (edits.description !== undefined) {
    out.set('description', [['description', edits.description]]);
  }
  if (edits.maintainers !== undefined) {
    // Normalize through the reader so writing and reading share one rule.
    const declared = parseMaintainers([[MAINTAINERS_TAG, ...edits.maintainers]]);
    out.set(
      'maintainers',
      declared.length > 0 ? [[MAINTAINERS_TAG, ...declared]] : []
    );
  }
  if (edits.payout !== undefined) {
    out.set(
      'payout',
      edits.payout
        ? [[PAYOUT_TAG, edits.payout.chain, edits.payout.address]]
        : []
    );
  }
  if (edits.relays !== undefined) {
    out.set('relays', edits.relays ? multiValueTag(RELAYS_TAG, edits.relays) : []);
  }
  if (edits.web !== undefined) {
    out.set('web', edits.web ? multiValueTag(WEB_TAG, edits.web) : []);
  }
  if (edits.earliestUniqueCommit !== undefined) {
    out.set(
      'euc',
      edits.earliestUniqueCommit
        ? [['r', edits.earliestUniqueCommit, EARLIEST_UNIQUE_COMMIT_MARKER]]
        : []
    );
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
 * in {@link SLOT_ORDER}. `d` always leads.
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
  const emitted = new Set<Slot>(['d']);

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

  for (const slot of SLOT_ORDER) {
    const replacement = rewritten.get(slot);
    if (replacement === undefined || emitted.has(slot)) continue;
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
