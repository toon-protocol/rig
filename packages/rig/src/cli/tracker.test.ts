/**
 * Tracker tests (#278): `rig issue list|show` and `rig pr list|show` against
 * a mock relay — latest-wins state derivation from kind:1630-1633, state
 * filters, comments under show, the full patch text under `pr show`, and
 * tolerance for the devnet relay's double-JSON-encoded EVENT payloads.
 */

import { describe, it, expect } from 'vitest';
import {
  NGIT_STATUS_NGIT,
  NGIT_STATUS_NGIT_TARGET_EVENT_ID,
} from '../nip34-fixtures/index.js';
import type { NostrEvent } from '../remote-state.js';
import type { CliIo } from './output.js';
import {
  filterEvents,
  makeMockRelayFactory,
  type PayloadEncoding,
} from './read-testkit.js';
import type { ReadCommandDeps } from './read-seams.js';
import {
  deriveStatus,
  runIssueList,
  runIssueShow,
  runPrList,
  runPrShow,
  withTargetAuthor,
} from './tracker.js';

const OWNER = 'ab'.repeat(32);
const AUTHOR = 'cd'.repeat(32);
// A genuine third party: never the owner, never declared as a maintainer,
// and never the author of any fixture item below — used for spoof/ignored
// scenarios so they are not accidentally satisfied by the rig#160 "target's
// own author is authorized" rule (AUTHOR authors several fixture items).
const STRANGER = 'ef'.repeat(32);
const REPO = 'demo-repo';
const A_TAG = `30617:${OWNER}:${REPO}`;
const RELAY = 'wss://relay.test.example';

const ISSUE_CLOSED_ID = '11'.repeat(32);
const ISSUE_OPEN_ID = '22'.repeat(32);
const PR_APPLIED_ID = '33'.repeat(32);
const PR_OPEN_ID = '44'.repeat(32);
const COMMENT_ID = '55'.repeat(32);

const PATCH_TEXT = `From ${'9a'.repeat(20)} Mon Sep 17 00:00:00 2001
From: Fixture <fixture@test>
Subject: [PATCH] add feature

---
 code.txt | 1 +
 1 file changed, 1 insertion(+)
`;

function event(
  overrides: Partial<NostrEvent> & { id: string; kind: number }
): NostrEvent {
  return {
    pubkey: AUTHOR,
    created_at: 1000,
    tags: [],
    content: '',
    sig: 'f0'.repeat(64),
    ...overrides,
  };
}

const EVENTS: NostrEvent[] = [
  event({
    id: ISSUE_CLOSED_ID,
    kind: 1621,
    created_at: 1100,
    tags: [
      ['a', A_TAG],
      ['subject', 'CLI has no read path'],
      ['t', 'ux-study'],
    ],
    content: 'A second contributor cannot bootstrap the repo.',
  }),
  event({
    id: ISSUE_OPEN_ID,
    kind: 1621,
    created_at: 1200,
    tags: [
      ['a', A_TAG],
      ['subject', 'Still open issue'],
    ],
    content: 'Open body.',
  }),
  // Status history for the closed issue: opened, then closed LATER (latest
  // wins). Signed by the OWNER — the authoritative status author (#287).
  event({
    id: 'a1'.repeat(32),
    kind: 1630,
    pubkey: OWNER,
    created_at: 1150,
    tags: [
      ['e', ISSUE_CLOSED_ID],
      ['a', A_TAG],
    ],
  }),
  event({
    id: 'a2'.repeat(32),
    kind: 1632,
    pubkey: OWNER,
    created_at: 1300,
    tags: [
      ['e', ISSUE_CLOSED_ID],
      ['a', A_TAG],
    ],
  }),
  // SPOOF (#287): a funded stranger — NOT the owner, a maintainer, or the
  // issue's own author (which defaults to AUTHOR, rig#160) — publishes a
  // later re-open against the closed issue. It must be IGNORED — the issue
  // stays closed for authority-honoring readers.
  event({
    id: 'de'.repeat(32),
    kind: 1630,
    pubkey: STRANGER,
    created_at: 1400, // LATER than the owner's close
    tags: [
      ['e', ISSUE_CLOSED_ID],
      ['a', A_TAG],
    ],
  }),
  event({
    id: PR_APPLIED_ID,
    kind: 1617,
    created_at: 1400,
    tags: [
      ['a', A_TAG],
      ['subject', 'Add feature'],
      ['branch', 'feature'],
      ['commit', '9a'.repeat(20)],
      // `rig pr create --body` (#280): the PR body rides in a description
      // tag so `content` stays pure format-patch for `git am`.
      ['description', 'Why: the feature was missing.'],
    ],
    content: PATCH_TEXT,
  }),
  event({
    id: PR_OPEN_ID,
    kind: 1617,
    created_at: 1500,
    tags: [
      ['a', A_TAG],
      ['subject', 'Pending patch'],
    ],
    content: 'From abc patch',
  }),
  // The applied PR's status carries NO `a` tag (other clients do this) —
  // reachable only through the follow-up `#e` query. Signed by the OWNER.
  event({
    id: 'a3'.repeat(32),
    kind: 1631,
    pubkey: OWNER,
    created_at: 1450,
    tags: [['e', PR_APPLIED_ID]],
  }),
  // Comment on the closed issue.
  event({
    id: COMMENT_ID,
    kind: 1622,
    created_at: 1350,
    tags: [
      ['e', ISSUE_CLOSED_ID],
      ['a', A_TAG],
    ],
    content: 'Nice catch — fixing in #278.',
  }),
];

