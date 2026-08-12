/**
 * NIP-34 pull-request kinds: kind:1618 (PR) and kind:1619 (PR update).
 *
 * Ported with the parsers from `@toon-protocol/views@0.36.9` (rig#40). The
 * version rig-web previously depended on (`^0.20.5`) predates these kinds, so
 * this coverage is NEW here — it is kept in its own file rather than folded
 * into `nip34-parsers.test.ts` so the existing 53-test suite stays untouched
 * and reviewable.
 */

import { describe, it, expect } from 'vitest';
import {
  type NostrEvent,
  parsePR,
  parsePRUpdate,
  resolvePRTip,
} from './nip34-parsers.js';

function evt(partial: Partial<NostrEvent> & { kind: number }): NostrEvent {
  return {
    id: partial.id ?? 'id',
    pubkey: partial.pubkey ?? 'pk',
    created_at: partial.created_at ?? 1,
    kind: partial.kind,
    tags: partial.tags ?? [],
    content: partial.content ?? '',
    sig: partial.sig ?? 'sig',
  };
}

describe('nip34 pull-request kinds (1618/1619, #446)', () => {
  // Fixture shapes lifted from block/buzz's real event builders
  // (crates/buzz-sdk/src/builders.rs `git_pr_happy_path` /
  // `git_pr_update_happy_path` tests), not hand-invented.
  const owner = 'a'.repeat(64);

  it('parses a kind:1618 pull request (Buzz builder shape)', () => {
    const pr = parsePR(
      evt({
        kind: 1618,
        pubkey: 'd'.repeat(64),
        created_at: 100,
        tags: [
          ['a', `30617:${owner}:repo`],
          ['p', owner],
          ['subject', 'Add feature X'],
          ['t', 'enhancement'],
          ['c', 'c'.repeat(40)],
          ['h', '11111111-1111-4111-8111-111111111111'],
          ['branch-name', 'feat/x'],
          ['clone', 'https://example.com/repo.git'],
        ],
        content: 'PR body',
      })
    );
    expect(pr?.sourceKind).toBe(1618);
    expect(pr?.title).toBe('Add feature X');
    expect(pr?.content).toBe('PR body');
    expect(pr?.tipCommit).toBe('c'.repeat(40));
    expect(pr?.cloneUrls).toEqual(['https://example.com/repo.git']);
    expect(pr?.branchName).toBe('feat/x');
    expect(pr?.labels).toEqual(['enhancement']);
    expect(pr?.mergeBase).toBeUndefined();
  });

  it('collects every url out of a multi-value clone tag (["clone", url1, url2, ...])', () => {
    const pr = parsePR(
      evt({
        kind: 1618,
        tags: [
          ['subject', 's'],
          ['c', 'c'.repeat(40)],
          ['clone', 'https://a.example/repo.git', 'https://b.example/repo.git'],
        ],
      })
    );
    expect(pr?.cloneUrls).toEqual([
      'https://a.example/repo.git',
      'https://b.example/repo.git',
    ]);
  });

  it('rejects anything that is not 1617 or 1618', () => {
    expect(parsePR(evt({ kind: 1619 }))).toBeNull();
    expect(parsePR(evt({ kind: 1 }))).toBeNull();
  });

  it('parsePRUpdate resolves the PR id from the uppercase E tag (Buzz builder shape)', () => {
    const update = parsePRUpdate(
      evt({
        kind: 1619,
        pubkey: 'b'.repeat(64),
        created_at: 200,
        tags: [
          ['E', 'prEvt1'],
          ['P', 'b'.repeat(64)],
          ['c', 'd'.repeat(40)],
          ['merge-base', 'e'.repeat(40)],
          ['clone', 'https://example.com/repo.git'],
        ],
        content: 'rebased',
      })
    );
    expect(update?.prEventId).toBe('prEvt1');
    expect(update?.tipCommit).toBe('d'.repeat(40));
    expect(update?.cloneUrls).toEqual(['https://example.com/repo.git']);
    expect(update?.mergeBase).toBe('e'.repeat(40));
    expect(update?.authorPubkey).toBe('b'.repeat(64));
    expect(update?.createdAt).toBe(200);
  });

  it('is case-sensitive: a lowercase e tag does NOT satisfy the NIP-22 E reference', () => {
    const update = parsePRUpdate(
      evt({ kind: 1619, tags: [['e', 'prEvt1'], ['c', 'd'.repeat(40)]] })
    );
    expect(update).toBeNull();
  });

  it('rejects the wrong kind', () => {
    expect(parsePRUpdate(evt({ kind: 1618, tags: [['E', 'prEvt1']] }))).toBeNull();
  });

  it('resolvePRTip returns the latest AUTHORIZED update by created_at (#446, mirrors #287)', () => {
    const maintainer = 'b'.repeat(64);
    const stranger = 'f'.repeat(64);
    const authorized = new Set([owner, maintainer]);

    const tip = resolvePRTip(
      'prEvt1',
      [
        evt({
          kind: 1619,
          pubkey: maintainer,
          created_at: 10,
          tags: [['E', 'prEvt1'], ['c', 'c'.repeat(40)], ['clone', 'https://x/y.git']],
        }),
        // A funded stranger publishes a LATER update — it must NOT win.
        evt({
          kind: 1619,
          pubkey: stranger,
          created_at: 99,
          tags: [['E', 'prEvt1'], ['c', 'f'.repeat(40)], ['clone', 'https://evil/y.git']],
        }),
      ],
      authorized
    );
    expect(tip?.tipCommit).toBe('c'.repeat(40));
  });

  it('resolvePRTip picks the newest authorized update, ignoring other PRs', () => {
    const authorized = new Set([owner]);
    const update = (createdAt: number, prId: string, tip: string) =>
      evt({
        kind: 1619,
        pubkey: owner,
        created_at: createdAt,
        tags: [['E', prId], ['c', tip]],
      });

    // Out of order on purpose, plus an update for a DIFFERENT PR at the
    // highest created_at — neither may decide prEvt1's tip.
    const tip = resolvePRTip(
      'prEvt1',
      [
        update(20, 'prEvt1', 'b'.repeat(40)),
        update(30, 'prEvt2', 'd'.repeat(40)),
        update(10, 'prEvt1', 'a'.repeat(40)),
      ],
      authorized
    );
    expect(tip?.tipCommit).toBe('b'.repeat(40));
    expect(tip?.prEventId).toBe('prEvt1');
  });

  it('resolvePRTip returns null when nothing authorized references the PR', () => {
    expect(resolvePRTip('prEvt1', [], new Set([owner]))).toBeNull();
  });
});
