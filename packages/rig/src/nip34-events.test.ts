/**
 * Unit tests for pure NIP-34 event builders (nip34-events.ts).
 *
 * Ported from packages/rig-web/tests/e2e/seed/__tests__/event-builders.test.ts
 * (#223), plus coverage for the new optional buildPatch `content` parameter.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  COMMENT_KIND,
  MAINTAINERS_TAG,
  PAYOUT_TAG,
  REPOSITORY_STATE_KIND,
  authorizedStatusAuthors,
  buildComment,
  buildIssue,
  buildPatch,
  buildRepoAnnouncement,
  buildRepoRefs,
  buildStatus,
  parseMaintainers,
  parsePayout,
} from './nip34-events.js';

const OWNER_PUBKEY =
  '55c2a467881059a942fdc6908b041273885b8720bfa8fcf2f5f9c20a73b0964d';
const AUTHOR_PUBKEY =
  '7937ffc0c5a0238768da798d26394a33b554926d739c445fd508e36642ebc286';
const EVENT_ID =
  'deadbeef1234567890abcdef1234567890abcdef1234567890abcdef12345678';

// A real EIP-55 checksummed address (Vitalik's, widely used as a test fixture).
const EVM_ADDRESS = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';

describe('buildRepoAnnouncement (kind:30617)', () => {
  it('builds a repo announcement with d/name/description tags', () => {
    const event = buildRepoAnnouncement(
      'hello-toon',
      'Hello TOON',
      'A demo repo'
    );

    expect(event.kind).toBe(30617);
    expect(event.tags).toEqual(
      expect.arrayContaining([
        ['d', 'hello-toon'],
        ['name', 'Hello TOON'],
        ['description', 'A demo repo'],
      ])
    );
  });

  it('returns an UnsignedEvent (no id, no sig, no pubkey)', () => {
    const event = buildRepoAnnouncement('test', 'Test', 'Desc');

    expect((event as unknown as Record<string, unknown>)['id']).toBeUndefined();
    expect((event as unknown as Record<string, unknown>)['sig']).toBeUndefined();
    expect((event as unknown as Record<string, unknown>)['pubkey']).toBeUndefined();
  });

  it('includes a created_at timestamp', () => {
    const before = Math.floor(Date.now() / 1000);
    const event = buildRepoAnnouncement('test', 'Test', 'Desc');
    const after = Math.floor(Date.now() / 1000);

    expect(event.created_at).toBeGreaterThanOrEqual(before);
    expect(event.created_at).toBeLessThanOrEqual(after);
  });

  it('omits the maintainers tag when none are given (owner-only)', () => {
    const event = buildRepoAnnouncement('test', 'Test', 'Desc');
    expect(event.tags.some((t) => t[0] === MAINTAINERS_TAG)).toBe(false);
  });

  it('emits ONE maintainers tag and round-trips via parseMaintainers (#287)', () => {
    const event = buildRepoAnnouncement('test', 'Test', 'Desc', [
      OWNER_PUBKEY,
      AUTHOR_PUBKEY,
      // duplicate + uppercase → deduped + lowercased
      AUTHOR_PUBKEY.toUpperCase(),
      'not-hex', // dropped
    ]);
    const tags = event.tags.filter((t) => t[0] === MAINTAINERS_TAG);
    expect(tags).toHaveLength(1);
    expect(tags[0]).toEqual([MAINTAINERS_TAG, OWNER_PUBKEY, AUTHOR_PUBKEY]);
    expect(parseMaintainers(event.tags)).toEqual([OWNER_PUBKEY, AUTHOR_PUBKEY]);
  });
});

describe('maintainer authority helpers (#287)', () => {
  it('authorizedStatusAuthors = owner ∪ declared maintainers (lowercased)', () => {
    const tags = [
      ['d', 'r'],
      [MAINTAINERS_TAG, AUTHOR_PUBKEY],
    ];
    const set = authorizedStatusAuthors(OWNER_PUBKEY, tags);
    expect(set.has(OWNER_PUBKEY)).toBe(true); // owner always implicit
    expect(set.has(AUTHOR_PUBKEY)).toBe(true);
    expect(set.has(EVENT_ID)).toBe(false); // a stranger
  });

  it('owner is authorized even with no maintainers tag', () => {
    const set = authorizedStatusAuthors(OWNER_PUBKEY, [['d', 'r']]);
    expect([...set]).toEqual([OWNER_PUBKEY]);
  });

  it('parseMaintainers tolerates repeated tags + non-hex noise', () => {
    expect(
      parseMaintainers([
        [MAINTAINERS_TAG, OWNER_PUBKEY, 'garbage'],
        [MAINTAINERS_TAG, AUTHOR_PUBKEY],
      ])
    ).toEqual([OWNER_PUBKEY, AUTHOR_PUBKEY]);
  });
});

describe('payout pointer (rig#92)', () => {
  it('buildRepoAnnouncement omits the payout tag when none is given', () => {
    const event = buildRepoAnnouncement('test', 'Test', 'Desc');
    expect(event.tags.some((t) => t[0] === PAYOUT_TAG)).toBe(false);
  });

  it('buildRepoAnnouncement emits the payout tag and round-trips via parsePayout', () => {
    const event = buildRepoAnnouncement('test', 'Test', 'Desc', [], {
      chain: 'evm',
      address: EVM_ADDRESS,
    });
    const tags = event.tags.filter((t) => t[0] === PAYOUT_TAG);
    expect(tags).toEqual([[PAYOUT_TAG, 'evm', EVM_ADDRESS]]);
    expect(parsePayout(event.tags)).toEqual({
      chain: 'evm',
      address: EVM_ADDRESS,
    });
  });

  it('buildRepoAnnouncement omits the payout tag when explicitly null (clear)', () => {
    const event = buildRepoAnnouncement('test', 'Test', 'Desc', [], null);
    expect(event.tags.some((t) => t[0] === PAYOUT_TAG)).toBe(false);
  });

  it('parsePayout: absent — no payout tag returns null', () => {
    expect(parsePayout([['d', 'test']])).toBeNull();
  });

  it('parsePayout: present — normalizes a lowercase (unchecksummed) address', () => {
    expect(
      parsePayout([[PAYOUT_TAG, 'evm', EVM_ADDRESS.toLowerCase()]])
    ).toEqual({ chain: 'evm', address: EVM_ADDRESS });
  });

  it('parsePayout: malformed shape — non-hex address is ignored (null, warns)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(parsePayout([[PAYOUT_TAG, 'evm', 'not-an-address']])).toBeNull();
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it('parsePayout: malformed checksum — mixed-case address failing EIP-55 is ignored', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const badChecksum =
      EVM_ADDRESS.slice(0, -1) +
      (EVM_ADDRESS.slice(-1) === 'a' ? 'A' : 'a');
    expect(parsePayout([[PAYOUT_TAG, 'evm', badChecksum]])).toBeNull();
    warn.mockRestore();
  });

  it('parsePayout: non-evm chain is ignored (v1 accepts evm only)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(
      parsePayout([[PAYOUT_TAG, 'sol', EVM_ADDRESS]])
    ).toBeNull();
    warn.mockRestore();
  });

  it('parsePayout: multiple tags — first valid wins, rest ignored with a warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const second = '0x' + '11'.repeat(20);
    const result = parsePayout([
      [PAYOUT_TAG, 'evm', EVM_ADDRESS],
      [PAYOUT_TAG, 'evm', second],
    ]);
    expect(result).toEqual({ chain: 'evm', address: EVM_ADDRESS });
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toContain('ignoring 1');
    warn.mockRestore();
  });
});

describe('buildRepoRefs (kind:30618)', () => {
  it('builds repo refs with r/HEAD/arweave tags', () => {
    const refs = { 'refs/heads/main': 'abc123' };
    const arweaveMap = { abc123: 'arweave-tx-1' };
    const event = buildRepoRefs('hello-toon', refs, arweaveMap);

    expect(event.kind).toBe(30618);
    expect(REPOSITORY_STATE_KIND).toBe(30618);
    expect(event.tags).toEqual(
      expect.arrayContaining([
        ['d', 'hello-toon'],
        ['r', 'refs/heads/main', 'abc123'],
        ['HEAD', 'ref: refs/heads/main'],
        ['arweave', 'abc123', 'arweave-tx-1'],
      ])
    );
  });

  it('supports multiple refs and arweave mappings', () => {
    const refs = {
      'refs/heads/main': 'abc123',
      'refs/heads/dev': 'def456',
    };
    const arweaveMap = {
      abc123: 'arweave-tx-1',
      def456: 'arweave-tx-2',
    };

    const event = buildRepoRefs('hello-toon', refs, arweaveMap);

    expect(event.tags).toEqual(
      expect.arrayContaining([
        ['r', 'refs/heads/main', 'abc123'],
        ['r', 'refs/heads/dev', 'def456'],
        ['arweave', 'abc123', 'arweave-tx-1'],
        ['arweave', 'def456', 'arweave-tx-2'],
      ])
    );
  });
});

describe('buildIssue (kind:1621)', () => {
  it('builds an issue with a/p/subject/t tags and body content', () => {
    const event = buildIssue(
      OWNER_PUBKEY,
      'hello-toon',
      'Bug title',
      'Bug body',
      ['bug']
    );

    expect(event.kind).toBe(1621);
    expect(event.content).toBe('Bug body');
    expect(event.tags).toEqual(
      expect.arrayContaining([
        ['a', `30617:${OWNER_PUBKEY}:hello-toon`],
        ['p', OWNER_PUBKEY],
        ['subject', 'Bug title'],
        ['t', 'bug'],
      ])
    );
  });

  it('builds an issue with multiple labels as separate t tags', () => {
    const event = buildIssue(
      OWNER_PUBKEY,
      'hello-toon',
      'Multi-label',
      'body',
      ['bug', 'urgent', 'help-wanted']
    );

    const tTags = event.tags.filter((t) => t[0] === 't');
    expect(tTags).toHaveLength(3);
    expect(tTags).toEqual(
      expect.arrayContaining([
        ['t', 'bug'],
        ['t', 'urgent'],
        ['t', 'help-wanted'],
      ])
    );
  });

  it('builds an issue with no labels by default', () => {
    const event = buildIssue(OWNER_PUBKEY, 'hello-toon', 'No labels', 'body');

    const tTags = event.tags.filter((t) => t[0] === 't');
    expect(tTags).toHaveLength(0);
  });
});

describe('buildComment (kind:1622)', () => {
  it('builds a comment with a/e/p tags', () => {
    const event = buildComment(
      OWNER_PUBKEY,
      'hello-toon',
      EVENT_ID,
      AUTHOR_PUBKEY,
      'Comment body',
      'reply'
    );

    expect(event.kind).toBe(1622);
    expect(COMMENT_KIND).toBe(1622);
    expect(event.content).toBe('Comment body');
    expect(event.tags).toEqual(
      expect.arrayContaining([
        ['a', `30617:${OWNER_PUBKEY}:hello-toon`],
        ['p', AUTHOR_PUBKEY],
      ])
    );
    const eTag = event.tags.find((t) => t[0] === 'e' && t[1] === EVENT_ID);
    expect(eTag).toBeDefined();
  });

  it("defaults to the 'reply' marker when marker is omitted", () => {
    const event = buildComment(
      OWNER_PUBKEY,
      'hello-toon',
      EVENT_ID,
      AUTHOR_PUBKEY,
      'Default marker'
    );

    const eTag = event.tags.find((t) => t[0] === 'e' && t[1] === EVENT_ID);
    expect(eTag).toBeDefined();
    expect(eTag?.[3]).toBe('reply');
  });

  it("builds a comment with the 'root' marker", () => {
    const event = buildComment(
      OWNER_PUBKEY,
      'hello-toon',
      EVENT_ID,
      AUTHOR_PUBKEY,
      'Root comment',
      'root'
    );

    const eTag = event.tags.find((t) => t[0] === 'e' && t[1] === EVENT_ID);
    expect(eTag).toBeDefined();
    expect(eTag?.[3]).toBe('root');
  });
});

describe('buildPatch (kind:1617)', () => {
  const commits = [{ sha: 'abc123', parentSha: 'def456' }];

  it('builds a patch with a/p/subject/commit/parent-commit/t tags', () => {
    const event = buildPatch(
      OWNER_PUBKEY,
      'hello-toon',
      'Fix readme',
      commits,
      'feature/fix'
    );

    expect(event.kind).toBe(1617);
    expect(event.tags).toEqual(
      expect.arrayContaining([
        ['a', `30617:${OWNER_PUBKEY}:hello-toon`],
        ['p', OWNER_PUBKEY],
        ['subject', 'Fix readme'],
        ['commit', 'abc123'],
        ['parent-commit', 'def456'],
        ['t', 'feature/fix'],
      ])
    );
  });

  it('omits the branch t tag when branchTag is not provided', () => {
    const event = buildPatch(OWNER_PUBKEY, 'hello-toon', 'Fix readme', commits);

    const tTags = event.tags.filter((t) => t[0] === 't');
    expect(tTags).toHaveLength(0);
  });

  it('defaults to empty content (seed pipeline behavior)', () => {
    const event = buildPatch(OWNER_PUBKEY, 'hello-toon', 'Fix readme', commits);

    expect(event.content).toBe('');
  });

  it('carries the PR body in a description tag, never in content (#280)', () => {
    const event = buildPatch(
      OWNER_PUBKEY,
      'hello-toon',
      'Fix readme',
      commits,
      undefined,
      'From abc123 Mon Sep 17 00:00:00 2001\n',
      'Closes #7 — the why.'
    );

    expect(event.tags).toContainEqual(['description', 'Closes #7 — the why.']);
    // Content stays pipeable into `git am`: pure format-patch text.
    expect(event.content).toBe('From abc123 Mon Sep 17 00:00:00 2001\n');
  });

  it('omits the description tag when the description is absent or empty', () => {
    const none = buildPatch(OWNER_PUBKEY, 'hello-toon', 'T', commits);
    const empty = buildPatch(
      OWNER_PUBKEY,
      'hello-toon',
      'T',
      commits,
      undefined,
      '',
      ''
    );
    for (const event of [none, empty]) {
      expect(event.tags.filter((t) => t[0] === 'description')).toHaveLength(0);
    }
  });

  it('carries real git format-patch text when content is provided', () => {
    const patchText = [
      'From abc123 Mon Sep 17 00:00:00 2001',
      'From: Alice <alice@nostr>',
      'Subject: [PATCH] Fix readme',
      '',
      '--- a/README.md',
      '+++ b/README.md',
      '@@ -1 +1 @@',
      '-hello',
      '+hello world',
      '',
    ].join('\n');

    const event = buildPatch(
      OWNER_PUBKEY,
      'hello-toon',
      'Fix readme',
      commits,
      'feature/fix',
      patchText
    );

    expect(event.kind).toBe(1617);
    expect(event.content).toBe(patchText);
    // Tags are unaffected by content
    expect(event.tags).toEqual(
      expect.arrayContaining([
        ['subject', 'Fix readme'],
        ['commit', 'abc123'],
        ['t', 'feature/fix'],
      ])
    );
  });
});

describe('buildStatus (kinds 1630-1633)', () => {
  it('builds each status kind with an e tag', () => {
    for (const statusKind of [1630, 1631, 1632, 1633] as const) {
      const event = buildStatus(EVENT_ID, statusKind);
      expect(event.kind).toBe(statusKind);
      expect(event.tags).toEqual(expect.arrayContaining([['e', EVENT_ID]]));
    }
  });

  it('includes a p tag when targetPubkey is provided', () => {
    const event = buildStatus(EVENT_ID, 1631, OWNER_PUBKEY);

    expect(event.tags).toEqual(
      expect.arrayContaining([
        ['e', EVENT_ID],
        ['p', OWNER_PUBKEY],
      ])
    );
  });

  it('omits the p tag when targetPubkey is not provided', () => {
    const event = buildStatus(EVENT_ID, 1630);

    const pTags = event.tags.filter((t) => t[0] === 'p');
    expect(pTags).toHaveLength(0);
  });
});
