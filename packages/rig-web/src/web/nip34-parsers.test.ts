// Test IDs: 8.1-UNIT-007, 8.1-UNIT-008
// AC covered: AC4, AC5 (NIP-34 kind:30617 event parsing)

import { describe, it, expect } from 'vitest';

import {
  NGIT_STATUS_NGIT,
  NGIT_STATUS_NGIT_TARGET,
  NGIT_STATUS_NGIT_TARGET_EVENT_ID,
} from './__fixtures__/ngit-wire.js';
import {
  parseRepoAnnouncement,
  parseRepoRefs,
  parseIssue,
  parsePR,
  parseComment,
  resolveIssueStatus,
  commentBelongsToThread,
  resolvePRStatus,
  withTargetAuthor,
} from './nip34-parsers.js';
import type { NostrEvent } from './nip34-parsers.js';
import {
  NGIT_COMMENT_THREAD_COMMENTS,
  NGIT_COMMENT_THREAD_NESTED_REPLY_ID,
  NGIT_COMMENT_THREAD_NESTED_REPLY_PARENT_ID,
  NGIT_COMMENT_THREAD_ROOT_EVENT_ID,
  NGIT_STATE_NGIT,
} from './__fixtures__/ngit-wire.js';

// ============================================================================
// Factories
// ============================================================================

/**
 * Factory: creates a valid kind:30617 NostrEvent for a repository announcement.
 */
function createMockRepoEvent(
  overrides: {
    id?: string;
    pubkey?: string;
    name?: string;
    description?: string;
    dTag?: string;
    defaultBranch?: string;
    kind?: number;
    tags?: string[][];
  } = {}
) {
  const tags: string[][] = overrides.tags ?? [
    ['d', overrides.dTag ?? 'my-repo'],
    ['name', overrides.name ?? 'My Repository'],
    ['description', overrides.description ?? 'A test repository'],
    ['clone', 'https://git.example.com/my-repo.git'],
    ['web', 'https://git.example.com/my-repo'],
    ['r', 'HEAD', overrides.defaultBranch ?? 'main'],
    ['maintainers', overrides.pubkey ?? 'ab'.repeat(32)],
    ['relays', 'wss://relay.example.com'],
    ['t', 'rust'],
  ];

  return {
    id: overrides.id ?? 'a'.repeat(64),
    pubkey: overrides.pubkey ?? 'ab'.repeat(32),
    created_at: 1700000000,
    kind: overrides.kind ?? 30617,
    tags,
    content:
      overrides.description ?? 'A longer description in the content field.',
    sig: 'b'.repeat(128),
  };
}

