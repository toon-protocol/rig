/**
 * useComments at the relay seam (rig#159): a thread mixing NIP-22 kind:1111
 * and legacy kind:1622 comments renders as ONE conversation in `createdAt`
 * order, and a kind:1111 whose only match is a lowercase `e` never joins the
 * thread. The two kinds need two filters — kind:1111 hangs off the uppercase
 * `E` root scope, kind:1622 off its lone lowercase `e` — so the hook opens two
 * subscriptions and merges them; the relay is played from a scripted backlog.
 */

import { renderHook, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NostrEvent, NostrFilter } from '../nip34-parsers.js';
import type * as RelayClient from '../relay-client.js';

const seam = vi.hoisted(() => ({
  backlog: [] as NostrEvent[],
  filters: [] as NostrFilter[],
}));

vi.mock('./use-rig-config.js', () => ({
  useRigConfig: () => ({ relayUrl: 'ws://localhost:7100' }),
}));

vi.mock('../relay-client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof RelayClient>();
  return {
    ...actual,
    // A NIP-01-faithful one-shot read: kinds AND the tag filter must match,
    // with tag names compared case-sensitively (`#E` never matches `e`).
    queryRelay: vi.fn(async (_url: string, filter: NostrFilter) => {
      seam.filters.push(filter);
      return seam.backlog.filter((e) => {
        if (filter.kinds && !filter.kinds.includes(e.kind)) return false;
        for (const tagName of ['e', 'E'] as const) {
          const wanted = filter[`#${tagName}`];
          if (
            wanted &&
            !e.tags.some((t) => t[0] === tagName && wanted.includes(t[1] ?? ''))
          ) {
            return false;
          }
        }
        return true;
      });
    }),
  };
});

import { useComments } from './use-comments.js';

const AUTHOR = 'ab'.repeat(32);
const ROOT_ID = '11'.repeat(32);
const OTHER_ROOT_ID = '22'.repeat(32);

function event(overrides: Partial<NostrEvent> & { id: string; kind: number }) {
  return {
    pubkey: AUTHOR,
    created_at: 1000,
    tags: [],
    content: '',
    sig: 'f0'.repeat(64),
    ...overrides,
  } satisfies NostrEvent;
}

function nip22Comment(opts: {
  id: string;
  createdAt: number;
  content: string;
  rootId: string;
  parentId?: string;
}): NostrEvent {
  return event({
    id: opts.id,
    kind: 1111,
    created_at: opts.createdAt,
    content: opts.content,
    tags: [
      ['E', opts.rootId, '', AUTHOR],
      ['K', '1621'],
      ['P', AUTHOR],
      ['e', opts.parentId ?? opts.rootId, '', AUTHOR],
      ['k', opts.parentId === undefined ? '1621' : '1111'],
      ['p', AUTHOR],
    ],
  });
}

beforeEach(() => {
  seam.backlog = [];
  seam.filters = [];
});

describe('useComments merges kind:1111 and legacy kind:1622 (#159)', () => {
  it('returns one conversation in createdAt order across both kinds', async () => {
    seam.backlog = [
      nip22Comment({
        id: '33'.repeat(32),
        createdAt: 3000,
        content: 'nip-22 reply',
        rootId: ROOT_ID,
        parentId: '44'.repeat(32),
      }),
      event({
        id: '55'.repeat(32),
        kind: 1622,
        created_at: 1000,
        content: 'legacy comment',
        tags: [['e', ROOT_ID, '', 'root']],
      }),
      nip22Comment({
        id: '44'.repeat(32),
        createdAt: 2000,
        content: 'nip-22 top-level',
        rootId: ROOT_ID,
      }),
    ];

    const { result } = renderHook(() => useComments([ROOT_ID]));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.comments.map((c) => c.content)).toEqual([
      'legacy comment',
      'nip-22 top-level',
      'nip-22 reply',
    ]);
    expect(result.current.comments.map((c) => c.kind)).toEqual([
      1622, 1111, 1111,
    ]);
    // The nested reply keeps its parent comment and the thread's root.
    expect(result.current.comments[2]?.parentEventId).toBe('44'.repeat(32));
    expect(result.current.comments[2]?.rootEventId).toBe(ROOT_ID);
  });

  it('queries kind:1111 by #E and legacy kind:1622 by #e', async () => {
    renderHook(() => useComments([ROOT_ID]));

    await waitFor(() => expect(seam.filters).toHaveLength(2));
    expect(seam.filters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kinds: [1111], '#E': [ROOT_ID] }),
        expect.objectContaining({ kinds: [1622], '#e': [ROOT_ID] }),
      ])
    );
  });

  it('excludes a kind:1111 whose only match is a lowercase `e`', async () => {
    seam.backlog = [
      // Root scope is another thread; only its parent `e` names this root.
      nip22Comment({
        id: '66'.repeat(32),
        createdAt: 2000,
        content: 'someone else’s thread',
        rootId: OTHER_ROOT_ID,
        parentId: ROOT_ID,
      }),
    ];

    const { result } = renderHook(() => useComments([ROOT_ID]));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.comments).toEqual([]);
  });

  it('queries nothing when there are no thread roots', async () => {
    const { result } = renderHook(() => useComments([]));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(seam.filters).toEqual([]);
    expect(result.current.comments).toEqual([]);
  });
});