interface TestIo extends CliIo {
  outLines: string[];
  errLines: string[];
  jsonDocs: unknown[];
}

function makeTestIo(): TestIo {
  const outLines: string[] = [];
  const errLines: string[] = [];
  const jsonDocs: unknown[] = [];
  return {
    outLines,
    errLines,
    jsonDocs,
    out: (line) => outLines.push(line),
    err: (line) => errLines.push(line),
    emitJson: (payload) => jsonDocs.push(payload),
    isInteractive: false,
    confirm: async () => false,
  };
}

function makeDeps(
  io: TestIo,
  encoding: PayloadEncoding = 'object',
  events: NostrEvent[] = EVENTS
): ReadCommandDeps {
  return {
    io,
    env: {},
    cwd: '/nonexistent-not-a-repo',
    webSocketFactory: makeMockRelayFactory(
      (filter) => filterEvents(events, filter),
      encoding
    ),
  };
}

const ADDR_FLAGS = ['--repo-id', REPO, '--owner', OWNER, '--relay', RELAY];

// ---------------------------------------------------------------------------
// deriveStatus (latest-wins)
// ---------------------------------------------------------------------------

// The authoritative author set for these unit tests: owner-only (#287).
const AUTHZ = new Set([OWNER]);

describe('deriveStatus', () => {
  it('defaults to open with no status events', () => {
    expect(deriveStatus(ISSUE_OPEN_ID, EVENTS, AUTHZ)).toBe('open');
  });

  it('latest AUTHORIZED status wins (a later owner close beats an earlier open)', () => {
    expect(deriveStatus(ISSUE_CLOSED_ID, EVENTS, AUTHZ)).toBe('closed');
  });

  it('IGNORES an unauthorized later status — spoof regression (#287)', () => {
    // EVENTS already contains a later (created_at 1400) kind:1630 re-open on
    // the closed issue signed by STRANGER (not owner, not a maintainer, not
    // the issue's own author). It must NOT reopen the issue for an
    // authority-honoring reader: owner-only ⇒ stays closed.
    expect(deriveStatus(ISSUE_CLOSED_ID, EVENTS, AUTHZ)).toBe('closed');
    // But if that author WERE authorized (owner ∪ maintainers ∪ target's own
    // author), the re-open would win — proving the author filter is what
    // protects the state.
    expect(
      deriveStatus(ISSUE_CLOSED_ID, EVENTS, new Set([OWNER, STRANGER]))
    ).toBe('open');
  });

  it('an empty authority set moves NOTHING (safe fallback, #287)', () => {
    expect(deriveStatus(ISSUE_CLOSED_ID, EVENTS, new Set())).toBe('open');
  });

  it('a re-open AFTER a close wins again (when AUTHORIZED)', () => {
    const reopened = [
      ...EVENTS,
      event({
        id: 'a4'.repeat(32),
        kind: 1630,
        pubkey: OWNER,
        created_at: 1500,
        tags: [['e', ISSUE_CLOSED_ID]],
      }),
    ];
    expect(deriveStatus(ISSUE_CLOSED_ID, reopened, AUTHZ)).toBe('open');
  });

  it('created_at ties break on the LOWEST event id', () => {
    const tied = [
      event({
        id: 'ff'.repeat(32),
        kind: 1630,
        pubkey: OWNER,
        created_at: 2000,
        tags: [['e', ISSUE_CLOSED_ID]],
      }),
      event({
        id: '00'.repeat(32),
        kind: 1632,
        pubkey: OWNER,
        created_at: 2000,
        tags: [['e', ISSUE_CLOSED_ID]],
      }),
    ];
    expect(deriveStatus(ISSUE_CLOSED_ID, tied, AUTHZ)).toBe('closed');
  });

  it('ignores statuses that reference other events', () => {
    expect(deriveStatus(PR_OPEN_ID, EVENTS, AUTHZ)).toBe('open');
  });
});