describe('NIP-34 Parsers - parseRepoAnnouncement', () => {
  // ---------------------------------------------------------------------------
  // 8.1-UNIT-007: Valid kind:30617 event parsed to RepoMetadata
  // AC: #4, #5
  // ---------------------------------------------------------------------------

  it('[P1] parses valid kind:30617 event to RepoMetadata with correct fields', () => {
    // Arrange
    const event = createMockRepoEvent({
      name: 'awesome-project',
      description: 'An awesome project',
      dTag: 'awesome-project',
      defaultBranch: 'develop',
      pubkey: 'cd'.repeat(32),
    });

    // Act
    const result = parseRepoAnnouncement(event);

    // Assert
    expect(result).not.toBeNull();
    expect(result!.name).toBe('awesome-project');
    expect(result!.description).toBe('An awesome project');
    expect(result!.ownerPubkey).toBe('cd'.repeat(32));
    expect(result!.defaultBranch).toBe('develop');
  });

  it('[P1] extracts d tag as repo identifier', () => {
    // Arrange
    const event = createMockRepoEvent({ dTag: 'unique-repo-id' });

    // Act
    const result = parseRepoAnnouncement(event);

    // Assert
    expect(result).not.toBeNull();
    expect(result!.name).toBeDefined();
  });

  it('[P1] extracts clone URLs from clone tags', () => {
    // Arrange
    const event = createMockRepoEvent();

    // Act
    const result = parseRepoAnnouncement(event);

    // Assert
    expect(result).not.toBeNull();
    expect(result!.cloneUrls).toContain('https://git.example.com/my-repo.git');
  });

  // ---------------------------------------------------------------------------
  // 8.1-UNIT-008: Malformed events return null
  // AC: #4, #5
  // ---------------------------------------------------------------------------

  it('[P1] returns null for event with wrong kind (not 30617)', () => {
    // Arrange
    const event = createMockRepoEvent({ kind: 1 });

    // Act
    const result = parseRepoAnnouncement(event);

    // Assert
    expect(result).toBeNull();
  });

  it('[P1] returns null for event missing d tag', () => {
    // Arrange -- create event with no d tag
    const event = createMockRepoEvent({
      tags: [
        ['name', 'no-d-tag-repo'],
        ['description', 'Missing identifier'],
      ],
    });

    // Act
    const result = parseRepoAnnouncement(event);

    // Assert
    expect(result).toBeNull();
  });

  it('[P2] returns null for event with empty tags array', () => {
    // Arrange
    const event = createMockRepoEvent({ tags: [] });

    // Act
    const result = parseRepoAnnouncement(event);

    // Assert
    expect(result).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // AC5 gap: description falls back to content when no description tag
  // ---------------------------------------------------------------------------

  it('[P1] falls back to content field when no description tag exists', () => {
    // Arrange -- event with d tag but no description tag
    const event = createMockRepoEvent({
      tags: [
        ['d', 'fallback-repo'],
        ['name', 'Fallback Repo'],
        ['clone', 'https://git.example.com/fallback.git'],
        ['r', 'HEAD', 'main'],
      ],
    });
    // The content field is set by the factory to the description override or default
    event.content = 'Description from content field';

    // Act
    const result = parseRepoAnnouncement(event);

    // Assert
    expect(result).not.toBeNull();
    expect(result!.description).toBe('Description from content field');
  });

  it('[P1] uses name tag over d tag when both exist', () => {
    // Arrange
    const event = createMockRepoEvent({
      dTag: 'repo-identifier',
      name: 'Display Name',
    });

    // Act
    const result = parseRepoAnnouncement(event);

    // Assert
    expect(result).not.toBeNull();
    expect(result!.name).toBe('Display Name');
  });

  it('[P2] falls back to d tag as name when no name tag exists', () => {
    // Arrange
    const event = createMockRepoEvent({
      tags: [
        ['d', 'my-repo-id'],
        ['description', 'Some description'],
        ['r', 'HEAD', 'main'],
      ],
    });

    // Act
    const result = parseRepoAnnouncement(event);

    // Assert
    expect(result).not.toBeNull();
    expect(result!.name).toBe('my-repo-id');
  });

  it('[P2] defaults to main when no HEAD ref tag exists', () => {
    // Arrange
    const event = createMockRepoEvent({
      tags: [
        ['d', 'no-ref-repo'],
        ['name', 'No Ref Repo'],
      ],
    });

    // Act
    const result = parseRepoAnnouncement(event);

    // Assert
    expect(result).not.toBeNull();
    expect(result!.defaultBranch).toBe('main');
  });

  it('[P2] extracts web URLs from web tags', () => {
    // Arrange
    const event = createMockRepoEvent();

    // Act
    const result = parseRepoAnnouncement(event);

    // Assert
    expect(result).not.toBeNull();
    expect(result!.webUrls).toContain('https://git.example.com/my-repo');
  });

  it('[P1] sets eventId from event id field', () => {
    // Arrange
    const eventId = 'f'.repeat(64);
    const event = createMockRepoEvent({ id: eventId });

    // Act
    const result = parseRepoAnnouncement(event);

    // Assert
    expect(result).not.toBeNull();
    expect(result!.eventId).toBe(eventId);
  });
});

// ============================================================================
// Story 8.2: kind:30618 Ref Parsing
// ============================================================================

/**
 * Factory: creates a valid kind:30618 NostrEvent for repository refs.
 */
function createMockRefsEvent(
  overrides: {
    id?: string;
    pubkey?: string;
    dTag?: string;
    kind?: number;
    refs?: [string, string][];
    tags?: string[][];
  } = {}
) {
  const refs = overrides.refs ?? [
    ['main', 'aaa111'],
    ['HEAD', 'aaa111'],
  ];
  const tags: string[][] = overrides.tags ?? [
    ['d', overrides.dTag ?? 'my-repo'],
    ...refs.map(([name, sha]) => ['r', name, sha]),
  ];

  return {
    id: overrides.id ?? 'b'.repeat(64),
    pubkey: overrides.pubkey ?? 'ab'.repeat(32),
    created_at: 1700000000,
    kind: overrides.kind ?? 30618,
    tags,
    content: '',
    sig: 'c'.repeat(128),
  };
}

describe('NIP-34 Parsers - parseRepoRefs', () => {
  // ---------------------------------------------------------------------------
  // 8.2-UNIT-007: Valid kind:30618 event parsed to RepoRefs
  // AC: #1
  // ---------------------------------------------------------------------------

  it('[P1] parses valid kind:30618 event to RepoRefs with correct ref->sha mappings', () => {
    const event = createMockRefsEvent({
      dTag: 'my-repo',
      refs: [
        ['main', 'abc123'],
        ['develop', 'def456'],
        ['HEAD', 'abc123'],
      ],
    });

    const result = parseRepoRefs(event);

    expect(result).not.toBeNull();
    expect(result!.repoId).toBe('my-repo');
    expect(result!.refs.size).toBe(3);
    expect(result!.refs.get('main')).toBe('abc123');
    expect(result!.refs.get('develop')).toBe('def456');
    expect(result!.refs.get('HEAD')).toBe('abc123');
  });

  it('[P1] returns null for event with wrong kind (not 30618)', () => {
    const event = createMockRefsEvent({ kind: 1 });

    const result = parseRepoRefs(event);

    expect(result).toBeNull();
  });

  it('[P1] returns null for event missing d tag', () => {
    const event = createMockRefsEvent({
      tags: [['r', 'main', 'abc123']],
    });

    const result = parseRepoRefs(event);

    expect(result).toBeNull();
  });

  it('[P2] handles event with no r tags (empty refs map)', () => {
    const event = createMockRefsEvent({
      tags: [['d', 'my-repo']],
    });

    const result = parseRepoRefs(event);

    expect(result).not.toBeNull();
    expect(result!.refs.size).toBe(0);
  });

  it('[P2] ignores malformed r tags (missing sha)', () => {
    const event = createMockRefsEvent({
      tags: [
        ['d', 'my-repo'],
        ['r', 'main'], // missing SHA
        ['r', 'develop', 'def456'], // valid
      ],
    });

    const result = parseRepoRefs(event);

    expect(result).not.toBeNull();
    expect(result!.refs.size).toBe(1);
    expect(result!.refs.get('develop')).toBe('def456');
  });
});

// ============================================================================
// Story 8.5: Issue / PR / Comment Parsers
// ============================================================================

/**
 * Factory: creates a valid kind:1621 issue event.
 */
function createMockIssueEvent(
  overrides: {
    id?: string;
    pubkey?: string;
    kind?: number;
    subject?: string;
    content?: string;
    labels?: string[];
    repoATag?: string;
    created_at?: number;
  } = {}
): NostrEvent {
  const tags: string[][] = [];
  if (overrides.repoATag) {
    tags.push(['a', overrides.repoATag]);
  } else {
    tags.push(['a', '30617:' + 'ab'.repeat(32) + ':my-repo']);
  }
  if (overrides.subject !== undefined) {
    tags.push(['subject', overrides.subject]);
  }
  if (overrides.labels) {
    for (const l of overrides.labels) {
      tags.push(['t', l]);
    }
  }

  return {
    id: overrides.id ?? 'i'.repeat(64),
    pubkey: overrides.pubkey ?? 'ab'.repeat(32),
    created_at: overrides.created_at ?? 1700000000,
    kind: overrides.kind ?? 1621,
    tags,
    content: overrides.content ?? 'Issue body content',
    sig: 'd'.repeat(128),
  };
}

/**
 * Factory: creates a valid kind:1617 PR/patch event.
 */
function createMockPREvent(
  overrides: {
    id?: string;
    pubkey?: string;
    kind?: number;
    subject?: string;
    content?: string;
    commitShas?: string[];
    baseBranch?: string;
    /** #161: the `branch-name` tag — the shape new patches write. */
    branchNameTag?: string;
    tTags?: string[];
    created_at?: number;
  } = {}
): NostrEvent {
  const tags: string[][] = [['a', '30617:' + 'ab'.repeat(32) + ':my-repo']];
  if (overrides.subject !== undefined) {
    tags.push(['subject', overrides.subject]);
  }
  if (overrides.commitShas) {
    for (const sha of overrides.commitShas) {
      tags.push(['commit', sha]);
    }
  }
  if (overrides.baseBranch !== undefined) {
    tags.push(['branch', overrides.baseBranch]);
  }
  if (overrides.branchNameTag !== undefined) {
    tags.push(['branch-name', overrides.branchNameTag]);
  }
  if (overrides.tTags) {
    for (const label of overrides.tTags) {
      tags.push(['t', label]);
    }
  }

  return {
    id: overrides.id ?? 'p'.repeat(64),
    pubkey: overrides.pubkey ?? 'ab'.repeat(32),
    created_at: overrides.created_at ?? 1700000000,
    kind: overrides.kind ?? 1617,
    tags,
    content: overrides.content ?? 'Patch content',
    sig: 'e'.repeat(128),
  };
}

/**
 * Factory: creates a valid kind:1622 comment event.
 */
function createMockCommentEvent(
  overrides: {
    id?: string;
    pubkey?: string;
    kind?: number;
    content?: string;
    parentEventId?: string;
    created_at?: number;
  } = {}
): NostrEvent {
  const tags: string[][] = [];
  if (overrides.parentEventId !== undefined) {
    tags.push(['e', overrides.parentEventId]);
  } else {
    tags.push(['e', 'parent'.repeat(10) + 'aaaa']);
  }

  return {
    id: overrides.id ?? 'c'.repeat(64),
    pubkey: overrides.pubkey ?? 'cd'.repeat(32),
    created_at: overrides.created_at ?? 1700001000,
    kind: overrides.kind ?? 1622,
    tags,
    content: overrides.content ?? 'Comment text',
    sig: 'f'.repeat(128),
  };
}

/**
 * Factory: a NIP-22 kind:1111 comment (#159). `parentEventId` makes it a
 * nested reply — the lowercase `e`/`k`/`p` then name that comment while the
 * uppercase `E`/`K`/`P` still name the thread root.
 */
function createMockNip22CommentEvent(overrides: {
  id?: string;
  pubkey?: string;
  rootEventId: string;
  rootKind?: number;
  rootAuthorPubkey?: string;
  parentEventId?: string;
  created_at?: number;
  content?: string;
}): NostrEvent {
  const rootAuthor = overrides.rootAuthorPubkey ?? 'ab'.repeat(32);
  const rootKind = overrides.rootKind ?? 1621;
  const isReply = overrides.parentEventId !== undefined;
  return {
    id: overrides.id ?? 'e'.repeat(64),
    pubkey: overrides.pubkey ?? 'cd'.repeat(32),
    created_at: overrides.created_at ?? 1700001000,
    kind: 1111,
    tags: [
      ['E', overrides.rootEventId, '', rootAuthor],
      ['K', String(rootKind)],
      ['P', rootAuthor],
      ['e', overrides.parentEventId ?? overrides.rootEventId, '', rootAuthor],
      ['k', isReply ? '1111' : String(rootKind)],
      ['p', rootAuthor],
    ],
    content: overrides.content ?? 'Comment text',
    sig: 'f'.repeat(128),
  };
}

/**
 * Factory: creates a status event (kind:1630-1633).
 */
function createMockStatusEvent(overrides: {
  kind: number;
  prEventId: string;
  created_at?: number;
  pubkey?: string;
  /** rig#160: emit the NIP-10 root-marked e tag instead of the bare form. */
  marker?: boolean;
}): NostrEvent {
  return {
    id: Math.random().toString(36).slice(2).padEnd(64, '0'),
    pubkey: overrides.pubkey ?? 'ab'.repeat(32),
    created_at: overrides.created_at ?? 1700002000,
    kind: overrides.kind,
    tags: overrides.marker
      ? [['e', overrides.prEventId, '', 'root']]
      : [['e', overrides.prEventId]],
    content: '',
    sig: '0'.repeat(128),
  };
}

describe('NIP-34 Parsers - parseIssue', () => {
  it('[P1] extracts title from subject tag', () => {
    const event = createMockIssueEvent({ subject: 'Bug: crash on startup' });

    const result = parseIssue(event);

    expect(result).not.toBeNull();
    expect(result!.title).toBe('Bug: crash on startup');
  });

  it('[P1] falls back to first line of content when no subject tag', () => {
    const event = createMockIssueEvent({
      content: 'First line title\nSecond line body',
    });
    // Remove subject tag
    event.tags = event.tags.filter((t) => t[0] !== 'subject');

    const result = parseIssue(event);

    expect(result).not.toBeNull();
    expect(result!.title).toBe('First line title');
  });

  it('[P1] returns null for non-1621 events', () => {
    const event = createMockIssueEvent({ kind: 1 });

    const result = parseIssue(event);

    expect(result).toBeNull();
  });

  it('[P2] extracts labels from t tags', () => {
    const event = createMockIssueEvent({
      subject: 'Test issue',
      labels: ['bug', 'priority-high'],
    });

    const result = parseIssue(event);

    expect(result).not.toBeNull();
    expect(result!.labels).toEqual(['bug', 'priority-high']);
  });

  it('[P2] defaults status to open', () => {
    const event = createMockIssueEvent({ subject: 'Open issue' });

    const result = parseIssue(event);

    expect(result).not.toBeNull();
    expect(result!.status).toBe('open');
  });
});

describe('NIP-34 Parsers - parsePR', () => {
  it('[P1] extracts commit SHAs from commit tags', () => {
    const event = createMockPREvent({
      subject: 'Add feature',
      commitShas: ['abc123', 'def456'],
    });

    const result = parsePR(event);

    expect(result).not.toBeNull();
    expect(result!.commitShas).toEqual(['abc123', 'def456']);
  });

  it('[P1] extracts base branch from branch tag', () => {
    const event = createMockPREvent({
      subject: 'Fix bug',
      baseBranch: 'develop',
    });

    const result = parsePR(event);

    expect(result).not.toBeNull();
    expect(result!.baseBranch).toBe('develop');
  });

  it('[P1] returns null for non-1617 events', () => {
    const event = createMockPREvent({ kind: 1 });

    const result = parsePR(event);

    expect(result).toBeNull();
  });

  it('[P2] defaults base branch to main when no branch tag', () => {
    const event = createMockPREvent({ subject: 'Feature' });

    const result = parsePR(event);

    expect(result).not.toBeNull();
    expect(result!.baseBranch).toBe('main');
  });

  it('[P1] extracts content field from event (AC #7)', () => {
    const event = createMockPREvent({
      subject: 'My PR',
      content: 'Detailed patch content here',
    });

    const result = parsePR(event);

    expect(result).not.toBeNull();
    expect(result!.content).toBe('Detailed patch content here');
  });

  // #161: patch branch name round-trips.
  it('[P1] extracts base branch from branch-name tag (new patches)', () => {
    const event = createMockPREvent({
      subject: 'Fix bug',
      branchNameTag: 'feature/new',
    });

    const result = parsePR(event);

    expect(result).not.toBeNull();
    expect(result?.baseBranch).toBe('feature/new');
  });

  it('[P1] prefers branch-name over a disagreeing legacy branch tag', () => {
    const event = createMockPREvent({
      subject: 'Fix bug',
      branchNameTag: 'feature/wins',
      baseBranch: 'feature/loses',
    });

    const result = parsePR(event);

    expect(result).not.toBeNull();
    expect(result?.baseBranch).toBe('feature/wins');
  });

  it('[P1] a legacy patch with the branch only in t does not surface it as baseBranch', () => {
    const event = createMockPREvent({
      subject: 'Legacy t-only patch',
      tTags: ['feature/was-a-branch'],
    });

    const result = parsePR(event);

    expect(result).not.toBeNull();
    // No branch-name, no branch tag: falls back to the 'main' default, same
    // as if the patch carried no branch info at all — no heuristic reads it
    // out of t.
    expect(result?.baseBranch).toBe('main');
  });
});

describe('NIP-34 Parsers - parseComment', () => {
  it('[P1] extracts parent event ID from e tag', () => {
    const parentId = 'parent'.repeat(10) + 'bbbb';
    const event = createMockCommentEvent({ parentEventId: parentId });

    const result = parseComment(event);

    expect(result).not.toBeNull();
    expect(result!.parentEventId).toBe(parentId);
  });

  it('[P1] returns null for events of neither comment kind', () => {
    const event = createMockCommentEvent({ kind: 1 });

    const result = parseComment(event);

    expect(result).toBeNull();
  });

  it('[P2] returns null when no e tag exists', () => {
    const event = createMockCommentEvent({});
    event.tags = [];

    const result = parseComment(event);

    expect(result).toBeNull();
  });

  // ── NIP-22 kind:1111 (rig#159) ────────────────────────────────────────────

  it('[P1] a legacy kind:1622 comment roots at its lone e tag', () => {
    const parentId = 'parent'.repeat(10) + 'bbbb';
    const event = createMockCommentEvent({ parentEventId: parentId });

    const result = parseComment(event);

    expect(result).not.toBeNull();
    expect(result?.kind).toBe(1622);
    expect(result?.rootEventId).toBe(parentId);
    expect(result?.parentEventId).toBe(parentId);
  });

  it('[P1] a top-level kind:1111 roots and parents at the issue', () => {
    const rootId = 'a1'.repeat(32);
    const event = createMockNip22CommentEvent({ rootEventId: rootId });

    const result = parseComment(event);

    expect(result).not.toBeNull();
    expect(result?.kind).toBe(1111);
    expect(result?.rootEventId).toBe(rootId);
    expect(result?.parentEventId).toBe(rootId);
  });

  it('[P1] a nested kind:1111 reply keeps the issue as its root', () => {
    const rootId = 'a1'.repeat(32);
    const parentId = 'b2'.repeat(32);
    const event = createMockNip22CommentEvent({
      rootEventId: rootId,
      parentEventId: parentId,
    });

    const result = parseComment(event);

    expect(result?.rootEventId).toBe(rootId);
    expect(result?.parentEventId).toBe(parentId);
  });

  it('[P1] rejects a kind:1111 with no UPPERCASE E root scope', () => {
    const event = createMockNip22CommentEvent({ rootEventId: 'a1'.repeat(32) });
    event.tags = event.tags.filter((t) => t[0] !== 'E');

    expect(parseComment(event)).toBeNull();
  });
});

describe('NIP-34 Parsers - commentBelongsToThread (#159)', () => {
  const rootId = 'a1'.repeat(32);
  const otherRoot = 'c3'.repeat(32);

  it('[P1] matches a kind:1111 on the UPPERCASE E tag', () => {
    const event = createMockNip22CommentEvent({ rootEventId: rootId });

    expect(commentBelongsToThread(event, rootId)).toBe(true);
  });

  it('[P1] a kind:1111 matching ONLY on a lowercase e is NOT in the thread', () => {
    // Root scope is another thread; the lowercase `e` (its parent comment)
    // happens to be this thread's root id. Case-sensitive matching excludes it.
    const event = createMockNip22CommentEvent({
      rootEventId: otherRoot,
      parentEventId: rootId,
    });

    expect(commentBelongsToThread(event, rootId)).toBe(false);
  });

  it('[P1] matches a legacy kind:1622 on its lowercase e tag', () => {
    const event = createMockCommentEvent({ parentEventId: rootId });

    expect(commentBelongsToThread(event, rootId)).toBe(true);
  });
});

describe('NIP-34 Parsers - the captured ngit kind:1111 thread (#155/#159)', () => {
  it('[P1] parses all five captured comments into one thread', () => {
    const parsed = NGIT_COMMENT_THREAD_COMMENTS.map((e) => parseComment(e));

    expect(parsed.every((c) => c !== null)).toBe(true);
    expect(
      parsed.every(
        (c) => c?.rootEventId === NGIT_COMMENT_THREAD_ROOT_EVENT_ID
      )
    ).toBe(true);
    expect(
      NGIT_COMMENT_THREAD_COMMENTS.every((e) =>
        commentBelongsToThread(e, NGIT_COMMENT_THREAD_ROOT_EVENT_ID)
      )
    ).toBe(true);
  });

  it('[P1] the genuine nested reply parents at another comment', () => {
    const reply = NGIT_COMMENT_THREAD_COMMENTS.find(
      (e) => e.id === NGIT_COMMENT_THREAD_NESTED_REPLY_ID
    );
    expect(reply).toBeDefined();

    const parsed = reply ? parseComment(reply) : null;

    expect(parsed).not.toBeNull();
    expect(parsed?.parentEventId).toBe(
      NGIT_COMMENT_THREAD_NESTED_REPLY_PARENT_ID
    );
    expect(parsed?.rootEventId).toBe(NGIT_COMMENT_THREAD_ROOT_EVENT_ID);
  });

  it('[P1] a mixed 1622 + 1111 thread merges in createdAt order', () => {
    const legacy = createMockCommentEvent({
      id: 'd4'.repeat(32),
      parentEventId: NGIT_COMMENT_THREAD_ROOT_EVENT_ID,
      created_at: 1, // older than every captured comment
      content: 'legacy',
    });

    const merged = [...NGIT_COMMENT_THREAD_COMMENTS, legacy]
      .filter((e) =>
        commentBelongsToThread(e, NGIT_COMMENT_THREAD_ROOT_EVENT_ID)
      )
      .map((e) => parseComment(e))
      .filter((c): c is NonNullable<typeof c> => c !== null)
      .sort((a, b) => a.createdAt - b.createdAt);

    expect(merged).toHaveLength(6);
    expect(merged[0]?.kind).toBe(1622);
    expect(merged.slice(1).every((c) => c.kind === 1111)).toBe(true);
  });
});

describe('NIP-34 Parsers - resolvePRStatus (8.5-UNIT-004)', () => {
  const prEventId = 'p'.repeat(64);
  // The mock status events are signed by 'ab'×32 — treat that as the
  // authorized author (owner) for these state-resolution unit tests (#287).
  const AUTHORIZED = ['ab'.repeat(32)];

  it('[P1] returns status from the most recent status event', () => {
    const statusEvents: NostrEvent[] = [
      createMockStatusEvent({ kind: 1630, prEventId, created_at: 1700001000 }), // open
      createMockStatusEvent({ kind: 1631, prEventId, created_at: 1700002000 }), // applied (most recent)
    ];

    const result = resolvePRStatus(prEventId, statusEvents, AUTHORIZED);

    expect(result).toBe('applied');
  });

  it('[P1] returns open when no status events exist', () => {
    const result = resolvePRStatus(prEventId, [], AUTHORIZED);

    expect(result).toBe('open');
  });

  it('[P1] ignores status events for other PRs', () => {
    const otherPrId = 'o'.repeat(64);
    const statusEvents: NostrEvent[] = [
      createMockStatusEvent({
        kind: 1631,
        prEventId: otherPrId,
        created_at: 1700002000,
      }),
    ];

    const result = resolvePRStatus(prEventId, statusEvents, AUTHORIZED);

    expect(result).toBe('open');
  });

  it('[P1] maps kind 1630 to open', () => {
    const statusEvents: NostrEvent[] = [
      createMockStatusEvent({ kind: 1630, prEventId, created_at: 1700001000 }),
    ];

    const result = resolvePRStatus(prEventId, statusEvents, AUTHORIZED);

    expect(result).toBe('open');
  });

  it('[P1] maps kind 1632 to closed', () => {
    const statusEvents: NostrEvent[] = [
      createMockStatusEvent({ kind: 1632, prEventId, created_at: 1700001000 }),
    ];

    const result = resolvePRStatus(prEventId, statusEvents, AUTHORIZED);

    expect(result).toBe('closed');
  });

  it('[P1] maps kind 1633 to draft', () => {
    const statusEvents: NostrEvent[] = [
      createMockStatusEvent({ kind: 1633, prEventId, created_at: 1700001000 }),
    ];

    const result = resolvePRStatus(prEventId, statusEvents, AUTHORIZED);

    expect(result).toBe('draft');
  });

  it('[P2] equal created_at uses last-in-array (deterministic tie-breaking)', () => {
    const sameTime = 1700001000;
    const statusEvents: NostrEvent[] = [
      createMockStatusEvent({ kind: 1630, prEventId, created_at: sameTime }), // open
      createMockStatusEvent({ kind: 1632, prEventId, created_at: sameTime }), // closed
    ];

    // With equal timestamps, the loop keeps the first one found
    // (since > is strict, not >=). This is deterministic.
    const result = resolvePRStatus(prEventId, statusEvents, AUTHORIZED);
    expect(result).toBe('open');
  });

  it('[P2] ignores events with kind outside 1630-1633 range', () => {
    const statusEvents: NostrEvent[] = [
      {
        id: 'x'.repeat(64),
        pubkey: 'ab'.repeat(32),
        created_at: 1700002000,
        kind: 1622, // comment, not a status event
        tags: [['e', prEventId]],
        content: '',
        sig: '0'.repeat(128),
      },
    ];

    const result = resolvePRStatus(prEventId, statusEvents, AUTHORIZED);
    expect(result).toBe('open');
  });

  it('[P0] IGNORES an unauthorized (non-owner/non-maintainer) status — spoof regression (#287)', () => {
    const stranger = 'ff'.repeat(32);
    const statusEvents: NostrEvent[] = [
      // Owner opens the PR.
      createMockStatusEvent({ kind: 1630, prEventId, created_at: 1700001000 }),
      // A funded stranger publishes a LATER "draft" — must NOT move state.
      createMockStatusEvent({
        kind: 1633,
        prEventId,
        created_at: 1700009000,
        pubkey: stranger,
      }),
    ];
    // Stranger not in the authorized set → their status is ignored.
    expect(resolvePRStatus(prEventId, statusEvents, AUTHORIZED)).toBe('open');
    // If the stranger WERE authorized, their draft would win — proves the
    // filter (not some other quirk) is what protects the state.
    expect(
      resolvePRStatus(prEventId, statusEvents, [...AUTHORIZED, stranger])
    ).toBe('draft');
  });

  it('[P1] honors a DECLARED MAINTAINER status (#287)', () => {
    const maintainer = 'cc'.repeat(32);
    const statusEvents: NostrEvent[] = [
      createMockStatusEvent({ kind: 1630, prEventId, created_at: 1700001000 }),
      createMockStatusEvent({
        kind: 1632,
        prEventId,
        created_at: 1700005000,
        pubkey: maintainer,
      }),
    ];
    expect(
      resolvePRStatus(prEventId, statusEvents, [...AUTHORIZED, maintainer])
    ).toBe('closed');
  });

  // ── rig#160: NIP-10 root marker + a tag, both read forms ─────────────────

  it('[P0] a marker-form e tag (["e", id, "", "root"]) resolves status identically to the bare form (rig#160)', () => {
    const statusEvents: NostrEvent[] = [
      createMockStatusEvent({
        kind: 1632,
        prEventId,
        created_at: 1700001000,
        marker: true,
      }),
    ];
    expect(resolvePRStatus(prEventId, statusEvents, AUTHORIZED)).toBe(
      'closed'
    );
  });

  it('[P0] the winner is the LATEST authorized status regardless of which form each event uses (rig#160)', () => {
    const statusEvents: NostrEvent[] = [
      createMockStatusEvent({
        kind: 1630,
        prEventId,
        created_at: 1700001000,
      }), // bare, open
      createMockStatusEvent({
        kind: 1632,
        prEventId,
        created_at: 1700002000,
        marker: true,
      }), // marker, closed — later, wins
    ];
    expect(resolvePRStatus(prEventId, statusEvents, AUTHORIZED)).toBe(
      'closed'
    );
  });

  it('[P0] a marker-form status from an unauthorized pubkey is ignored, same as the bare form (rig#160)', () => {
    const stranger = 'ff'.repeat(32);
    const statusEvents: NostrEvent[] = [
      createMockStatusEvent({
        kind: 1632,
        prEventId,
        created_at: 1700001000,
        pubkey: stranger,
        marker: true,
      }),
    ];
    expect(resolvePRStatus(prEventId, statusEvents, AUTHORIZED)).toBe('open');
  });

  it('[P0] the captured ngit marker-form status (rig#155 fixtures) resolves its real target to "applied" (rig#160)', () => {
    const authorized = [NGIT_STATUS_NGIT.pubkey.toLowerCase()];
    expect(
      resolvePRStatus(
        NGIT_STATUS_NGIT_TARGET_EVENT_ID,
        [NGIT_STATUS_NGIT],
        authorized
      )
    ).toBe('applied');
  });

  it('[P0] the captured ngit status is ignored when the signer is not authorized (rig#160)', () => {
    expect(
      resolvePRStatus(
        NGIT_STATUS_NGIT_TARGET_EVENT_ID,
        [NGIT_STATUS_NGIT],
        ['ff'.repeat(32)]
      )
    ).toBe('open');
  });

  it('[P0] full parsePR + resolvePRStatus flow: the captured ngit PR (kind:1618) flips from "open" to "applied" via its captured marker-form status (rig#160)', () => {
    // parsePR (unlike rig's own CLI tracker, which reads only kind:1617
    // patches — a separate, out-of-scope dual-read gap) already accepts
    // BOTH 1617 and 1618, so this is a real end-to-end proof for rig-web:
    // the SAME captured events a viewer's usePRs hook would fetch, run
    // through the SAME two functions that hook calls.
    const pr = parsePR(NGIT_STATUS_NGIT_TARGET);
    expect(pr).not.toBeNull();
    expect(pr?.status).toBe('open'); // parsePR's hardcoded default, pre-resolution
    const authorized = withTargetAuthor(
      new Set<string>(),
      pr?.authorPubkey ?? ''
    );
    const resolved = resolvePRStatus(
      NGIT_STATUS_NGIT_TARGET_EVENT_ID,
      [NGIT_STATUS_NGIT],
      // The real status is signed by the repo owner, not the PR's own
      // author — prove it resolves WITHOUT relying on the new
      // target-author rule, exactly like `usePRs` would with a correctly
      // resolved owner ∪ maintainers set.
      new Set([...authorized, NGIT_STATUS_NGIT.pubkey.toLowerCase()])
    );
    expect(resolved).toBe('applied');
  });
});

describe('NIP-34 Parsers - resolveIssueStatus (rig#160)', () => {
  const issueEventId = 'i'.repeat(64);
  const AUTHORIZED = ['ab'.repeat(32)];

  it('[P1] returns open when no close events exist', () => {
    expect(resolveIssueStatus(issueEventId, [], AUTHORIZED)).toBe('open');
  });

  it('[P1] closes on an authorized kind:1632 close event', () => {
    const closeEvents: NostrEvent[] = [
      createMockStatusEvent({ kind: 1632, prEventId: issueEventId }),
    ];
    expect(resolveIssueStatus(issueEventId, closeEvents, AUTHORIZED)).toBe(
      'closed'
    );
  });

  it('[P0] a marker-form close event closes the issue, same as the bare form (rig#160)', () => {
    const closeEvents: NostrEvent[] = [
      createMockStatusEvent({
        kind: 1632,
        prEventId: issueEventId,
        marker: true,
      }),
    ];
    expect(resolveIssueStatus(issueEventId, closeEvents, AUTHORIZED)).toBe(
      'closed'
    );
  });

  it('[P0] IGNORES an unauthorized marker-form close — spoof regression (rig#160)', () => {
    const stranger = 'ff'.repeat(32);
    const closeEvents: NostrEvent[] = [
      createMockStatusEvent({
        kind: 1632,
        prEventId: issueEventId,
        pubkey: stranger,
        marker: true,
      }),
    ];
    expect(resolveIssueStatus(issueEventId, closeEvents, AUTHORIZED)).toBe(
      'open'
    );
    // Confirms the filter (not some other quirk) protects the state.
    expect(
      resolveIssueStatus(issueEventId, closeEvents, [...AUTHORIZED, stranger])
    ).toBe('closed');
  });
});

describe('NIP-34 Parsers - withTargetAuthor (rig#160)', () => {
  it('adds the target author to a copy of the authorized set, without mutating the input', () => {
    const owner = 'ab'.repeat(32);
    const authorized = new Set([owner]);
    const result = withTargetAuthor(authorized, 'CD'.repeat(32)); // mixed case

    expect(result).toEqual(new Set([owner, 'cd'.repeat(32)])); // lowercased
    expect(authorized).toEqual(new Set([owner])); // original untouched
    expect(result).not.toBe(authorized); // a new Set, not the same object
  });
});

// ============================================================================
// NFR: Edge case tests for parsers
// ============================================================================

describe('NIP-34 Parsers - NFR Edge Cases', () => {
  it('[P2] parseIssue with empty content returns empty title when no subject tag', () => {
    const event = createMockIssueEvent({ content: '' });
    event.tags = event.tags.filter((t) => t[0] !== 'subject');

    const result = parseIssue(event);

    expect(result).not.toBeNull();
    expect(result!.title).toBe('');
    expect(result!.content).toBe('');
  });

  it('[P2] parsePR with no subject tag returns empty title', () => {
    const event = createMockPREvent({});
    // Remove subject tag
    event.tags = event.tags.filter((t) => t[0] !== 'subject');

    const result = parsePR(event);

    expect(result).not.toBeNull();
    expect(result!.title).toBe('');
  });

  it('[P2] parseComment extracts first e tag when multiple exist', () => {
    const event = createMockCommentEvent({
      parentEventId: 'first'.repeat(12) + 'aa',
    });
    event.tags.push(['e', 'second'.repeat(10) + 'bbbb']);

    const result = parseComment(event);

    expect(result).not.toBeNull();
    // getTagValue returns the first match
    expect(result!.parentEventId).toBe('first'.repeat(12) + 'aa');
  });

  it('[P2] parseIssue preserves full content including newlines', () => {
    const content = 'First line\n\nSecond paragraph\n\nThird paragraph';
    const event = createMockIssueEvent({ subject: 'Title', content });

    const result = parseIssue(event);

    expect(result).not.toBeNull();
    expect(result!.content).toBe(content);
  });
});

// ============================================================================
// AC gap-fill: Full field extraction for parseIssue, parsePR, parseComment
// AC covered: #6, #7, #8
// ============================================================================

describe('NIP-34 Parsers - AC Gap Fill: Full Field Extraction', () => {
  it('[P1] parseIssue extracts eventId, authorPubkey, and createdAt (AC #6)', () => {
    const event = createMockIssueEvent({
      id: 'myevent'.padEnd(64, '0'),
      pubkey: 'ab'.repeat(32),
      subject: 'Test issue',
      created_at: 1700050000,
    });

    const result = parseIssue(event);

    expect(result).not.toBeNull();
    expect(result!.eventId).toBe('myevent'.padEnd(64, '0'));
    expect(result!.authorPubkey).toBe('ab'.repeat(32));
    expect(result!.createdAt).toBe(1700050000);
  });

  it('[P1] parsePR extracts title from subject tag (AC #7)', () => {
    const event = createMockPREvent({
      subject: 'Refactor module X',
    });

    const result = parsePR(event);

    expect(result).not.toBeNull();
    expect(result!.title).toBe('Refactor module X');
  });

  it('[P1] parsePR extracts eventId, authorPubkey, createdAt and defaults status to open (AC #7)', () => {
    const event = createMockPREvent({
      id: 'prevent'.padEnd(64, '0'),
      pubkey: 'cd'.repeat(32),
      subject: 'Add tests',
      created_at: 1700060000,
    });

    const result = parsePR(event);

    expect(result).not.toBeNull();
    expect(result!.eventId).toBe('prevent'.padEnd(64, '0'));
    expect(result!.authorPubkey).toBe('cd'.repeat(32));
    expect(result!.createdAt).toBe(1700060000);
    expect(result!.status).toBe('open');
  });

  it('[P1] parseComment extracts eventId, content, authorPubkey, createdAt (AC #8)', () => {
    const event = createMockCommentEvent({
      id: 'comevent'.padEnd(64, '0'),
      pubkey: 'ef'.repeat(32),
      content: 'Looks good to me',
      created_at: 1700070000,
      parentEventId: 'parent'.padEnd(64, '0'),
    });

    const result = parseComment(event);

    expect(result).not.toBeNull();
    expect(result!.eventId).toBe('comevent'.padEnd(64, '0'));
    expect(result!.content).toBe('Looks good to me');
    expect(result!.authorPubkey).toBe('ef'.repeat(32));
    expect(result!.createdAt).toBe(1700070000);
    expect(result!.parentEventId).toBe('parent'.padEnd(64, '0'));
  });
});

// ============================================================================
// Story 8.6: Bug Fix Validation Tests
// ============================================================================

describe('NIP-34 Parsers - 8.6-UNIT-001: repoId from d tag', () => {
  it('[P1] parseRepoAnnouncement populates repoId from d tag (distinct from name)', () => {
    // AC #1: Repos where name != d tag must use repoId in URLs
    const event = createMockRepoEvent({
      dTag: 'my-repo-id',
      name: 'My Repo Name',
    });

    const result = parseRepoAnnouncement(event);

    expect(result).not.toBeNull();
    expect(result!.repoId).toBe('my-repo-id');
    expect(result!.name).toBe('My Repo Name');
  });

  it('[P1] repoId falls back to d tag value when d and name are the same', () => {
    const event = createMockRepoEvent({
      dTag: 'same-value',
      name: 'same-value',
    });

    const result = parseRepoAnnouncement(event);

    expect(result).not.toBeNull();
    expect(result!.repoId).toBe('same-value');
    expect(result!.name).toBe('same-value');
  });
});

describe('NIP-34 Parsers - 8.6-UNIT-005b: arweaveMap from kind:30618', () => {
  it('[P1] parseRepoRefs extracts arweave tags into arweaveMap', () => {
    // AC #5: ["arweave", "<sha>", "<txId>"] tags populate arweaveMap
    const sha = 'abc123' + 'de'.repeat(17);
    const txId = 'txId456_abcdefghijklmnopqrstuvwxyz01234567';
    const event = createMockRefsEvent({
      tags: [
        ['d', 'my-repo'],
        ['r', 'main', 'aaa111'],
        ['arweave', sha, txId],
        [
          'arweave',
          'def789' + 'ab'.repeat(17),
          'txId789_abcdefghijklmnopqrstuvwxyz01234567',
        ],
      ],
    });

    const result = parseRepoRefs(event);

    expect(result).not.toBeNull();
    expect(result!.arweaveMap.size).toBe(2);
    expect(result!.arweaveMap.get(sha)).toBe(txId);
    expect(result!.arweaveMap.get('def789' + 'ab'.repeat(17))).toBe(
      'txId789_abcdefghijklmnopqrstuvwxyz01234567'
    );
  });

  it('[P1] parseRepoRefs caps arweaveMap at 2000 entries (#162 hostile relay)', () => {
    // A relay is untrusted: a giant state event must not exhaust memory.
    // Truncation is safe — arweave-client.ts resolves a missing SHA through
    // the GraphQL Git-SHA resolver.
    const flood = Array.from({ length: 2500 }, (_, i) => [
      'arweave',
      i.toString(16).padStart(40, '0'),
      `tx${i.toString().padStart(41, '0')}`,
    ]);
    const event = createMockRefsEvent({
      tags: [['d', 'my-repo'], ...flood, ['r', 'main', 'aaa111']],
    });

    const result = parseRepoRefs(event);

    expect(result).not.toBeNull();
    expect(result?.arweaveMap.size).toBe(2000);
    expect(result?.arweaveMap.get('0'.repeat(40))).toBe(`tx${'0'.repeat(41)}`);
    // Tags after the flood are still parsed — the cap skips surplus rows, it
    // does not abandon the event.
    expect(result?.refs.get('main')).toBe('aaa111');
  });

  it('[P1] parseRepoRefs still reads arweave tags past the 1000-ref cap (#162)', () => {
    // Regression: the ref cap used to `break` the whole tag loop, so an event
    // with more than 1000 `r` tags yielded an EMPTY object map.
    const refFlood = Array.from({ length: 1200 }, (_, i) => [
      'r',
      `branch-${i}`,
      i.toString(16).padStart(40, '0'),
    ]);
    const sha = 'ab'.repeat(20);
    const event = createMockRefsEvent({
      tags: [
        ['d', 'my-repo'],
        ...refFlood,
        ['arweave', sha, 'txAfterTheRefCap'],
      ],
    });

    const result = parseRepoRefs(event);

    expect(result).not.toBeNull();
    expect(result?.refs.size).toBe(1000);
    expect(result?.arweaveMap.get(sha)).toBe('txAfterTheRefCap');
  });

  it('[P1] parseRepoRefs returns empty arweaveMap when no arweave tags', () => {
    const event = createMockRefsEvent({
      tags: [
        ['d', 'my-repo'],
        ['r', 'main', 'aaa111'],
      ],
    });

    const result = parseRepoRefs(event);

    expect(result).not.toBeNull();
    expect(result!.arweaveMap.size).toBe(0);
  });

  it('[P2] parseRepoRefs ignores malformed arweave tags (missing txId)', () => {
    const event = createMockRefsEvent({
      tags: [
        ['d', 'my-repo'],
        ['arweave', 'sha-only'], // missing txId
        ['arweave', 'good-sha', 'good-txId'],
      ],
    });

    const result = parseRepoRefs(event);

    expect(result).not.toBeNull();
    expect(result!.arweaveMap.size).toBe(1);
    expect(result!.arweaveMap.get('good-sha')).toBe('good-txId');
  });
});

// ============================================================================
// NIP-34 ref tag shapes (rig#156, spec rig#153)
//
// The same matrix `@toon-protocol/rig`'s `nip34-refs.test.ts` runs against the
// shared rig-side parser, asserting the SAME view model out of rig-web's
// documented copy — including against the real ngit state event both packages
// hold a copy of (rig#155).
// ============================================================================

const SHA_A = '1a'.repeat(20);
const SHA_B = '2b'.repeat(20);
const SHA_C = '3c'.repeat(20);

/** Narrow a parse result or fail the test loudly (no non-null assertions). */
function parsedRefs(event: NostrEvent): Map<string, string> {
  const result = parseRepoRefs(event);
  if (result === null) throw new Error('expected parseRepoRefs to succeed');
  return result.refs;
}

function refsEventWithTags(tags: string[][]): NostrEvent {
  return createMockRefsEvent({ tags: [['d', 'my-repo'], ...tags] });
}

describe('NIP-34 Parsers - parseRepoRefs: dual ref tag shapes', () => {
  it('reads the NIP-34 shape, where the ref path is the tag name', () => {
    const refs = parsedRefs(
      refsEventWithTags([
        ['refs/heads/main', SHA_A],
        ['refs/tags/v1.0.0', SHA_B],
        ['HEAD', 'ref: refs/heads/main'],
      ])
    );

    expect([...refs]).toEqual([
      ['refs/heads/main', SHA_A],
      ['refs/tags/v1.0.0', SHA_B],
    ]);
  });

  it('merges both shapes into one ref set when they agree', () => {
    const refs = parsedRefs(
      refsEventWithTags([
        ['refs/heads/main', SHA_A],
        ['r', 'refs/heads/main', SHA_A],
        ['r', 'refs/heads/dev', SHA_B],
        ['refs/tags/v2', SHA_C],
      ])
    );

    expect(refs.size).toBe(3);
    expect(refs.get('refs/heads/main')).toBe(SHA_A);
    expect(refs.get('refs/heads/dev')).toBe(SHA_B);
    expect(refs.get('refs/tags/v2')).toBe(SHA_C);
  });

  it('lets the NIP shape win a same-ref disagreement, whichever came first', () => {
    expect(
      parsedRefs(
        refsEventWithTags([
          ['refs/heads/main', SHA_A],
          ['r', 'refs/heads/main', SHA_B],
        ])
      ).get('refs/heads/main')
    ).toBe(SHA_A);

    expect(
      parsedRefs(
        refsEventWithTags([
          ['r', 'refs/heads/main', SHA_B],
          ['refs/heads/main', SHA_A],
        ])
      ).get('refs/heads/main')
    ).toBe(SHA_A);
  });

  it('does not list a peeled ^{} entry as a ref', () => {
    const refs = parsedRefs(
      refsEventWithTags([
        ['refs/tags/v1.0.0', SHA_A],
        ['refs/tags/v1.0.0^{}', SHA_B],
      ])
    );

    expect([...refs]).toEqual([['refs/tags/v1.0.0', SHA_A]]);
  });

  it('ignores NIP-shape tags with no value and non-ref tag names', () => {
    const refs = parsedRefs(
      refsEventWithTags([
        ['refs/heads/empty'],
        ['refs/notes/commits', SHA_A],
        ['--upload-pack=/evil', SHA_B],
        ['refs/heads/ok', SHA_C],
      ])
    );

    expect([...refs]).toEqual([['refs/heads/ok', SHA_C]]);
  });

  it('caps DISTINCT refs across both shapes combined at 1000', () => {
    const tags: string[][] = [];
    for (let i = 0; i < 600; i += 1) tags.push([`refs/heads/n${i}`, SHA_A]);
    for (let i = 0; i < 600; i += 1)
      tags.push(['r', `refs/heads/l${i}`, SHA_B]);

    const refs = parsedRefs(refsEventWithTags(tags));
    expect(refs.size).toBe(1000);
    expect(refs.get('refs/heads/n599')).toBe(SHA_A);
    expect(refs.get('refs/heads/l399')).toBe(SHA_B);
    expect(refs.has('refs/heads/l400')).toBe(false);
  });

  it('still reads the arweave map from an event that trips the ref cap', () => {
    const tags: string[][] = [];
    for (let i = 0; i < 1200; i += 1) tags.push([`refs/heads/n${i}`, SHA_A]);
    tags.push(['arweave', SHA_C, 'tx-c']);

    const result = parseRepoRefs(refsEventWithTags(tags));
    expect(result).not.toBeNull();
    expect(result?.refs.size).toBe(1000);
    expect(result?.arweaveMap.get(SHA_C)).toBe('tx-c');
  });

  it('parses the real ngit state event to its branches and tags', () => {
    const refs = parsedRefs(NGIT_STATE_NGIT);

    expect(
      [...refs.keys()].filter((r) => r.startsWith('refs/heads/')).sort()
    ).toEqual([
      'refs/heads/main',
      'refs/heads/stable',
      'refs/heads/timeout-testing',
      'refs/heads/tmp',
    ]);
    expect(
      [...refs.keys()].filter((r) => r.startsWith('refs/tags/'))
    ).toHaveLength(60);
    expect(refs.size).toBe(64);
    expect([...refs.keys()].some((r) => r.endsWith('^{}'))).toBe(false);
  });
});
