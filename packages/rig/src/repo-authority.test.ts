import { describe, it, expect } from 'vitest';

import { MAINTAINERS_TAG } from './nip34-events.js';
import {
  authorizedAuthors,
  honoredRepoState,
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