// ---------------------------------------------------------------------------
// rig#160 — status root marker (NIP-10) + repo a tag: both read forms
// ---------------------------------------------------------------------------

describe('deriveStatus honors the NIP-10 marker form identically to the legacy bare form (rig#160)', () => {
  const TARGET_ID = 'f0'.repeat(32);

  it('a marker-form e tag (["e", id, "", "root"]) resolves state', () => {
    const markerClose = event({
      id: 'f1'.repeat(32),
      kind: 1632,
      pubkey: OWNER,
      created_at: 1000,
      tags: [
        ['e', TARGET_ID, '', 'root'],
        ['a', A_TAG],
      ],
    });
    expect(deriveStatus(TARGET_ID, [markerClose], new Set([OWNER]))).toBe(
      'closed'
    );
  });

  it('the winner is the LATEST authorized status regardless of which form each event uses', () => {
    const bareOpen = event({
      id: 'f2'.repeat(32),
      kind: 1630,
      pubkey: OWNER,
      created_at: 1000,
      tags: [['e', TARGET_ID]], // legacy bare form
    });
    const markerClose = event({
      id: 'f3'.repeat(32),
      kind: 1632,
      pubkey: OWNER,
      created_at: 1100,
      tags: [['e', TARGET_ID, '', 'root']], // NIP-10 marker form
    });
    expect(
      deriveStatus(TARGET_ID, [bareOpen, markerClose], new Set([OWNER]))
    ).toBe('closed');
    // Same result independent of iteration order.
    expect(
      deriveStatus(TARGET_ID, [markerClose, bareOpen], new Set([OWNER]))
    ).toBe('closed');
    // And with the forms' roles swapped — a LATER bare-form status beats an
    // earlier marker-form one, proving form never influences the winner.
    const markerOpenEarlier = event({
      id: 'f4'.repeat(32),
      kind: 1630,
      pubkey: OWNER,
      created_at: 1000,
      tags: [['e', TARGET_ID, '', 'root']],
    });
    const bareCloseLater = event({
      id: 'f5'.repeat(32),
      kind: 1632,
      pubkey: OWNER,
      created_at: 1100,
      tags: [['e', TARGET_ID]],
    });
    expect(
      deriveStatus(
        TARGET_ID,
        [markerOpenEarlier, bareCloseLater],
        new Set([OWNER])
      )
    ).toBe('closed');
  });

  it('a marker-form status from an unauthorized pubkey is ignored, same as the bare form', () => {
    const spoofMarker = event({
      id: 'f6'.repeat(32),
      kind: 1632,
      pubkey: STRANGER,
      created_at: 1000,
      tags: [['e', TARGET_ID, '', 'root']],
    });
    expect(deriveStatus(TARGET_ID, [spoofMarker], new Set([OWNER]))).toBe(
      'open'
    );
  });
});

