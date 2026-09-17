/**
 * Pure NIP-34 event builders for the Git-to-TOON write path.
 *
 * Promoted from `packages/rig-web/tests/e2e/seed/lib/event-builders.ts` (#223).
 * All builders return UnsignedEvent — the caller signs with their keypair
 * via finalizeEvent() and publishes through a Publisher (#226). Tag
 * structures follow the NIP-34 spec and `@toon-protocol/core/nip34`.
 */

import { getAddress, isAddress } from 'viem';
import {
  ISSUE_KIND,
  PATCH_KIND,
  REPOSITORY_ANNOUNCEMENT_KIND,
} from '@toon-protocol/core/nip34';
import type {
  STATUS_APPLIED_KIND,
  STATUS_CLOSED_KIND,
  STATUS_DRAFT_KIND,
  STATUS_OPEN_KIND,
} from '@toon-protocol/core/nip34';

// Kinds not (yet) exported by @toon-protocol/core/nip34:
/** Repository State (refs) — replaceable, pairs with kind:30617 via `d` tag. */
export const REPOSITORY_STATE_KIND = 30618;
/**
 * Comment on an issue or patch — NIP-22 `kind:1111`, which NIP-34's "Replies"
 * clause mandates ("Replies … should follow NIP-22 comment"). This is the kind
 * rig WRITES (rig#159).
 */
export const COMMENT_KIND = 1111;
/**
 * rig's pre-#159 private comment dialect. READ-ONLY: never written again, kept
 * so threads published before that release keep rendering. Every reader merges
 * it with {@link COMMENT_KIND} by `created_at`.
 */
export const LEGACY_COMMENT_KIND = 1622;

// ---------------------------------------------------------------------------
// UnsignedEvent type (subset of nostr-tools — no id, sig, or pubkey)
// ---------------------------------------------------------------------------

export interface UnsignedEvent {
  kind: number;
  content: string;
  tags: string[][];
  created_at: number;
}

// ---------------------------------------------------------------------------
// kind:30617 — Repository Announcement (+ maintainer authority, #287)
// ---------------------------------------------------------------------------

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
 * First value of the named tag, or `undefined`. Tag names are matched
 * CASE-SENSITIVELY, exactly as NIP-01 defines them: `E` (a NIP-22 root scope)
 * is a different tag from `e` (the parent item).
 */
export function firstTagValue(
  tags: string[][],
  name: string
): string | undefined {
  return tags.find((t) => t[0] === name)?.[1];
}

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

/**
 * The set of pubkeys whose kind:1630-1633 status events are authoritative for
 * a repo: the owner (always) ∪ the declared maintainers (from the 30617's
 * `maintainers` tag). All values are lowercased hex.
 */
export function authorizedStatusAuthors(
  ownerPubkey: string,
  repoAnnouncementTags: string[][]
): Set<string> {
  return new Set([
    ownerPubkey.toLowerCase(),
    ...parseMaintainers(repoAnnouncementTags),
  ]);
}

// ---------------------------------------------------------------------------
// Payout pointer (rig#92, part of the payout epic toon-protocol/toon-meta#391)
// ---------------------------------------------------------------------------

/**
 * NIP-34 tag naming the repo's declared payout pointer: a single
 * `["payout", "<chain>", "<address>"]` tag on the kind:30617 announcement.
 * No pointer → no split, the serving node keeps 100% of repo-scoped write
 * fees (toon-meta#391 decision 2). The tag carries the chain label so the
 * shape survives future chains, but v1 accepts exactly one: `evm` — the
 * payout accrual ledger is EVM-only today
 * (`crates/connector-client-edge/src/btp.rs:270-272`).
 */
export const PAYOUT_TAG = 'payout';

/** Chains the payout pointer can target. v1: `evm` only (toon-meta#391). */
export type PayoutChain = 'evm';

const SUPPORTED_PAYOUT_CHAINS: ReadonlySet<string> = new Set<PayoutChain>([
  'evm',
]);

/** True when `chain` is a chain the payout pointer supports today. */
function isSupportedPayoutChain(chain: string): chain is PayoutChain {
  return SUPPORTED_PAYOUT_CHAINS.has(chain);
}

