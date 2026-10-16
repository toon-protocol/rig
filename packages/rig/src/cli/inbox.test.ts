/**
 * `rig inbox` tests (#234): scope (owned / maintained / p-tagged), dedup
 * across relays, status authorization, the per-identity cursor, and the JSON
 * shape — all against mock relays, with no identity unlock.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NostrEvent } from '../remote-state.js';
import { runInbox, parseSince, type InboxEntry } from './inbox.js';
import type { CliIo } from './output.js';
import { filterEvents, makeMockRelayFactory } from './read-testkit.js';

const ME = '11'.repeat(32);
const OWNER = 'ab'.repeat(32);
const CONTRIB = 'cd'.repeat(32);
const STRANGER = 'ef'.repeat(32);
const RELAY_A = 'wss://a.test.example';
const RELAY_B = 'wss://b.test.example';
const MY_REPO = `30617:${ME}:mine`;
const THEIR_REPO = `30617:${OWNER}:theirs`;

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function ev(
  id: string,
  kind: number,
  pubkey: string,
  created_at: number,
  tags: string[][] = []
): NostrEvent {
  return {
    id,
    kind,
    pubkey,
    created_at,
    tags,
    content: '',
    sig: 'f0'.repeat(64),
  };
}

const announceMine = ev('a1'.repeat(32), 30617, ME, 100, [
  ['d', 'mine'],
  ['maintainers', CONTRIB],
  ['relays', RELAY_B],
]);
const announceTheirs = ev('a2'.repeat(32), 30617, OWNER, 100, [
  ['d', 'theirs'],
  ['maintainers', ME],
]);
const PATCH = ev('b1'.repeat(32), 1617, CONTRIB, 200, [['a', MY_REPO]]);
const REVISION = ev('b2'.repeat(32), 1617, CONTRIB, 210, [
  ['a', MY_REPO],
  ['t', 'root-revision'],
  ['e', PATCH.id, '', 'reply'],
]);
const ISSUE = ev('b3'.repeat(32), 1621, STRANGER, 220, [['a', THEIR_REPO]]);
const COMMENT = ev('b4'.repeat(32), 1111, STRANGER, 230, [
  ['E', PATCH.id],
  ['a', MY_REPO],
]);
const STATUS_OK = ev('b5'.repeat(32), 1631, ME, 240, [
  ['e', PATCH.id, '', 'root'],
  ['a', MY_REPO],
]);
const STATUS_SPAM = ev('b6'.repeat(32), 1632, STRANGER, 250, [
  ['e', PATCH.id, '', 'root'],
  ['a', MY_REPO],
]);
const CI = ev('b7'.repeat(32), 9842, STRANGER, 260, [
  ['a', MY_REPO],
  ['c', 'cc'.repeat(20)],
]);
const LOG_TAIL = ev('b8'.repeat(32), 39841, STRANGER, 270, [['a', MY_REPO]]);
const P_ONLY = ev('b9'.repeat(32), 1111, STRANGER, 280, [
  ['E', '99'.repeat(32)],
  ['p', ME],
  ['a', `30617:${STRANGER}:elsewhere`],
]);

interface Out {
  io: CliIo & { jsonDocs: unknown[]; outLines: string[] };
}

function makeIo(): Out['io'] {
  const jsonDocs: unknown[] = [];
  const outLines: string[] = [];
  return {
    jsonDocs,
    outLines,
    out: (l) => outLines.push(l),
    err: () => undefined,
    emitJson: (p) => jsonDocs.push(p),
    isInteractive: false,
    confirm: async () => false,
  };
}

function world(perRelay: Record<string, NostrEvent[]>) {
  const home = mkdtempSync(join(tmpdir(), 'rig-inbox-'));
  dirs.push(home);
  return {
    home,
    deps: (io: CliIo) => ({
      io,
      env: { TOON_CLIENT_HOME: home },
      cwd: home,
      webSocketFactory: makeMockRelayFactory((filter, url) =>
        filterEvents(perRelay[url] ?? [], filter)
      ),
    }),
  };
}

const ALL = [
  announceMine,
  announceTheirs,
  PATCH,
  REVISION,
  ISSUE,
  COMMENT,
  STATUS_OK,
  STATUS_SPAM,
  CI,
  LOG_TAIL,
  P_ONLY,
];
const ARGS = ['--pubkey', ME, '--relay', RELAY_A, '--json'];

async function read(
  w: ReturnType<typeof world>,
  args: string[] = ARGS
): Promise<InboxEntry[]> {
  const io = makeIo();
  expect(await runInbox(args, w.deps(io))).toBe(0);
  return io.jsonDocs[0] as InboxEntry[];
}

describe('rig inbox', () => {
  it('collects owned, maintained and p-tagged events with the stable shape', async () => {
    const w = world({ [RELAY_A]: ALL });
    const entries = await read(w);
    expect(entries.map((e) => e.id)).toEqual([
      PATCH.id,
      REVISION.id,
      ISSUE.id,
      COMMENT.id,
      STATUS_OK.id,
      CI.id,
      P_ONLY.id,
    ]);
    expect(entries.map((e) => e.type)).toEqual([
      'patch',
      'revision',
      'issue',
      'comment',
      'status',
      'ci',
      'comment',
    ]);
    expect(entries[1]).toEqual({
      id: REVISION.id,
      kind: 1617,
      type: 'revision',
      repo: MY_REPO,
      target: PATCH.id,
      author: CONTRIB,
      created_at: 210,
    });
  });

  it('filters statuses from unauthorized authors and skips the live log tail', async () => {
    const w = world({ [RELAY_A]: ALL });
    const ids = (await read(w)).map((e) => e.id);
    expect(ids).not.toContain(STATUS_SPAM.id);
    expect(ids).not.toContain(LOG_TAIL.id);
  });

  it('includes events that only p-tag the user', async () => {
    const w = world({ [RELAY_A]: [P_ONLY] });
    expect((await read(w)).map((e) => e.id)).toEqual([P_ONLY.id]);
  });

  it('dedups events across two relays and reads a repo’s relays tag', async () => {
    const w = world({
      [RELAY_A]: [announceMine, PATCH, ISSUE],
      [RELAY_B]: [PATCH, REVISION, ISSUE],
    });
    const ids = (
      await read(w, [
        '--pubkey',
        ME,
        '--relay',
        RELAY_A,
        '--relay',
        RELAY_B,
        '--json',
      ])
    ).map((e) => e.id);
    expect(ids).toEqual([PATCH.id, REVISION.id]);
    // RELAY_B is only reachable through the announcement's relays tag here.
    const viaTag = await read(
      world({ [RELAY_A]: [announceMine], [RELAY_B]: [PATCH, REVISION] })
    );
    expect(viaTag.map((e) => e.id)).toEqual([PATCH.id, REVISION.id]);
  });

  it('advances the cursor after a read; --since and --all do not move it', async () => {
    const w = world({ [RELAY_A]: ALL });
    const first = await read(w);
    expect(first.length).toBe(7);
    expect(await read(w)).toEqual([]);

    const since = await read(w, [...ARGS, '--since', '225']);
    expect(since.map((e) => e.id)).toEqual([
      COMMENT.id,
      STATUS_OK.id,
      CI.id,
      P_ONLY.id,
    ]);
    const all = await read(w, [...ARGS, '--all']);
    expect(all.length).toBe(7);
    // Still caught up: neither override moved the cursor.
    expect(await read(w)).toEqual([]);

    // A new event arrives; only it is new.
    const later = ev('c1'.repeat(32), 1621, STRANGER, 300, [['a', MY_REPO]]);
    const w2 = { ...w, deps: world({ [RELAY_A]: [...ALL, later] }).deps };
    const io = makeIo();
    await runInbox(ARGS, { ...w2.deps(io), env: { TOON_CLIENT_HOME: w.home } });
    expect((io.jsonDocs[0] as InboxEntry[]).map((e) => e.id)).toEqual([
      later.id,
    ]);
  });

  it('prints one line per event in human mode', async () => {
    const w = world({ [RELAY_A]: ALL });
    const io = makeIo();
    expect(
      await runInbox(['--pubkey', ME, '--relay', RELAY_A], w.deps(io))
    ).toBe(0);
    expect(io.outLines).toHaveLength(7);
    expect(io.outLines[0]).toContain('patch');
  });

  it('parseSince accepts unix, ISO and relative forms', () => {
    expect(parseSince('1700000000', 0)).toBe(1700000000);
    expect(parseSince('2h', 10000)).toBe(10000 - 7200);
    expect(parseSince('1970-01-02T00:00:00Z', 0)).toBe(86400);
    expect(() => parseSince('nope', 0)).toThrow(/--since/);
  });
});