describe('the captured ngit marker-form status (rig#155 fixtures) changes its target state (rig#160)', () => {
  it('resolves the real captured kind:1618 PR to "applied", authorized by the marker-form status’s real owner signature', () => {
    const authorized = new Set([NGIT_STATUS_NGIT.pubkey.toLowerCase()]);
    expect(
      deriveStatus(
        NGIT_STATUS_NGIT_TARGET_EVENT_ID,
        [NGIT_STATUS_NGIT],
        authorized
      )
    ).toBe('applied');
  });

  it('is ignored when the signer is not in the authorized set', () => {
    expect(
      deriveStatus(
        NGIT_STATUS_NGIT_TARGET_EVENT_ID,
        [NGIT_STATUS_NGIT],
        new Set([STRANGER])
      )
    ).toBe('open');
  });
});

describe('withTargetAuthor (rig#160)', () => {
  it('adds the target author to a copy of the authorized set, without mutating the input', () => {
    const authorized = new Set([OWNER]);
    const result = withTargetAuthor(authorized, AUTHOR.toUpperCase()); // mixed case

    expect(result).toEqual(new Set([OWNER, AUTHOR])); // lowercased
    expect(authorized).toEqual(new Set([OWNER])); // original untouched
    expect(result).not.toBe(authorized); // a new Set, not the same object
  });
});

// ---------------------------------------------------------------------------
// issue list
// ---------------------------------------------------------------------------