/** A repo's declared payout pointer (parsed from / built into the `payout` tag). */
export interface PayoutPointer {
  chain: PayoutChain;
  /** EIP-55 checksummed address (never a raw lowercase/mixed-case echo). */
  address: string;
}

/**
 * True when `address` is a structurally valid, correctly-checksummed EVM
 * address: `0x` + 40 hex chars, and — when mixed-case — a valid EIP-55
 * checksum (an all-lowercase address is accepted as "unchecksummed").
 */
export function isValidEvmPayoutAddress(address: string): boolean {
  return isAddress(address);
}

/**
 * Collect the repo's declared payout pointer from a kind:30617 event's tags.
 * Only `["payout", "evm", <address>]` with a shape- and checksum-valid
 * address is accepted; the address is normalized to its EIP-55 checksummed
 * form. Tolerant of relay noise: an unsupported chain or malformed address
 * is skipped (not thrown). The relay is permissionless and 30617 is
 * replaceable, so a legacy/hand-crafted event could carry more than one
 * `payout` tag — the first valid one wins and the rest are ignored (a
 * `console.warn` notes the drop so a stray extra tag isn't silently
 * mysterious).
 */
export function parsePayout(tags: string[][]): PayoutPointer | null {
  let result: PayoutPointer | null = null;
  let ignored = 0;
  for (const tag of tags) {
    if (tag[0] !== PAYOUT_TAG) continue;
    const [, chain, address] = tag;
    if (
      result === null &&
      chain !== undefined &&
      isSupportedPayoutChain(chain) &&
      address !== undefined &&
      isValidEvmPayoutAddress(address)
    ) {
      result = { chain, address: getAddress(address) };
    } else {
      ignored++;
    }
  }
  if (ignored > 0) {
    console.warn(
      `rig: ignoring ${ignored} extra/invalid "${PAYOUT_TAG}" tag(s) on kind:30617` +
        (result ? ` — using ${result.chain} ${result.address}` : '')
    );
  }
  return result;
}

// ---------------------------------------------------------------------------
// kind:30618 — Repository Refs/State
// ---------------------------------------------------------------------------

/**
 * Maximum number of `arweave` (git SHA → Arweave txId) tags on ONE kind:30618
 * event, enforced on write (here and in `executePush`) and on read
 * (`parseRefsEvent`, rig-web's `parseRepoRefs`). Before this cap the map was
 * merged cumulatively on every push and bounded by nothing, so a large repo
 * eventually produced an event relays reject (#162).
 *
 * WHY 2000 — the arithmetic, in the event's JSON serialization:
 *
 *   one arweave tag  `["arweave","<40-hex sha>","<43-char txId>"]`
 *                    = 1 + 9 + 1 + 42 + 1 + 45 + 1 = 100 bytes, +1 comma = 101
 *   2000 of them     = 202,000 bytes ≈ 197 KiB   ← the map's whole budget
 *
 * Which limit is that 197 KiB measured against? rig's own relay
 * (`relay-ws.devnet.toonprotocol.dev`) advertises no `limitation` in its
 * NIP-11 document — probed 2026-09-17, the HTTPS origin answers `Upgrade
 * Required` rather than a relay-information document — so there is no
 * self-declared number to size against. The smallest limit any relay surveyed
 * for #153 declares is `relay.ngit.dev`'s 5 MiB message cap (probed the same
 * day), and that is the figure used here: the map is capped at under 4% of
 * it. That leaves the rest of the budget to the refs, which are the other
 * term in the same event:
 *
 *   `["r","<refname>","<sha>"]`, and `isSafeRefname` admits refnames up to
 *   1024 bytes → ≤ 1076 bytes each. Every rig reader ingests at most
 *   MAX_REFS_PER_EVENT = 1000 of them, and 1000 at that adversarial width is
 *   ≈ 1.03 MiB, so a readable event tops out near 1.23 MiB — a quarter of the
 *   5 MiB limit. With realistic refnames (≤ 64 bytes) a full-cap event is
 *   ≈ 260 KiB.
 *
 * NOTE the asymmetry: the 1000-ref cap is a READ-side constant. `buildRepoRefs`
 * still writes every ref it is given, so a repo with more than 1000 refs can
 * publish an event past the figures above — that is the ref tags' problem, not
 * the map's, and it is the ref shape work's to fix (#153 §Repository state).
 * This cap's job is to stop the OBJECT MAP being the term that grows without
 * limit, which it was: it grew with the object count, not the ref count.
 *
 * Dropping an entry loses nothing: the object is still on Arweave under its
 * `Git-SHA` / `Repo` tags and resolves through the GraphQL resolver, which is
 * already the documented fallback (`RemoteState.resolveMissing`). The map is
 * a cache, not the index — so push planning must treat "absent from the map"
 * as "ask the resolver", NEVER as "needs upload".
 */
