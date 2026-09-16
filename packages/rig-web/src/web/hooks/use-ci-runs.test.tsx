/**
 * useCiRuns at the relay seam (rig#132): the runs subscription stays open, so
 * a coordinator's kind:39842 replacement updates the run without a reload;
 * malformed CI events are skipped without breaking the rest; a repo with no
 * CI events yields empty maps.
 */

import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NostrEvent, NostrFilter } from '../nip34-parsers.js';
import type * as RelayClient from '../relay-client.js';

interface LiveSub {
  filter: NostrFilter;
  onEvent: (event: NostrEvent) => void;
  onEose?: () => void;
  closed: boolean;
}

const seam = vi.hoisted(() => ({
  live: [] as LiveSub[],
  backlog: [] as NostrEvent[],
}));

vi.mock('./use-rig-config.js', () => ({
  useRigConfig: () => ({ relayUrl: 'ws://localhost:7100' }),
}));

vi.mock('../relay-client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof RelayClient>();
  return {
    ...actual,
    // One-shot reads (the 9843/9844 history) answer from the scripted backlog.
    queryRelay: vi.fn(async (_url: string, filter: NostrFilter) =>
      seam.backlog.filter((e) => filter.kinds?.includes(e.kind))
    ),
    // The live REQ hands the test its callbacks so it can play the relay.
    subscribeRelay: vi.fn(
      (
        _url: string,
        filter: NostrFilter,
        onEvent: (event: NostrEvent) => void,
        onEose?: () => void
      ) => {
        const sub: LiveSub = { filter, onEvent, onEose, closed: false };
        seam.live.push(sub);
        return {
          close: () => {
            sub.closed = true;
          },
        };
      }
    ),
  };
});

import { useCiRuns } from './use-ci-runs.js';
import { subscribeRelay } from '../relay-client.js';

const OWNER = 'ab'.repeat(32);
const MAINTAINER = 'cd'.repeat(32);
const COORD = '12'.repeat(32);
const ADDR = `30617:${OWNER}:demo`;
const COMMIT = '9a'.repeat(20);
const RUN_ID = 'run-0001';

let counter = 0;
function event(overrides: Partial<NostrEvent> & { kind: number }): NostrEvent {
  counter += 1;
  return {
    id: counter.toString(16).padStart(64, '0'),
    pubkey: COORD,
    created_at: 1000 + counter,
    tags: [],
    content: '',
    sig: 'f0'.repeat(64),
    ...overrides,
  };
}

const COMMON_TAGS: string[][] = [
  ['a', ADDR],
  ['c', COMMIT],
  ['w', '.github/workflows/ci.yml', 'f0'.repeat(32)],
  ['o', 'push'],
  ['r', 'refs/heads/main'],
];

function progress(
  status: 'queued' | 'in_progress' | 'concluded',
  createdAt: number,
  extra: string[][] = []
): NostrEvent {
  return event({
    kind: 39842,
    created_at: createdAt,
    tags: [['d', RUN_ID], ...COMMON_TAGS, ['status', status], ...extra],
  });
}

function liveSub(): LiveSub {
  const sub = seam.live[0];
  if (!sub) throw new Error('no live subscription opened');
  return sub;
}

beforeEach(() => {
  seam.live.length = 0;
  seam.backlog.length = 0;
  vi.mocked(subscribeRelay).mockClear();
});