describe('rig issue list', () => {
  it('lists issues with derived state (default: all, newest first)', async () => {
    const io = makeTestIo();
    const code = await runIssueList([...ADDR_FLAGS, '--json'], makeDeps(io));
    expect(code).toBe(0);
    const doc = io.jsonDocs[0] as {
      issues: { eventId: string; status: string }[];
    };
    expect(doc).toMatchObject({ command: 'issue list', count: 2 });
    expect(doc.issues.map((i) => [i.eventId, i.status])).toEqual([
      [ISSUE_OPEN_ID, 'open'],
      [ISSUE_CLOSED_ID, 'closed'],
    ]);
  });

  it('filters by --state', async () => {
    const io = makeTestIo();
    const code = await runIssueList(
      [...ADDR_FLAGS, '--state', 'closed', '--json'],
      makeDeps(io)
    );
    expect(code).toBe(0);
    const doc = io.jsonDocs[0] as { issues: { eventId: string }[] };
    expect(doc.issues.map((i) => i.eventId)).toEqual([ISSUE_CLOSED_ID]);
  });

  it('tolerates the devnet relay double-JSON EVENT encoding', async () => {
    const io = makeTestIo();
    const code = await runIssueList(
      [...ADDR_FLAGS, '--json'],
      makeDeps(io, 'double-json')
    );
    expect(code).toBe(0);
    expect((io.jsonDocs[0] as { count: number }).count).toBe(2);
  });

  it('renders a human table without --json', async () => {
    const io = makeTestIo();
    const code = await runIssueList(ADDR_FLAGS, makeDeps(io));
    expect(code).toBe(0);
    const text = io.outLines.join('\n');
    expect(text).toContain('closed');
    expect(text).toContain('CLI has no read path');
    expect(text).toContain('[ux-study]');
  });

  it('requires the repo address', async () => {
    const io = makeTestIo();
    const code = await runIssueList(['--relay', RELAY, '--json'], makeDeps(io));
    expect(code).toBe(1);
    expect(io.jsonDocs[0]).toMatchObject({
      error: 'unconfigured_repo_address',
    });
  });

  it('rejects an invalid --state', async () => {
    const io = makeTestIo();
    const code = await runIssueList(
      [...ADDR_FLAGS, '--state', 'bogus'],
      makeDeps(io)
    );
    expect(code).toBe(2);
  });

  it('HONORS a declared maintainer status via the 30617 maintainers tag (#287)', async () => {
    const MAINT_ISSUE_ID = '77'.repeat(32);
    // Self-contained set: a 30617 announcing AUTHOR as a maintainer, an open
    // issue, and a close signed by that maintainer (NOT the owner).
    const events: NostrEvent[] = [
      event({
        id: '99'.repeat(32),
        kind: 30617,
        pubkey: OWNER,
        created_at: 1000,
        tags: [
          ['d', REPO],
          ['name', 'demo'],
          ['maintainers', AUTHOR],
        ],
      }),
      event({
        id: MAINT_ISSUE_ID,
        kind: 1621,
        created_at: 1100,
        tags: [
          ['a', A_TAG],
          ['subject', 'Closed by a maintainer'],
        ],
      }),
      event({
        id: 'ab'.repeat(32),
        kind: 1632,
        pubkey: AUTHOR, // the declared maintainer, not the owner
        created_at: 1200,
        tags: [
          ['e', MAINT_ISSUE_ID],
          ['a', A_TAG],
        ],
      }),
    ];
    const io = makeTestIo();
    const code = await runIssueList(
      [...ADDR_FLAGS, '--json'],
      makeDeps(io, 'object', events)
    );
    expect(code).toBe(0);
    const doc = io.jsonDocs[0] as {
      issues: { eventId: string; status: string }[];
    };
    expect(doc.issues).toEqual([
      expect.objectContaining({ eventId: MAINT_ISSUE_ID, status: 'closed' }),
    ]);
  });

  it('IGNORES a maintainer-status once the 30617 no longer lists them (#287)', async () => {
    const ISSUE_ID = '88'.repeat(32);
    // Same as above but the 30617 declares NO maintainers → the closer is a
    // stranger (not the owner, not a declared maintainer, and — rig#160 —
    // not the issue's own author either, since the issue is authored by
    // AUTHOR here, not STRANGER) → their close is ignored, stays open.
    const events: NostrEvent[] = [
      event({
        id: '9a'.repeat(32),
        kind: 30617,
        pubkey: OWNER,
        created_at: 1000,
        tags: [
          ['d', REPO],
          ['name', 'demo'],
        ],
      }),
      event({
        id: ISSUE_ID,
        kind: 1621,
        created_at: 1100,
        tags: [
          ['a', A_TAG],
          ['subject', 'Should stay open'],
        ],
      }),
      event({
        id: 'ba'.repeat(32),
        kind: 1632,
        pubkey: STRANGER,
        created_at: 1200,
        tags: [
          ['e', ISSUE_ID],
          ['a', A_TAG],
        ],
      }),
    ];
    const io = makeTestIo();
    const code = await runIssueList(
      [...ADDR_FLAGS, '--json'],
      makeDeps(io, 'object', events)
    );
    expect(code).toBe(0);
    const doc = io.jsonDocs[0] as {
      issues: { eventId: string; status: string }[];
    };
    expect(doc.issues).toEqual([
      expect.objectContaining({ eventId: ISSUE_ID, status: 'open' }),
    ]);
  });

  it("HONORS the issue's own author closing it, even without maintainer status (rig#160)", async () => {
    const ISSUE_ID = 'f7'.repeat(32);
    const REPORTER = 'c1'.repeat(32); // not owner, not a declared maintainer
    const events: NostrEvent[] = [
      event({
        id: '9d'.repeat(32),
        kind: 30617,
        pubkey: OWNER,
        created_at: 1000,
        tags: [
          ['d', REPO],
          ['name', 'demo'],
          // No maintainers tag — REPORTER's only authority is target-author.
        ],
      }),
      event({
        id: ISSUE_ID,
        kind: 1621,
        pubkey: REPORTER,
        created_at: 1100,
        tags: [
          ['a', A_TAG],
          ['subject', 'Filed and closed by its own author'],
        ],
      }),
      event({
        id: 'f8'.repeat(32),
        kind: 1632,
        pubkey: REPORTER, // the issue's own author, closing in marker form
        created_at: 1200,
        tags: [
          ['e', ISSUE_ID, '', 'root'],
          ['a', A_TAG],
        ],
      }),
    ];
    const io = makeTestIo();
    const code = await runIssueList(
      [...ADDR_FLAGS, '--json'],
      makeDeps(io, 'object', events)
    );
    expect(code).toBe(0);
    const doc = io.jsonDocs[0] as {
      issues: { eventId: string; status: string }[];
    };
    expect(doc.issues).toEqual([
      expect.objectContaining({ eventId: ISSUE_ID, status: 'closed' }),
    ]);
  });

  it('IGNORES a marker-form status from a pubkey that is neither owner, maintainer, nor the target author (rig#160)', async () => {
    const ISSUE_ID = 'f9'.repeat(32);
    const REPORTER = 'c1'.repeat(32);
    const events: NostrEvent[] = [
      event({
        id: '9e'.repeat(32),
        kind: 30617,
        pubkey: OWNER,
        created_at: 1000,
        tags: [
          ['d', REPO],
          ['name', 'demo'],
        ],
      }),
      event({
        id: ISSUE_ID,
        kind: 1621,
        pubkey: REPORTER,
        created_at: 1100,
        tags: [
          ['a', A_TAG],
          ['subject', 'Should stay open'],
        ],
      }),
      event({
        id: 'fa'.repeat(32),
        kind: 1632,
        pubkey: STRANGER, // not owner, not maintainer, not the reporter
        created_at: 1200,
        tags: [
          ['e', ISSUE_ID, '', 'root'],
          ['a', A_TAG],
        ],
      }),
    ];
    const io = makeTestIo();
    const code = await runIssueList(
      [...ADDR_FLAGS, '--json'],
      makeDeps(io, 'object', events)
    );
    expect(code).toBe(0);
    const doc = io.jsonDocs[0] as {
      issues: { eventId: string; status: string }[];
    };
    expect(doc.issues).toEqual([
      expect.objectContaining({ eventId: ISSUE_ID, status: 'open' }),
    ]);
  });
});