export const MAX_ARWEAVE_TAGS_PER_EVENT = 2000;

/**
 * Build a kind:30618 repository refs/state event.
 *
 * Writes each ref in BOTH shapes, with identical SHAs (rig#157, dual-write
 * window): the NIP-34 shape `[<refPath>, <sha>]`, where the ref path IS the
 * tag name — what ngit, gitworkshop.dev and every other conformant client
 * read — alongside rig's legacy `["r", <refPath>, <sha>]`, so rig installs
 * older than this release keep fetching. Both shapes are read by
 * {@link parseStateRefTags} in `./nip34-refs.ts` and by any legacy-only
 * reader that only knows the `r` shape. `HEAD` and `arweave` tags are
 * unaffected by this dual-write. The legacy write is removed in a later,
 * separately ticketed change once older rig versions are unsupported.
 *
 * At most {@link MAX_ARWEAVE_TAGS_PER_EVENT} `arweave` tags are emitted; a
 * larger `arweaveMap` is truncated to its first entries in iteration order,
 * so the caller decides priority (see `executePush`) and a repo under the cap
 * publishes byte-identically to before the cap existed.
 *
 * @param repoId - Repository identifier (d tag, matches kind:30617)
 * @param refs - Map of ref paths to commit SHAs (e.g., { 'refs/heads/main': 'abc123' })
 * @param arweaveMap - Map of git SHAs to Arweave transaction IDs
 */
export function buildRepoRefs(
  repoId: string,
  refs: Record<string, string>,
  arweaveMap: Record<string, string> = {}
): UnsignedEvent {
  const tags: string[][] = [['d', repoId]];

  // Add ref tags, dual-written in both shapes (rig#157).
  for (const [refPath, commitSha] of Object.entries(refs)) {
    tags.push([refPath, commitSha]); // NIP-34 shape: ref path is the tag name
    tags.push(['r', refPath, commitSha]); // legacy shape, dual-write window
  }

  // Default HEAD to first ref (typically refs/heads/main)
  const firstRef = Object.keys(refs)[0];
  if (firstRef) {
    tags.push(['HEAD', `ref: ${firstRef}`]);
  }

  // Add arweave SHA-to-txId mapping tags, bounded (#162).
  const mapped = Object.entries(arweaveMap).slice(
    0,
    MAX_ARWEAVE_TAGS_PER_EVENT
  );
  for (const [sha, txId] of mapped) {
    tags.push(['arweave', sha, txId]);
  }

  return {
    kind: REPOSITORY_STATE_KIND,
    content: '',
    tags,
    created_at: Math.floor(Date.now() / 1000),
  };
}

// ---------------------------------------------------------------------------
// kind:1621 — Issue
// ---------------------------------------------------------------------------

/**
 * Build a kind:1621 issue event.
 *
 * @param repoOwnerPubkey - Pubkey of the repository owner
 * @param repoId - Repository identifier
 * @param title - Issue title (subject tag)
 * @param body - Issue body (Markdown content)
 * @param labels - Optional labels (t tags)
 */
export function buildIssue(
  repoOwnerPubkey: string,
  repoId: string,
  title: string,
  body: string,
  labels: string[] = []
): UnsignedEvent {
  const tags: string[][] = [
    ['a', `${REPOSITORY_ANNOUNCEMENT_KIND}:${repoOwnerPubkey}:${repoId}`],
    ['p', repoOwnerPubkey],
    ['subject', title],
    ...labels.map((label) => ['t', label]),
  ];

  return {
    kind: ISSUE_KIND,
    content: body,
    tags,
    created_at: Math.floor(Date.now() / 1000),
  };
}

// ---------------------------------------------------------------------------
// kind:1111 — NIP-22 comment (on an issue or patch)
// ---------------------------------------------------------------------------

