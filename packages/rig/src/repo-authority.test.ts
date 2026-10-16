import { describe, it, expect } from 'vitest';

import { MAINTAINERS_TAG } from './nip34-events.js';
import {
  authorizedAuthors,
  honoredRepoState,
  selectRevision,
  type AuthorityEvent,
} from './repo-authority.js';

const OWNER = 'a1'.repeat(32);
const MAINT = 'b2'.repeat(32);
const MAINT2 = 'c3'.repeat(32);
const STRANGER = 'd4'.repeat(32);

const ev = (
  id: string,
  pubkey: string,
  created_at: number
): AuthorityEvent => ({ id, pubkey, created_at, tags: [] });

describe('authorizedAuthors', () => {
  it('is the owner alone without a maintainers tag', () => {
    expect([...authorizedAuthors(OWNER)]).toEqual([OWNER]);
  });

  it('adds the maintainers of the owner announcement, lowercased', () => {
    const set = authorizedAuthors(OWNER.toUpperCase(), [
      [MAINTAINERS_TAG, MAINT, MAINT2.toUpperCase()],
    ]);
    expect([...set].sort()).toEqual([OWNER, MAINT, MAINT2].sort());
  });
});

describe('honoredRepoState', () => {
  const owner = authorizedAuthors(OWNER);
  const withMaint = authorizedAuthors(OWNER, [[MAINTAINERS_TAG, MAINT]]);
  // MAINT2 appears only in MAINT's own announcement, which is never read.
  const table: {
    name: string;
    authorized: Set<string>;
    events: AuthorityEvent[];
    winner: string | null;
  }[] = [
    {
      name: 'owner-only state',
      authorized: owner,
      events: [ev('01', OWNER, 10), ev('02', OWNER, 20)],
      winner: '02',
    },
    {
      name: "a maintainer's state newer than the owner's",
      authorized: withMaint,
      events: [ev('01', OWNER, 10), ev('02', MAINT, 20)],
      winner: '02',
    },
    {
      name: "a stranger's newer state ignored",
      authorized: withMaint,
      events: [ev('01', OWNER, 10), ev('02', STRANGER, 99)],
      winner: '01',
    },
    {
      name: 'a removed maintainer ignored',
      authorized: owner,
      events: [ev('01', OWNER, 10), ev('02', MAINT, 20)],
      winner: '01',
    },
    {
      name: 'transitive maintainers ignored',
      authorized: withMaint,
      events: [ev('01', OWNER, 10), ev('02', MAINT2, 20)],
      winner: '01',
    },
    {
      name: 'a created_at tie broken by lowest id',
      authorized: withMaint,
      events: [ev('0b', MAINT, 10), ev('0a', OWNER, 10), ev('0c', OWNER, 10)],
      winner: '0a',
    },
    {
      name: 'no authorized candidate',
      authorized: owner,
      events: [ev('01', STRANGER, 10)],
      winner: null,
    },
  ];

  it.each(table)('$name', ({ authorized, events, winner }) => {
    expect(honoredRepoState(authorized, events)?.id ?? null).toBe(winner);
  });
});

describe('selectRevision', () => {
  const ROOT_ID = '01'.repeat(32);
  const CONTRIBUTOR = 'e5'.repeat(32);
  const root: AuthorityEvent = {
    id: ROOT_ID,
    pubkey: CONTRIBUTOR,
    created_at: 100,
    tags: [],
  };
  const rev = (
    id: string,
    pubkey: string,
    created_at: number,
    rootId = ROOT_ID
  ): AuthorityEvent => ({
    id,
    pubkey,
    created_at,
    tags: [
      ['t', 'root-revision'],
      ['e', rootId, '', 'reply'],
    ],
  });
  const authorized = authorizedAuthors(OWNER, [[MAINTAINERS_TAG, MAINT]]);

  it('is the root itself when there are no revisions', () => {
    const { latest, earlier } = selectRevision(root, [], authorized);
    expect(latest).toBe(root);
    expect(earlier).toEqual([]);
  });

  it('picks the latest of a chain and lists the earlier ones oldest first', () => {
    const r1 = rev('11'.repeat(32), CONTRIBUTOR, 200);
    const r2 = rev('12'.repeat(32), CONTRIBUTOR, 300);
    const r3 = rev('13'.repeat(32), CONTRIBUTOR, 400);
    const { latest, earlier } = selectRevision(root, [r3, r1, r2], authorized);
    expect(latest).toBe(r3);
    expect(earlier).toEqual([root, r1, r2]);
  });

  it("ignores a stranger's revision interleaved in the chain", () => {
    const r1 = rev('11'.repeat(32), CONTRIBUTOR, 200);
    const spoof = rev('66'.repeat(32), STRANGER, 300);
    const r2 = rev('12'.repeat(32), CONTRIBUTOR, 400);
    const afterSpoof = selectRevision(root, [r1, spoof], authorized);
    expect(afterSpoof.latest).toBe(r1);
    const { latest, earlier } = selectRevision(
      root,
      [r1, spoof, r2],
      authorized
    );
    expect(latest).toBe(r2);
    expect(earlier).toEqual([root, r1]);
  });

  it("counts a maintainer's revision of a contributor's patch", () => {
    const r1 = rev('11'.repeat(32), CONTRIBUTOR, 200);
    const fix = rev('22'.repeat(32), MAINT, 300);
    const { latest, earlier } = selectRevision(root, [r1, fix], authorized);
    expect(latest).toBe(fix);
    expect(earlier).toEqual([root, r1]);
  });

  it('ignores revisions of another root and events lacking the marker', () => {
    const other = rev('31'.repeat(32), CONTRIBUTOR, 200, '02'.repeat(32));
    const unmarked: AuthorityEvent = {
      id: '32'.repeat(32),
      pubkey: CONTRIBUTOR,
      created_at: 300,
      tags: [['e', ROOT_ID, '', 'reply']],
    };
    const { latest } = selectRevision(root, [other, unmarked], authorized);
    expect(latest).toBe(root);
  });

  it('breaks a created_at tie by lowest event id', () => {
    const a = rev('aa'.repeat(32), CONTRIBUTOR, 200);
    const b = rev('bb'.repeat(32), CONTRIBUTOR, 200);
    expect(selectRevision(root, [b, a], authorized).earlier).toEqual([root, a]);
  });
});