describe('[P1] useCiRuns: live 39842 replacements', () => {
  it('a replacement progress marker updates the run in place, on the one open subscription', async () => {
    const { result } = renderHook(() => useCiRuns(OWNER, 'demo', [MAINTAINER]));
    expect(subscribeRelay).toHaveBeenCalledTimes(1);
    expect(liveSub().filter).toMatchObject({
      kinds: [9842, 39842],
      '#a': [ADDR],
    });

    act(() => {
      liveSub().onEvent(
        progress('in_progress', 1500, [['in-progress', 'build']])
      );
      liveSub().onEose?.();
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.runs).toHaveLength(1);
    expect(result.current.runs[0]).toMatchObject({
      runId: RUN_ID,
      status: 'in_progress',
      inProgress: ['build'],
      current: true,
    });

    // The coordinator replaces its marker (same d, newer created_at).
    act(() => {
      liveSub().onEvent(
        progress('concluded', 1600, [['conclusion', 'success']])
      );
    });
    expect(result.current.runs).toHaveLength(1);
    expect(result.current.runs[0]).toMatchObject({
      runId: RUN_ID,
      status: 'concluded',
      conclusion: 'success',
      inProgress: [],
    });
    expect(result.current.runsForCommit(COMMIT)).toHaveLength(1);
    expect(subscribeRelay).toHaveBeenCalledTimes(1);

    // A stale replacement the relay hands back late cannot roll it back.
    act(() => {
      liveSub().onEvent(progress('queued', 1400, [['queue', '2']]));
    });
    expect(result.current.runs[0]).toMatchObject({
      status: 'concluded',
      conclusion: 'success',
    });
  });

  it('closes the subscription on unmount', () => {
    const { unmount } = renderHook(() => useCiRuns(OWNER, 'demo'));
    expect(liveSub().closed).toBe(false);
    unmount();
    expect(liveSub().closed).toBe(true);
  });
});

describe('[P1] useCiRuns: malformed events and trust', () => {
  it('skips malformed CI events and still derives trust from the well-formed controls', async () => {
    const goodRequest = event({
      kind: 9843,
      pubkey: MAINTAINER,
      created_at: 1100,
      tags: [
        ['a', ADDR],
        ['p', COORD],
      ],
    });
    seam.backlog.push(
      goodRequest,
      // Two `a` tags: not a Service Request per the NIP.
      event({
        kind: 9843,
        pubkey: MAINTAINER,
        tags: [
          ['a', ADDR],
          ['a', ADDR],
          ['p', COORD],
        ],
      }),
      // No coordinator `p` tag.
      event({ kind: 9844, pubkey: MAINTAINER, tags: [['a', ADDR]] })
    );

    const { result } = renderHook(() => useCiRuns(OWNER, 'demo', [MAINTAINER]));
    act(() => {
      const sub = liveSub();
      // Progress marker without a `d`.
      sub.onEvent(
        event({ kind: 39842, tags: [...COMMON_TAGS, ['status', 'queued']] })
      );
      // Result with an unknown conclusion.
      sub.onEvent(
        event({
          kind: 9842,
          tags: [...COMMON_TAGS, ['r', 'run-x'], ['conclusion', 'exploded']],
        })
      );
      // Result missing the workflow tag.
      sub.onEvent(
        event({
          kind: 9842,
          tags: [
            ['a', ADDR],
            ['c', COMMIT],
            ['r', 'run-y'],
            ['conclusion', 'success'],
          ],
        })
      );
      // A kind the filter never asked for.
      sub.onEvent(event({ kind: 1, content: 'hello' }));
      // The one good run: no provenance quote, published while the
      // maintainer's request stood.
      sub.onEvent(
        event({
          kind: 9842,
          created_at: 1500,
          tags: [...COMMON_TAGS, ['r', RUN_ID], ['conclusion', 'failure']],
        })
      );
      sub.onEose?.();
    });
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.controls).toHaveLength(1);
    expect(result.current.controls[0]).toMatchObject({
      kind: 'request',
      pubkey: MAINTAINER,
      coordinatorPubkey: COORD,
    });
    expect(result.current.runs).toHaveLength(1);
    expect(result.current.runs[0]).toMatchObject({
      runId: RUN_ID,
      conclusion: 'failure',
      trust: 'operationally-associated',
    });
    expect(result.current.error).toBeNull();
  });
});

describe('[P1] useCiRuns: a repo with no CI events', () => {
  it('yields no runs, empty per-commit and per-PR maps, and no error', async () => {
    const { result } = renderHook(() => useCiRuns(OWNER, 'demo'));
    act(() => {
      liveSub().onEose?.();
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.runs).toEqual([]);
    expect(result.current.controls).toEqual([]);
    expect(result.current.runsForCommit(COMMIT)).toEqual([]);
    expect(result.current.runsForPr('55'.repeat(32))).toEqual([]);
    expect(result.current.error).toBeNull();
  });

  it('opens nothing for an owner that is not a pubkey or npub', () => {
    const { result } = renderHook(() => useCiRuns('npub1notvalid', 'demo'));
    expect(subscribeRelay).not.toHaveBeenCalled();
    expect(result.current.runs).toEqual([]);
    expect(result.current.loading).toBe(false);
  });
});