/**
 * The event a comment thread hangs off: the kind:1621 issue or kind:1617
 * patch being discussed — NEVER the repository. Becomes the comment's
 * uppercase NIP-22 root scope (`E`/`K`/`P`).
 */
export interface CommentRoot {
  /** Event id of the issue/patch (uppercase `E`). */
  eventId: string;
  /** Kind of that event, e.g. 1621 or 1617 (uppercase `K`). */
  kind: number;
  /** Pubkey of that event's author (uppercase `P`). */
  authorPubkey: string;
}

/**
 * The kind:1111 comment being replied to, when the new comment is a nested
 * reply rather than a top-level comment. Becomes the lowercase parent
 * (`e`/`k`/`p`), with `k` always {@link COMMENT_KIND}.
 */
export interface CommentParent {
  /** Event id of the comment replied to (lowercase `e`). */
  eventId: string;
  /** Pubkey of that comment's author (lowercase `p`). */
  authorPubkey: string;
}

/**
 * Build a NIP-22 kind:1111 comment on a NIP-34 issue or patch (rig#159).
 *
 * NIP-22: "Comments MUST point to the root scope using uppercase tag names
 * (e.g. `K`, `E`, `A` or `I`)" and "MUST point to the parent item with
 * lowercase ones (e.g. `k`, `e`, `a` or `i`)", with "`P` for the root scope
 * and `p` for the author of the parent item". So:
 *
 * - top-level comment → parent === root: `e`/`k`/`p` repeat `E`/`K`/`P`;
 * - reply → `e` is the parent comment, `k` is `1111`, `p` its author, while
 *   `E`/`K`/`P` still name the issue/patch at the top of the thread.
 *
 * The repo coordinate rides along as an ordinary lowercase `a` tag so a
 * subscription can scope a whole repo's comments with one `#a` filter (spec
 * rig#153). It is deliberately NOT the NIP-22 parent pointer — the parent is
 * the `e` tag — so it is emitted last, after the six threading tags.
 *
 * @param repoOwnerPubkey - Pubkey of the repository owner
 * @param repoId - Repository identifier (NIP-34 `d` tag)
 * @param root - The issue/patch the thread hangs off
 * @param body - Comment body (Markdown content)
 * @param parent - The kind:1111 comment being replied to; omit for a
 *   top-level comment, whose parent is the root itself
 */
export function buildComment(
  repoOwnerPubkey: string,
  repoId: string,
  root: CommentRoot,
  body: string,
  parent?: CommentParent
): UnsignedEvent {
  const parentTags: string[][] =
    parent === undefined
      ? [
          ['e', root.eventId, '', root.authorPubkey],
          ['k', String(root.kind)],
          ['p', root.authorPubkey],
        ]
      : [
          ['e', parent.eventId, '', parent.authorPubkey],
          ['k', String(COMMENT_KIND)],
          ['p', parent.authorPubkey],
        ];

  return {
    kind: COMMENT_KIND,
    content: body,
    tags: [
      ['E', root.eventId, '', root.authorPubkey],
      ['K', String(root.kind)],
      ['P', root.authorPubkey],
      ...parentTags,
      ['a', `${REPOSITORY_ANNOUNCEMENT_KIND}:${repoOwnerPubkey}:${repoId}`],
    ],
    created_at: Math.floor(Date.now() / 1000),
  };
}

/**
 * Does `event` belong to the comment thread rooted at `rootEventId`?
 *
 * kind:1111 membership is decided by the **uppercase** `E` tag, matched
 * case-sensitively — the same rule rig already applies to kind:1619 PR
 * updates. A kind:1111 whose only match is a lowercase `e` is a reply to
 * something else and is NOT part of this thread. Legacy kind:1622 has no
 * uppercase form: its `e` tag is the thread root.
 */
export function commentBelongsToThread(
  event: { kind: number; tags: string[][] },
  rootEventId: string
): boolean {
  if (event.kind === COMMENT_KIND) {
    return event.tags.some((t) => t[0] === 'E' && t[1] === rootEventId);
  }
  if (event.kind === LEGACY_COMMENT_KIND) {
    return event.tags.some((t) => t[0] === 'e' && t[1] === rootEventId);
  }
  return false;
}

// ---------------------------------------------------------------------------
// kind:1617 — Patch / PR
// ---------------------------------------------------------------------------