// ---------------------------------------------------------------------------
// issue show
// ---------------------------------------------------------------------------

describe('rig issue show', () => {
  it('shows metadata, derived state, body, and comments', async () => {
    const io = makeTestIo();
    const code = await runIssueShow(
      [ISSUE_CLOSED_ID, '--relay', RELAY, '--json'],
      makeDeps(io)
    );
    expect(code).toBe(0);
    const doc = io.jsonDocs[0] as Record<string, unknown>;
    expect(doc).toMatchObject({
      command: 'issue show',
      repoATag: A_TAG,
      issue: {
        eventId: ISSUE_CLOSED_ID,
        title: 'CLI has no read path',
        status: 'closed',
        authorPubkey: AUTHOR,
      },
    });
    expect(doc['comments']).toEqual([
      expect.objectContaining({
        eventId: COMMENT_ID,
        content: 'Nice catch — fixing in #278.',
      }),
    ]);
  });

  it('errors when the id is not on the relay', async () => {
    const io = makeTestIo();
    const code = await runIssueShow(
      ['66'.repeat(32), '--relay', RELAY, '--json'],
      makeDeps(io)
    );
    expect(code).toBe(1);
    expect(io.errLines.join('\n')).toContain('not found');
  });

  it('redirects a patch id to `rig pr show`', async () => {
    const io = makeTestIo();
    const code = await runIssueShow(
      [PR_APPLIED_ID, '--relay', RELAY],
      makeDeps(io)
    );
    expect(code).toBe(1);
    expect(io.errLines.join('\n')).toContain('rig pr show');
  });

  // ── Authority via the configured repo when the item lacks an `a` tag (#287) ──
  // An item without a parseable `a` tag must still resolve its authority from
  // the configured --repo-id/--owner, matching `list`. Otherwise `show` derives
  // an EMPTY authorized set and reports a falsely-`open` status even for an
  // item the real owner correctly closed. Regression for the show/list divergence.
  it('[#287] resolves state via --repo-id/--owner when the item has no `a` tag', async () => {
    const NO_ATAG_ID = '77'.repeat(32);
    const events: NostrEvent[] = [
      event({
        id: NO_ATAG_ID,
        kind: 1621,
        created_at: 1100,
        tags: [['subject', 'a-tag-less issue']], // NO `a` tag on the issue event
        content: 'This issue event carries no repo `a` tag.',
      }),
      event({
        id: 'b1'.repeat(32),
        kind: 1632, // OWNER closes it
        pubkey: OWNER,
        created_at: 1300,
        tags: [['e', NO_ATAG_ID]],
      }),
    ];
    const io = makeTestIo();
    const code = await runIssueShow(
      [NO_ATAG_ID, ...ADDR_FLAGS, '--json'],
      makeDeps(io, 'object', events)
    );
    expect(code).toBe(0);
    expect(io.jsonDocs[0]).toMatchObject({
      repoATag: null,
      issue: { eventId: NO_ATAG_ID, status: 'closed' },
    });
  });

  it('[#287] stays open for an a-tag-less item with no configured repo (safe empty-authority default)', async () => {
    const ORPHAN_ID = '88'.repeat(32);
    const events: NostrEvent[] = [
      event({
        id: ORPHAN_ID,
        kind: 1621,
        created_at: 1100,
        tags: [['subject', 'orphan issue']],
        content: 'No `a` tag and no configured repo → nothing authorizes state.',
      }),
      event({
        id: 'b2'.repeat(32),
        kind: 1632,
        pubkey: OWNER,
        created_at: 1300,
        tags: [['e', ORPHAN_ID]],
      }),
    ];
    const io = makeTestIo();
    // Only --relay (cwd is not a repo) → no repoAddr, no a-tag ⇒ empty set.
    const code = await runIssueShow(
      [ORPHAN_ID, '--relay', RELAY, '--json'],
      makeDeps(io, 'object', events)
    );
    expect(code).toBe(0);
    expect(io.jsonDocs[0]).toMatchObject({
      repoATag: null,
      issue: { eventId: ORPHAN_ID, status: 'open' },
    });
  });
});

