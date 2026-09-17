/**
 * Unit tests for pure NIP-34 event builders (nip34-events.ts).
 *
 * Ported from packages/rig-web/tests/e2e/seed/__tests__/event-builders.test.ts
 * (#223), plus coverage for the new optional buildPatch `content` parameter.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  COMMENT_KIND,
  LEGACY_COMMENT_KIND,
  MAINTAINERS_TAG,
  MAX_ARWEAVE_TAGS_PER_EVENT,
  PAYOUT_TAG,
  REPOSITORY_STATE_KIND,
  authorizedStatusAuthors,
  buildComment,
  buildIssue,
  buildPatch,
  buildRepoRefs,
  buildStatus,
  commentBelongsToThread,
  parseMaintainers,
  parsePayout,
} from './nip34-events.js';
import { parseStateRefTags } from './nip34-refs.js';
import {
  NGIT_COMMENT_THREAD_COMMENTS,
  NGIT_COMMENT_THREAD_COMMENT_EVENT_IDS,
  NGIT_COMMENT_THREAD_NESTED_REPLY_ID,
  NGIT_COMMENT_THREAD_NESTED_REPLY_PARENT_ID,
  NGIT_COMMENT_THREAD_ROOT,
  NGIT_COMMENT_THREAD_ROOT_EVENT_ID,
} from './nip34-fixtures/index.js';
import {
  amendRepoAnnouncement,
  announcedEuc,
  buildRepoAnnouncement,
  conformanceEdits,
  diffAnnouncementTags,
  earliestUniqueCommit,
} from './repo-announcement.js';
import { describeAnnouncementDiff } from './cli/render.js';

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

describe('amendRepoAnnouncement (kind:30617, #154)', () => {
  const EUC = 'c0ffee'.padEnd(40, '0');

  /**
   * An announcement as another NIP-34 client (ngit) writes it: the tags rig
   * models, plus role tags, `clone`, `blossoms`, `t`, `alt` and a tag rig has
   * never heard of. Frozen so one test can never mutate the shared fixture.
   */
  const foreign = Object.freeze({
    tags: [
      ['d', 'hello-toon'],
      ['name', 'Hello TOON'],
      ['description', 'A demo repo'],
      ['clone', 'https://relay.ngit.dev/npub1abc/hello-toon.git'],
      ['relays', 'wss://relay.ngit.dev', 'wss://relay.damus.io'],
      ['web', 'https://gitworkshop.dev/r/hello-toon'],
      ['r', EUC, 'euc'],
      [MAINTAINERS_TAG, OWNER_PUBKEY],
      ['M', OWNER_PUBKEY],
      ['m', AUTHOR_PUBKEY],
      ['o', AUTHOR_PUBKEY],
      ['blossoms', 'https://blossom.example'],
      ['t', 'rust'],
      ['alt', 'git repository: hello-toon'],
      ['x-rig-knows-nothing', 'keep', 'me'],
    ] as string[][],
    content: 'freeform',
  });

  const UNKNOWN_NAMES = [
    'clone',
    'M',
    'm',
    'o',
    'blossoms',
    't',
    'alt',
    'x-rig-knows-nothing',
  ];

  it('carries every unknown tag over verbatim, in original relative order', () => {
    const event = amendRepoAnnouncement(foreign, {
      repoId: 'hello-toon',
      maintainers: [OWNER_PUBKEY, AUTHOR_PUBKEY],
    });

    expect(event.tags.filter((t) => UNKNOWN_NAMES.includes(t[0] ?? ''))).toEqual(
      [
        ['clone', 'https://relay.ngit.dev/npub1abc/hello-toon.git'],
        ['M', OWNER_PUBKEY],
        ['m', AUTHOR_PUBKEY],
        ['o', AUTHOR_PUBKEY],
        ['blossoms', 'https://blossom.example'],
        ['t', 'rust'],
        ['alt', 'git repository: hello-toon'],
        ['x-rig-knows-nothing', 'keep', 'me'],
      ]
    );
  });

  it('rewrites the edited field and leaves every other tag untouched', () => {
    const event = amendRepoAnnouncement(foreign, {
      repoId: 'hello-toon',
      maintainers: [AUTHOR_PUBKEY],
    });

    expect(event.kind).toBe(30617);
    expect(event.tags).toEqual([
      ['d', 'hello-toon'],
      ['name', 'Hello TOON'],
      ['description', 'A demo repo'],
      ['clone', 'https://relay.ngit.dev/npub1abc/hello-toon.git'],
      ['relays', 'wss://relay.ngit.dev', 'wss://relay.damus.io'],
      ['web', 'https://gitworkshop.dev/r/hello-toon'],
      ['r', EUC, 'euc'],
      [MAINTAINERS_TAG, AUTHOR_PUBKEY],
      ['M', OWNER_PUBKEY],
      ['m', AUTHOR_PUBKEY],
      ['o', AUTHOR_PUBKEY],
      ['blossoms', 'https://blossom.example'],
      ['t', 'rust'],
      ['alt', 'git repository: hello-toon'],
      ['x-rig-knows-nothing', 'keep', 'me'],
    ]);
  });

  it('preserves the current content (a republish is not a truncation)', () => {
    const event = amendRepoAnnouncement(foreign, { repoId: 'hello-toon' });
    expect(event.content).toBe('freeform');
  });

  it('drops a known tag whose edit clears it, keeping everything else', () => {
    const event = amendRepoAnnouncement(foreign, {
      repoId: 'hello-toon',
      maintainers: [],
    });
    expect(event.tags.some((t) => t[0] === MAINTAINERS_TAG)).toBe(false);
    expect(event.tags).toContainEqual(['M', OWNER_PUBKEY]);
    expect(event.tags).toContainEqual(['r', EUC, 'euc']);
  });

  it('an `r` tag that is not the euc marker is unknown, so it survives', () => {
    const event = amendRepoAnnouncement(
      {
        tags: [
          ['d', 'x'],
          ['r', 'refs/heads/main', 'abc'],
        ],
      },
      { repoId: 'x', earliestUniqueCommit: EUC }
    );
    expect(event.tags).toEqual([
      ['d', 'x'],
      ['r', 'refs/heads/main', 'abc'],
      ['r', EUC, 'euc'],
    ]);
  });

  it('collapses repeated known tags into the single edited one', () => {
    const event = amendRepoAnnouncement(
      {
        tags: [
          ['d', 'x'],
          [MAINTAINERS_TAG, OWNER_PUBKEY],
          ['alt', 'keep'],
          [MAINTAINERS_TAG, AUTHOR_PUBKEY],
        ],
      },
      { repoId: 'x', maintainers: [AUTHOR_PUBKEY] }
    );
    expect(event.tags).toEqual([
      ['d', 'x'],
      [MAINTAINERS_TAG, AUTHOR_PUBKEY],
      ['alt', 'keep'],
    ]);
  });

  it('with no current announcement, emits the canonical tag order', () => {
    const event = amendRepoAnnouncement(null, {
      repoId: 'hello-toon',
      name: 'Hello TOON',
      description: 'A demo repo',
      maintainers: [OWNER_PUBKEY],
      payout: { chain: 'evm', address: EVM_ADDRESS },
      relays: ['wss://relay.test.example'],
      web: ['https://rig.example/r/hello-toon'],
      earliestUniqueCommit: EUC,
    });
    expect(event.tags).toEqual([
      ['d', 'hello-toon'],
      ['name', 'Hello TOON'],
      ['description', 'A demo repo'],
      [MAINTAINERS_TAG, OWNER_PUBKEY],
      [PAYOUT_TAG, 'evm', EVM_ADDRESS],
      ['relays', 'wss://relay.test.example'],
      ['web', 'https://rig.example/r/hello-toon'],
      ['r', EUC, 'euc'],
    ]);
    expect(event.content).toBe('');
  });

  it('is what buildRepoAnnouncement is: a fresh amendment', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      expect(
        buildRepoAnnouncement('test', 'Test', 'Desc', [OWNER_PUBKEY], {
          chain: 'evm',
          address: EVM_ADDRESS,
        })
      ).toEqual(
        amendRepoAnnouncement(null, {
          repoId: 'test',
          name: 'Test',
          description: 'Desc',
          maintainers: [OWNER_PUBKEY],
          payout: { chain: 'evm', address: EVM_ADDRESS },
        })
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('earliestUniqueCommit (#158)', () => {
  const A = 'a'.repeat(40);
  const B = 'b'.repeat(40);
  const C = 'c'.repeat(40);

  /** A reader whose `--all` and `HEAD` answers are fixed per test. */
  function reader(all: string[], onHead: string[] = []) {
    return {
      rootCommits: async (rev?: string) => (rev === undefined ? all : onHead),
    };
  }

  it('is the only root of a linear history', async () => {
    await expect(earliestUniqueCommit(reader([B]))).resolves.toBe(B);
  });

  it('is null for a repo with no commits', async () => {
    await expect(earliestUniqueCommit(reader([]))).resolves.toBeNull();
  });

  it('prefers a root reachable from the default branch over an orphan one', async () => {
    // `A` sorts lowest but is NOT on the default branch — reachability wins.
    await expect(earliestUniqueCommit(reader([A, C], [C]))).resolves.toBe(C);
  });

  it('breaks a remaining tie on the lexicographically lowest SHA', async () => {
    await expect(earliestUniqueCommit(reader([C, B, A], [C, A]))).resolves.toBe(
      A
    );
  });

  it('falls back to all roots when HEAD resolves to nothing', async () => {
    await expect(earliestUniqueCommit(reader([C, B], []))).resolves.toBe(B);
  });

  it('does not depend on rev-list ordering — the same set gives the same SHA', async () => {
    const first = await earliestUniqueCommit(reader([A, B, C], [A, B, C]));
    const second = await earliestUniqueCommit(reader([C, B, A], [C, B, A]));
    expect(first).toBe(second);
    expect(first).toBe(A);
  });
});

describe('announcedEuc / conformanceEdits (#158)', () => {
  const LOCAL_EUC = 'a'.repeat(40);
  const ANNOUNCED = 'b'.repeat(40);
  const FACTS = {
    relays: ['wss://relay.test.example'],
    web: 'https://rig.example/#/npub1/demo',
    earliestUniqueCommit: LOCAL_EUC,
  };

  it('reads the euc an announcement already declares', () => {
    expect(
      announcedEuc({
        tags: [
          ['d', 'demo'],
          ['r', 'refs/heads/main', 'deadbeef'],
          ['r', ANNOUNCED, 'euc'],
        ],
      })
    ).toBe(ANNOUNCED);
    expect(announcedEuc({ tags: [['d', 'demo']] })).toBeNull();
    expect(announcedEuc(null)).toBeNull();
  });

  it('backfills all three tags on an announcement that has none', () => {
    expect(conformanceEdits({ tags: [['d', 'demo']] }, FACTS)).toEqual({
      relays: FACTS.relays,
      web: [FACTS.web],
      earliestUniqueCommit: LOCAL_EUC,
    });
  });

  it('NEVER recomputes an announced euc, even when local git disagrees', () => {
    const edits = conformanceEdits(
      { tags: [['d', 'demo'], ['r', ANNOUNCED, 'euc']] },
      FACTS
    );
    // Omitted → amendRepoAnnouncement leaves the slot exactly as it is.
    expect('earliestUniqueCommit' in edits).toBe(false);
    const event = amendRepoAnnouncement(
      { tags: [['d', 'demo'], ['r', ANNOUNCED, 'euc']] },
      { repoId: 'demo', ...edits }
    );
    expect(event.tags).toContainEqual(['r', ANNOUNCED, 'euc']);
    expect(event.tags).not.toContainEqual(['r', LOCAL_EUC, 'euc']);
  });

  it('omits the euc when there is no local repo to compute one from', () => {
    const edits = conformanceEdits(null, { ...FACTS, earliestUniqueCommit: null });
    expect('earliestUniqueCommit' in edits).toBe(false);
    expect(edits.relays).toEqual(FACTS.relays);
  });

  it('omits web when no viewer URL can be derived, and relays when there are none', () => {
    expect(conformanceEdits(null, { relays: [], web: null, earliestUniqueCommit: null })).toEqual(
      {}
    );
  });

  it('UNIONS relays and web with what another client already announced', () => {
    const current = {
      tags: [
        ['d', 'demo'],
        ['relays', 'wss://ngit.example', 'wss://shared.example'],
        ['web', 'https://gitworkshop.example/demo'],
      ],
    };
    const edits = conformanceEdits(current, {
      ...FACTS,
      relays: ['wss://shared.example', 'wss://relay.test.example'],
    });
    // ngit's entries survive, in their original order; rig's are appended once.
    expect(edits.relays).toEqual([
      'wss://ngit.example',
      'wss://shared.example',
      'wss://relay.test.example',
    ]);
    expect(edits.web).toEqual([
      'https://gitworkshop.example/demo',
      FACTS.web,
    ]);
  });

  it('a republish that adds nothing new changes no tag', () => {
    const current = {
      tags: [
        ['d', 'demo'],
        ['relays', ...FACTS.relays],
        ['web', FACTS.web],
        ['r', ANNOUNCED, 'euc'],
      ],
    };
    const next = amendRepoAnnouncement(current, {
      repoId: 'demo',
      ...conformanceEdits(current, FACTS),
    });
    expect(diffAnnouncementTags(current, next).unchanged).toBe(true);
  });

  it('never produces a clone tag', () => {
    const event = amendRepoAnnouncement(
      { tags: [['d', 'demo'], ['clone', 'https://ngit.example/demo.git']] },
      { repoId: 'demo', ...conformanceEdits(null, FACTS) }
    );
    expect(event.tags.filter((t) => t[0] === 'clone')).toEqual([
      ['clone', 'https://ngit.example/demo.git'],
    ]);
  });
});

describe('diffAnnouncementTags (#158)', () => {
  const current = {
    tags: [
      ['d', 'demo'],
      ['name', 'Demo'],
      ['clone', 'https://ngit.example/demo.git'],
    ] as string[][],
  };

  it('reports nothing changed for an identical republish', () => {
    const next = amendRepoAnnouncement(current, { repoId: 'demo' });
    const diff = diffAnnouncementTags(current, next);
    expect(diff.unchanged).toBe(true);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
  });

  it('reports added tags, and a changed tag as a removal plus an addition', () => {
    const next = amendRepoAnnouncement(current, {
      repoId: 'demo',
      name: 'Demo Repo',
      relays: ['wss://relay.test.example'],
    });
    const diff = diffAnnouncementTags(current, next);
    expect(diff.unchanged).toBe(false);
    expect(diff.added).toEqual([
      ['name', 'Demo Repo'],
      ['relays', 'wss://relay.test.example'],
    ]);
    expect(diff.removed).toEqual([['name', 'Demo']]);
    expect(describeAnnouncementDiff(diff)).toEqual([
      '  - name Demo',
      '  + name Demo Repo',
      '  + relays wss://relay.test.example',
    ]);
  });

  it('treats a first announcement as all-added', () => {
    const next = amendRepoAnnouncement(null, { repoId: 'demo' });
    expect(diffAnnouncementTags(null, next)).toMatchObject({
      added: [['d', 'demo']],
      removed: [],
      unchanged: false,
    });
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
  it('builds repo refs with dual-shape ref tags plus HEAD/arweave tags', () => {
    const refs = { 'refs/heads/main': 'abc123' };
    const arweaveMap = { abc123: 'arweave-tx-1' };
    const event = buildRepoRefs('hello-toon', refs, arweaveMap);

    expect(event.kind).toBe(30618);
    expect(REPOSITORY_STATE_KIND).toBe(30618);
    expect(event.tags).toEqual(
      expect.arrayContaining([
        ['d', 'hello-toon'],
        // NIP-34 shape (rig#157): ref path is the tag name.
        ['refs/heads/main', 'abc123'],
        // Legacy shape, still written during the dual-write window.
        ['r', 'refs/heads/main', 'abc123'],
        ['HEAD', 'ref: refs/heads/main'],
        ['arweave', 'abc123', 'arweave-tx-1'],
      ])
    );
  });

  it('supports multiple refs and arweave mappings, each ref in both shapes with identical SHAs', () => {
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
        ['refs/heads/main', 'abc123'],
        ['r', 'refs/heads/main', 'abc123'],
        ['refs/heads/dev', 'def456'],
        ['r', 'refs/heads/dev', 'def456'],
        ['arweave', 'abc123', 'arweave-tx-1'],
        ['arweave', 'def456', 'arweave-tx-2'],
      ])
    );
  });

  it('round-trips through the #156 dual-shape reader and through a legacy-only reader', () => {
    const refs = {
      'refs/heads/main': 'abc123',
      'refs/tags/v1': 'def456',
    };
    const event = buildRepoRefs('hello-toon', refs);

    // #156's shared reader (nip34-refs.ts): sees the NIP-shape entries
    // (which win ties) and the legacy entries alike — same refs either way.
    const { refs: parsed } = parseStateRefTags(event.tags);
    expect(Object.fromEntries(parsed)).toEqual(refs);

    // A legacy-only reader — one that has never heard of the NIP shape and
    // understands only rig's original ["r", <ref>, <sha>] tags — still
    // recovers every ref with the same SHAs, because the legacy write is
    // untouched.
    const legacyOnly = Object.fromEntries(
      event.tags
        .filter((t) => t[0] === 'r' && t[1] !== 'HEAD')
        .map((t) => [t[1], t[2]])
    );
    expect(legacyOnly).toEqual(refs);
  });

  it('leaves HEAD and arweave tags unaffected by the dual-shape ref write', () => {
    const refs = {
      'refs/heads/main': 'abc123',
      'refs/heads/dev': 'def456',
    };
    const arweaveMap = { abc123: 'arweave-tx-1' };
    const event = buildRepoRefs('hello-toon', refs, arweaveMap);

    expect(event.tags.filter((t) => t[0] === 'HEAD')).toEqual([
      ['HEAD', 'ref: refs/heads/main'],
    ]);
    expect(event.tags.filter((t) => t[0] === 'arweave')).toEqual([
      ['arweave', 'abc123', 'arweave-tx-1'],
    ]);
  });

  it('emits at most MAX_ARWEAVE_TAGS_PER_EVENT arweave tags, keeping the first (#162)', () => {
    const arweaveMap: Record<string, string> = {};
    for (let i = 0; i < MAX_ARWEAVE_TAGS_PER_EVENT + 250; i++) {
      arweaveMap[i.toString(16).padStart(40, '0')] = `tx-${i}`;
    }
    const event = buildRepoRefs(
      'hello-toon',
      { 'refs/heads/main': 'abc123' },
      arweaveMap
    );

    const arweaveTags = event.tags.filter((t) => t[0] === 'arweave');
    expect(arweaveTags).toHaveLength(MAX_ARWEAVE_TAGS_PER_EVENT);
    // Truncation keeps the caller's order — the caller owns the priority.
    expect(arweaveTags[0]).toEqual(['arweave', '0'.repeat(40), 'tx-0']);
    expect(arweaveTags.at(-1)).toEqual([
      'arweave',
      (MAX_ARWEAVE_TAGS_PER_EVENT - 1).toString(16).padStart(40, '0'),
      `tx-${MAX_ARWEAVE_TAGS_PER_EVENT - 1}`,
    ]);
    // The ref/HEAD tags are unaffected.
    expect(event.tags).toEqual(
      expect.arrayContaining([
        ['d', 'hello-toon'],
        ['r', 'refs/heads/main', 'abc123'],
        ['HEAD', 'ref: refs/heads/main'],
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

describe('buildComment (NIP-22 kind:1111, rig#159)', () => {
  const ROOT = {
    eventId: EVENT_ID,
    kind: 1621,
    authorPubkey: AUTHOR_PUBKEY,
  } as const;

  it('writes kind:1111 — never the legacy 1622 dialect', () => {
    const event = buildComment(OWNER_PUBKEY, 'hello-toon', ROOT, 'Body');

    expect(event.kind).toBe(1111);
    expect(COMMENT_KIND).toBe(1111);
    expect(LEGACY_COMMENT_KIND).toBe(1622);
    expect(event.content).toBe('Body');
  });

  it('a top-level comment repeats the root as its lowercase parent', () => {
    const event = buildComment(
      OWNER_PUBKEY,
      'hello-toon',
      ROOT,
      'Comment body'
    );

    expect(event.tags).toEqual([
      ['E', EVENT_ID, '', AUTHOR_PUBKEY],
      ['K', '1621'],
      ['P', AUTHOR_PUBKEY],
      ['e', EVENT_ID, '', AUTHOR_PUBKEY],
      ['k', '1621'],
      ['p', AUTHOR_PUBKEY],
      ['a', `30617:${OWNER_PUBKEY}:hello-toon`],
    ]);
  });

  it('a reply parents the comment (k=1111) and still roots at the issue', () => {
    const PARENT_ID = 'aa'.repeat(32);
    const PARENT_AUTHOR = 'bb'.repeat(32);

    const event = buildComment(
      OWNER_PUBKEY,
      'hello-toon',
      ROOT,
      'Reply body',
      { eventId: PARENT_ID, authorPubkey: PARENT_AUTHOR }
    );

    expect(event.tags).toEqual([
      ['E', EVENT_ID, '', AUTHOR_PUBKEY],
      ['K', '1621'],
      ['P', AUTHOR_PUBKEY],
      ['e', PARENT_ID, '', PARENT_AUTHOR],
      ['k', '1111'],
      ['p', PARENT_AUTHOR],
      ['a', `30617:${OWNER_PUBKEY}:hello-toon`],
    ]);
  });

  it('roots a comment at a patch with K=1617', () => {
    const event = buildComment(
      OWNER_PUBKEY,
      'hello-toon',
      { eventId: EVENT_ID, kind: 1617, authorPubkey: AUTHOR_PUBKEY },
      'On the patch'
    );

    expect(event.tags).toContainEqual(['K', '1617']);
    expect(event.tags).toContainEqual(['k', '1617']);
  });
});

describe('commentBelongsToThread (rig#159)', () => {
  const ROOT_ID = 'cc'.repeat(32);
  const OTHER_ID = 'dd'.repeat(32);

  it('accepts a kind:1111 whose uppercase E names the root', () => {
    const event = {
      kind: 1111,
      tags: [
        ['E', ROOT_ID, '', AUTHOR_PUBKEY],
        ['e', OTHER_ID, '', AUTHOR_PUBKEY],
      ],
    };
    expect(commentBelongsToThread(event, ROOT_ID)).toBe(true);
  });

  it('REJECTS a kind:1111 whose only match is a lowercase e', () => {
    const event = {
      kind: 1111,
      tags: [
        ['E', OTHER_ID, '', AUTHOR_PUBKEY],
        ['e', ROOT_ID, '', AUTHOR_PUBKEY],
      ],
    };
    expect(commentBelongsToThread(event, ROOT_ID)).toBe(false);
  });

  it('accepts a legacy kind:1622 by its lowercase e tag', () => {
    const event = { kind: 1622, tags: [['e', ROOT_ID, '', 'root']] };
    expect(commentBelongsToThread(event, ROOT_ID)).toBe(true);
  });

  it('rejects any other kind', () => {
    const event = { kind: 1621, tags: [['E', ROOT_ID]] };
    expect(commentBelongsToThread(event, ROOT_ID)).toBe(false);
  });
});

describe('buildComment against the captured ngit thread (rig#155 fixtures)', () => {
  /** Just the NIP-22 threading tags — what must match ngit byte-for-byte. */
  const threading = (tags: string[][]): string[][] =>
    tags.filter((t) => ['E', 'K', 'P', 'e', 'k', 'p'].includes(t[0] as string));

  it('reproduces the wire shape of a real ngit top-level comment', () => {
    const rootAuthor = NGIT_COMMENT_THREAD_ROOT.pubkey;
    const built = buildComment(
      OWNER_PUBKEY,
      'HydrusUI',
      {
        eventId: NGIT_COMMENT_THREAD_ROOT_EVENT_ID,
        kind: NGIT_COMMENT_THREAD_ROOT.kind,
        authorPubkey: rootAuthor,
      },
      'body'
    );

    const ngitTopLevel = NGIT_COMMENT_THREAD_COMMENTS.find(
      (e) => e.id === NGIT_COMMENT_THREAD_COMMENT_EVENT_IDS[0]
    );
    expect(ngitTopLevel).toBeDefined();
    // Every NIP-22 threading tag ngit emits, rig emits identically.
    expect(threading(built.tags)).toEqual(threading(ngitTopLevel?.tags ?? []));
  });

  it('reproduces the wire shape of the real ngit nested reply', () => {
    const ngitReply = NGIT_COMMENT_THREAD_COMMENTS.find(
      (e) => e.id === NGIT_COMMENT_THREAD_NESTED_REPLY_ID
    );
    expect(ngitReply).toBeDefined();
    const parentAuthor = NGIT_COMMENT_THREAD_COMMENTS.find(
      (e) => e.id === NGIT_COMMENT_THREAD_NESTED_REPLY_PARENT_ID
    )?.pubkey;
    expect(parentAuthor).toBeDefined();

    const built = buildComment(
      OWNER_PUBKEY,
      'HydrusUI',
      {
        eventId: NGIT_COMMENT_THREAD_ROOT_EVENT_ID,
        kind: NGIT_COMMENT_THREAD_ROOT.kind,
        authorPubkey: NGIT_COMMENT_THREAD_ROOT.pubkey,
      },
      'body',
      {
        eventId: NGIT_COMMENT_THREAD_NESTED_REPLY_PARENT_ID,
        authorPubkey: parentAuthor ?? '',
      }
    );

    expect(threading(built.tags)).toEqual(threading(ngitReply?.tags ?? []));
  });
});

describe('buildPatch (kind:1617)', () => {
  const commits = [{ sha: 'abc123', parentSha: 'def456' }];

  it('builds a patch with a/p/subject/commit/parent-commit/branch-name tags', () => {
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
        ['branch-name', 'feature/fix'],
      ])
    );
  });

  // #161: the branch NEVER lands in `t` — that tag is reserved for real
  // labels, and a patch's branch used to be misreported as one.
  it('writes the branch to branch-name, never to t', () => {
    const event = buildPatch(
      OWNER_PUBKEY,
      'hello-toon',
      'Fix readme',
      commits,
      'feature/fix'
    );

    const tTags = event.tags.filter((t) => t[0] === 't');
    expect(tTags).toHaveLength(0);
  });

  it('omits the branch-name tag when branchTag is not provided', () => {
    const event = buildPatch(OWNER_PUBKEY, 'hello-toon', 'Fix readme', commits);

    const branchNameTags = event.tags.filter((t) => t[0] === 'branch-name');
    expect(branchNameTags).toHaveLength(0);
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
        ['branch-name', 'feature/fix'],
      ])
    );
  });
});

describe('buildStatus (kinds 1630-1633, rig#160 root marker + a tag)', () => {
  it('builds each status kind with the NIP-10 root-marked e tag and the repo a tag', () => {
    for (const statusKind of [1630, 1631, 1632, 1633] as const) {
      const event = buildStatus(OWNER_PUBKEY, 'hello-toon', EVENT_ID, statusKind);
      expect(event.kind).toBe(statusKind);
      expect(event.tags).toEqual(
        expect.arrayContaining([
          ['e', EVENT_ID, '', 'root'],
          ['a', `30617:${OWNER_PUBKEY}:hello-toon`],
        ])
      );
    }
  });

  it('includes a p tag when targetPubkey is provided', () => {
    const event = buildStatus(
      OWNER_PUBKEY,
      'hello-toon',
      EVENT_ID,
      1631,
      AUTHOR_PUBKEY
    );

    expect(event.tags).toEqual(
      expect.arrayContaining([
        ['e', EVENT_ID, '', 'root'],
        ['a', `30617:${OWNER_PUBKEY}:hello-toon`],
        ['p', AUTHOR_PUBKEY],
      ])
    );
  });

  it('omits the p tag when targetPubkey is not provided', () => {
    const event = buildStatus(OWNER_PUBKEY, 'hello-toon', EVENT_ID, 1630);

    const pTags = event.tags.filter((t) => t[0] === 'p');
    expect(pTags).toHaveLength(0);
  });

  it('no longer emits the old bare (un-marked, a-tag-less) form', () => {
    const event = buildStatus(OWNER_PUBKEY, 'hello-toon', EVENT_ID, 1632);

    // The bare form was exactly `['e', EVENT_ID]` with nothing else — the
    // e tag must now carry the marker, distinguishing it from that shape.
    const eTag = event.tags.find((t) => t[0] === 'e');
    expect(eTag).not.toEqual(['e', EVENT_ID]);
    expect(eTag).toEqual(['e', EVENT_ID, '', 'root']);
  });
});