/**
 * Build a kind:1617 patch event.
 *
 * The PR body/description travels in a dedicated `description` tag, NEVER in
 * `content` (#280): `content` is real `git format-patch` output that readers
 * pipe straight into `git am`, and git's patch-format detection hard-fails on
 * any leading prose (verified: "Patch format detection failed."). The tag
 * route keeps `git am` consumption intact while `rig pr show` and the
 * rig-web/views `parsePR` renderers surface the description.
 *
 * @param repoOwnerPubkey - Pubkey of the repository owner
 * @param repoId - Repository identifier
 * @param title - Patch/PR title (subject tag)
 * @param commits - Array of { sha, parentSha } for commit and parent-commit tags
 * @param branchTag - Branch name, written as the `branch-name` tag (#161) —
 *                    the wider NIP-34 ecosystem's spelling (used verbatim by
 *                    kind:1618 pull requests; confirmed against the NIP-34
 *                    source at implementation time). Never written to `t`:
 *                    that tag is reserved for real labels.
 * @param content - Real `git format-patch` text (NIP-34 patch body); defaults
 *                  to '' for callers that only reference commits by tag
 * @param description - PR body/cover text (`description` tag) — kept out of
 *                      `content` so `git am` still applies it
 */
export function buildPatch(
  repoOwnerPubkey: string,
  repoId: string,
  title: string,
  commits: { sha: string; parentSha: string }[],
  branchTag?: string,
  content = '',
  description?: string
): UnsignedEvent {
  const tags: string[][] = [
    ['a', `${REPOSITORY_ANNOUNCEMENT_KIND}:${repoOwnerPubkey}:${repoId}`],
    ['p', repoOwnerPubkey],
    ['subject', title],
  ];

  if (description !== undefined && description !== '') {
    tags.push(['description', description]);
  }

  for (const commit of commits) {
    tags.push(['commit', commit.sha]);
    tags.push(['parent-commit', commit.parentSha]);
  }

  if (branchTag) {
    tags.push(['branch-name', branchTag]);
  }

  return {
    kind: PATCH_KIND,
    content,
    tags,
    created_at: Math.floor(Date.now() / 1000),
  };
}

// ---------------------------------------------------------------------------
// kind:1630-1633 — Status
// ---------------------------------------------------------------------------

/** Status kinds: 1630 open, 1631 applied/merged, 1632 closed, 1633 draft. */
export type StatusKind =
  | typeof STATUS_OPEN_KIND
  | typeof STATUS_APPLIED_KIND
  | typeof STATUS_CLOSED_KIND
  | typeof STATUS_DRAFT_KIND;

/**
 * Build a status event (kind 1630-1633).
 *
 * rig#153/#160: the `e` tag carries the NIP-10 `root` marker
 * (`["e", <target>, "", "root"]`) rather than the old bare `["e", <id>]`, so
 * clients that resolve a status's root via the marker (ngit's
 * `get_event_root`, among others) honor rig statuses. The repo `a` tag rides
 * along so a status stream can be scoped to the repository without first
 * resolving the target. Readers (this package's tracker and rig-web's
 * parsers) accept BOTH this marker form and the legacy bare form — a status
 * is matched by `tags.find(t => t[0] === 'e')?.[1] === targetEventId`
 * regardless of any trailing marker elements.
 *
 * @param repoOwnerPubkey - Pubkey of the repository owner
 * @param repoId - Repository identifier
 * @param targetEventId - Event ID of the patch, PR, or issue being updated
 * @param statusKind - One of 1630 (open), 1631 (applied), 1632 (closed), 1633 (draft)
 * @param targetPubkey - Optional pubkey of the target event author (p tag per NIP-34 StatusEvent), when known
 */
export function buildStatus(
  repoOwnerPubkey: string,
  repoId: string,
  targetEventId: string,
  statusKind: StatusKind,
  targetPubkey?: string
): UnsignedEvent {
  const tags: string[][] = [
    ['e', targetEventId, '', 'root'],
    ['a', `${REPOSITORY_ANNOUNCEMENT_KIND}:${repoOwnerPubkey}:${repoId}`],
  ];
  if (targetPubkey) {
    tags.push(['p', targetPubkey]);
  }
  return {
    kind: statusKind,
    content: '',
    tags,
    created_at: Math.floor(Date.now() / 1000),
  };
}