// ---------------------------------------------------------------------------
// pr list / show
// ---------------------------------------------------------------------------

describe('rig pr list/show', () => {
  it('lists PRs with statuses derived through the `#e` fallback query', async () => {
    const io = makeTestIo();
    const code = await runPrList([...ADDR_FLAGS, '--json'], makeDeps(io));
    expect(code).toBe(0);
    const doc = io.jsonDocs[0] as {
      prs: { eventId: string; status: string }[];
    };
    expect(doc).toMatchObject({ command: 'pr list', count: 2 });
    expect(doc.prs.map((p) => [p.eventId, p.status])).toEqual([
      [PR_OPEN_ID, 'open'],
      [PR_APPLIED_ID, 'applied'], // status event had no `a` tag
    ]);
  });

  // #161: rig pr list (text mode) must display the branch too, not just
  // pr show and rig-web.
  it('renders a human table with the branch for patches that carry one', async () => {
    const io = makeTestIo();
    const code = await runPrList([...ADDR_FLAGS], makeDeps(io));
    expect(code).toBe(0);
    const text = io.outLines.join('\n');
    expect(text).toContain('→ feature'); // PR_APPLIED_ID's branch tag
    // The open PR carries no branch tag — no arrow for it.
    const openLine = io.outLines.find((l) => l.includes('Pending patch'));
    expect(openLine).toBeDefined();
    expect(openLine).not.toContain('→');
  });

  it('filters by --state applied', async () => {
    const io = makeTestIo();
    const code = await runPrList(
      [...ADDR_FLAGS, '--state', 'applied', '--json'],
      makeDeps(io)
    );
    expect(code).toBe(0);
    expect((io.jsonDocs[0] as { prs: unknown[] }).prs).toHaveLength(1);
  });

  it('pr show prints the FULL patch text plus commit/branch metadata', async () => {
    const io = makeTestIo();
    const code = await runPrShow(
      [PR_APPLIED_ID, '--relay', RELAY],
      makeDeps(io)
    );
    expect(code).toBe(0);
    const text = io.outLines.join('\n');
    expect(text).toContain('Status:  applied');
    expect(text).toContain('Branch:  feature');
    expect(text).toContain(`Commits: ${'9a'.repeat(20)}`);
    expect(text).toContain('Subject: [PATCH] add feature'); // verbatim patch
    // #280: the description tag renders as its own Body section, ABOVE the
    // patch text (which stays verbatim below it).
    expect(text).toContain('Body:');
    expect(text).toContain('Why: the feature was missing.');
    expect(text.indexOf('Why: the feature was missing.')).toBeLessThan(
      text.indexOf('Subject: [PATCH] add feature')
    );
  });

  it('pr show without a description tag prints no Body section', async () => {
    const io = makeTestIo();
    const code = await runPrShow([PR_OPEN_ID, '--relay', RELAY], makeDeps(io));
    expect(code).toBe(0);
    expect(io.outLines.join('\n')).not.toContain('Body:');
  });

  it('pr show --json carries the patch content for `git am` piping', async () => {
    const io = makeTestIo();
    const code = await runPrShow(
      [PR_APPLIED_ID, '--relay', RELAY, '--json'],
      makeDeps(io)
    );
    expect(code).toBe(0);
    expect(io.jsonDocs[0]).toMatchObject({
      command: 'pr show',
      pr: expect.objectContaining({
        content: PATCH_TEXT, // untouched — pipeable into `git am`
        status: 'applied',
        description: 'Why: the feature was missing.',
      }),
    });
  });
});

// ---------------------------------------------------------------------------
// #161: patch branch name round-trips (branch-name tag, with legacy fallback)
// ---------------------------------------------------------------------------

describe('rig pr show — branch-name round-trip (#161)', () => {
  const NEW_PATCH_ID = '61'.repeat(32);
  const LEGACY_BRANCH_TAG_ID = '62'.repeat(32);
  const LEGACY_T_ONLY_ID = '63'.repeat(32);
  const BOTH_TAGS_ID = '64'.repeat(32);

  const branchEvents: NostrEvent[] = [
    // A patch published under the fix: branch lives in `branch-name`.
    event({
      id: NEW_PATCH_ID,
      kind: 1617,
      created_at: 1000,
      tags: [
        ['a', A_TAG],
        ['subject', 'New-style patch'],
        ['branch-name', 'feature/new'],
        ['t', 'real-label'],
      ],
      content: 'patch text',
    }),
    // A pre-fix patch that already carried the branch in the legacy `branch`
    // tag (never actually written by buildPatch, but readers have always
    // looked for it — must keep working).
    event({
      id: LEGACY_BRANCH_TAG_ID,
      kind: 1617,
      created_at: 1100,
      tags: [
        ['a', A_TAG],
        ['subject', 'Legacy branch-tag patch'],
        ['branch', 'feature/legacy'],
      ],
      content: 'patch text',
    }),
    // The actual historical bug: the branch was written to `t` (and nowhere
    // else). No heuristic recovers it — it renders exactly as it does today,
    // i.e. as a label, with no Branch: line.
    event({
      id: LEGACY_T_ONLY_ID,
      kind: 1617,
      created_at: 1200,
      tags: [
        ['a', A_TAG],
        ['subject', 'Legacy t-only patch'],
        ['t', 'feature/was-a-branch'],
      ],
      content: 'patch text',
    }),
    // Both shapes present, disagreeing — branch-name must win.
    event({
      id: BOTH_TAGS_ID,
      kind: 1617,
      created_at: 1300,
      tags: [
        ['a', A_TAG],
        ['subject', 'Both tags patch'],
        ['branch-name', 'feature/wins'],
        ['branch', 'feature/loses'],
      ],
      content: 'patch text',
    }),
  ];

  it('reads the branch from branch-name on a new patch, and t stays a real label', async () => {
    const io = makeTestIo();
    const code = await runPrShow(
      [NEW_PATCH_ID, '--relay', RELAY],
      makeDeps(io, 'object', branchEvents)
    );
    expect(code).toBe(0);
    const text = io.outLines.join('\n');
    expect(text).toContain('Branch:  feature/new');
    expect(text).toContain('Labels:  real-label');
  });

  it('falls back to the legacy branch tag when branch-name is absent', async () => {
    const io = makeTestIo();
    const code = await runPrShow(
      [LEGACY_BRANCH_TAG_ID, '--relay', RELAY],
      makeDeps(io, 'object', branchEvents)
    );
    expect(code).toBe(0);
    expect(io.outLines.join('\n')).toContain('Branch:  feature/legacy');
  });

  it('a legacy patch with the branch only in t renders exactly as it does today: no Branch line, t as a label', async () => {
    const io = makeTestIo();
    const code = await runPrShow(
      [LEGACY_T_ONLY_ID, '--relay', RELAY],
      makeDeps(io, 'object', branchEvents)
    );
    expect(code).toBe(0);
    const text = io.outLines.join('\n');
    expect(text).not.toContain('Branch:');
    expect(text).toContain('Labels:  feature/was-a-branch');
  });

  it('prefers branch-name over a disagreeing legacy branch tag', async () => {
    const io = makeTestIo();
    const code = await runPrShow(
      [BOTH_TAGS_ID, '--relay', RELAY],
      makeDeps(io, 'object', branchEvents)
    );
    expect(code).toBe(0);
    const text = io.outLines.join('\n');
    expect(text).toContain('Branch:  feature/wins');
    expect(text).not.toContain('feature/loses');
  });
});
