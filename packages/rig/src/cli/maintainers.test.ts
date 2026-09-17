/**
 * `rig maintainers list|add|remove` tests (#287): the FREE list read, the
 * PAID add/remove republish of the kind:30617 (owner-only), preservation of
 * name/description, and the non-owner refusal. The Publisher is mocked at the
 * StandaloneContext seam and a hermetic mock relay serves the current 30617.
 */

import { describe, it, expect } from 'vitest';
import type { NostrEvent } from '../remote-state.js';
import type { Publisher } from '../publisher.js';
import type { UnsignedEvent } from '../nip34-events.js';
import { parseMaintainers } from '../nip34-events.js';
import type { CliIo } from './output.js';
import type { EventCommandDeps } from './events.js';
import { runMaintainers } from './maintainers.js';
import { repoWebUrl } from '../rig-pointer.js';
import type { StandaloneContext } from './standalone-context.js';
import {
  filterEvents,
  foreignAnnouncementTags,
  makeMockRelayFactory,
  survivingForeignTags,
} from './read-testkit.js';

const OWNER = 'ab'.repeat(32);
const M1 = 'cd'.repeat(32);
const M2 = 'ef'.repeat(32);
const REPO = 'demo';
const RELAY = 'wss://relay.test.example';
const PUBLISHED_ID = '99'.repeat(32);

interface Recorder {
  io: CliIo;
  out: string[];
  err: string[];
  json: unknown[];
}

function makeIo(interactive = false, answer = false): Recorder {
  const out: string[] = [];
  const err: string[] = [];
  const json: unknown[] = [];
  const io: CliIo = {
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    emitJson: (payload) => json.push(payload),
    isInteractive: interactive,
    confirm: async () => answer,
  };
  return { io, out, err, json };
}

interface Fake {
  published: { event: UnsignedEvent; relayUrls: string[] }[];
  context: StandaloneContext;
}

function makeStandalone(identity = OWNER): Fake {
  const published: Fake['published'] = [];
  const publisher: Publisher = {
    getFeeRates: async () => ({ uploadFee: 1000n, eventFee: 5n }),
    uploadGitObject: async () => {
      throw new Error('maintainers never uploads objects');
    },
    publishEvent: async (event, relayUrls) => {
      published.push({ event, relayUrls });
      return { eventId: PUBLISHED_ID, feePaid: 5n };
    },
  };
  return {
    published,
    context: {
      ownerPubkey: identity,
      identitySource: 'dotenv',
      identitySourceLabel: '/repo/.env',
      publisher,
      defaultRelayUrls: [RELAY],
      fetchRemote: async () => {
        throw new Error('maintainers uses fetchRemoteState, not fetchRemote');
      },
      stop: async () => undefined,
    },
  };
}

const FOREIGN_TAGS = foreignAnnouncementTags(OWNER, M2);

/** An announcement as another NIP-34 client (ngit) wrote it. */
function foreignAnnouncement(maintainers: string[]): NostrEvent {
  const base = announcement(OWNER, maintainers);
  return { ...base, tags: [...base.tags, ...FOREIGN_TAGS] };
}

function announcement(
  owner: string,
  maintainers: string[],
  overrides: { name?: string; description?: string; payout?: string } = {}
): NostrEvent {
  return {
    id: '30'.repeat(32),
    pubkey: owner,
    created_at: 1000,
    kind: 30617,
    tags: [
      ['d', REPO],
      ['name', overrides.name ?? 'Demo Repo'],
      ['description', overrides.description ?? 'A demo'],
      ...(maintainers.length > 0 ? [['maintainers', ...maintainers]] : []),
      ...(overrides.payout ? [['payout', 'evm', overrides.payout]] : []),
    ],
    content: '',
    sig: '0'.repeat(128),
  };
}

function makeDeps(
  rec: Recorder,
  fake: Fake,
  remoteEvents: NostrEvent[]
): EventCommandDeps {
  return {
    io: rec.io,
    env: {},
    cwd: '/nonexistent-not-a-repo',
    loadStandalone: async () => fake.context,
    webSocketFactory: makeMockRelayFactory(
      (filter) => filterEvents(remoteEvents, filter),
      'object'
    ),
  };
}

const ADDR = ['--repo-id', REPO, '--owner', OWNER, '--relay', RELAY];

/** The `web` tag value #158 backfills — the Pointer's own route shape. */
function webUrl(): string {
  return repoWebUrl({ env: {}, relay: RELAY, ownerPubkey: OWNER, repoId: REPO });
}

describe('rig maintainers list (free)', () => {
  it('prints the owner + declared maintainers', async () => {
    const io = makeIo();
    const fake = makeStandalone();
    const code = await runMaintainers(
      ['list', ...ADDR, '--json'],
      makeDeps(io, fake, [announcement(OWNER, [M1])])
    );
    expect(code).toBe(0);
    expect(io.json[0]).toMatchObject({
      command: 'maintainers list',
      owner: OWNER,
      maintainers: [M1],
      announced: true,
    });
    expect(fake.published).toHaveLength(0); // free — nothing published
  });

  it('reports owner-only when there is no announcement', async () => {
    const io = makeIo();
    const fake = makeStandalone();
    const code = await runMaintainers(
      ['list', ...ADDR, '--json'],
      makeDeps(io, fake, [])
    );
    expect(code).toBe(0);
    expect(io.json[0]).toMatchObject({ announced: false, maintainers: [] });
  });
});

describe('rig maintainers add/remove (paid, owner-only)', () => {
  it('add republishes the 30617 with the new maintainer, preserving metadata', async () => {
    const io = makeIo();
    const fake = makeStandalone();
    const code = await runMaintainers(
      ['add', M1, ...ADDR, '--yes'],
      makeDeps(io, fake, [
        announcement(OWNER, [], { name: 'Keep Me', description: 'Keep this' }),
      ])
    );
    expect(code).toBe(0);
    expect(fake.published).toHaveLength(1);
    const { event, relayUrls } = fake.published[0]!;
    expect(event.kind).toBe(30617);
    expect(parseMaintainers(event.tags)).toEqual([M1]);
    // name/description preserved from the existing announcement.
    expect(event.tags).toContainEqual(['name', 'Keep Me']);
    expect(event.tags).toContainEqual(['description', 'Keep this']);
    expect(relayUrls).toEqual([RELAY]);
  });

  it('add preserves an existing payout pointer (rig#92)', async () => {
    const payoutAddr = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';
    const io = makeIo();
    const fake = makeStandalone();
    const code = await runMaintainers(
      ['add', M1, ...ADDR, '--yes'],
      makeDeps(io, fake, [announcement(OWNER, [], { payout: payoutAddr })])
    );
    expect(code).toBe(0);
    expect(fake.published).toHaveLength(1);
    const first = fake.published[0];
    if (!first) throw new Error('expected a published event');
    expect(first.event.tags).toContainEqual(['payout', 'evm', payoutAddr]);
  });

  it('remove republishes the 30617 without the removed maintainer', async () => {
    const io = makeIo();
    const fake = makeStandalone();
    const code = await runMaintainers(
      ['remove', M1, ...ADDR, '--yes'],
      makeDeps(io, fake, [announcement(OWNER, [M1, M2])])
    );
    expect(code).toBe(0);
    expect(fake.published).toHaveLength(1);
    expect(parseMaintainers(fake.published[0]!.event.tags)).toEqual([M2]);
  });

  it('add preserves every tag rig does not model, in order (#154)', async () => {
    const io = makeIo();
    const fake = makeStandalone();
    const code = await runMaintainers(
      ['add', M1, ...ADDR, '--yes'],
      makeDeps(io, fake, [foreignAnnouncement([])])
    );
    expect(code).toBe(0);
    const published = fake.published[0];
    if (!published) throw new Error('expected a published event');
    expect(survivingForeignTags(published.event.tags, FOREIGN_TAGS)).toEqual(
      FOREIGN_TAGS
    );
    // …and the field being edited is the only thing that changed.
    expect(parseMaintainers(published.event.tags)).toEqual([M1]);
    expect(published.event.tags).toContainEqual(['name', 'Demo Repo']);
    expect(published.event.tags).toContainEqual(['description', 'A demo']);
  });

  it('remove preserves every tag rig does not model, in order (#154)', async () => {
    const io = makeIo();
    const fake = makeStandalone();
    const code = await runMaintainers(
      ['remove', M1, ...ADDR, '--yes'],
      makeDeps(io, fake, [foreignAnnouncement([M1, M2])])
    );
    expect(code).toBe(0);
    const published = fake.published[0];
    if (!published) throw new Error('expected a published event');
    expect(survivingForeignTags(published.event.tags, FOREIGN_TAGS)).toEqual(
      FOREIGN_TAGS
    );
    expect(parseMaintainers(published.event.tags)).toEqual([M2]);
  });

  it('invents no name/description on an announcement that has none (#154)', async () => {
    // ngit writes prose into `content` and may omit both tags. The old
    // rebuild injected ["name", <repoId>] + ["description", <content>] — a
    // field the user never edited, and the prose duplicated on the wire.
    const prose = 'prose that lives in content, not a description tag';
    const bare: NostrEvent = {
      id: '30'.repeat(32),
      pubkey: OWNER,
      created_at: 1000,
      kind: 30617,
      tags: [['d', REPO], ...FOREIGN_TAGS],
      content: prose,
      sig: '0'.repeat(128),
    };
    const io = makeIo();
    const fake = makeStandalone();
    const code = await runMaintainers(
      ['add', M1, ...ADDR, '--yes'],
      makeDeps(io, fake, [bare])
    );
    expect(code).toBe(0);
    const published = fake.published[0];
    if (!published) throw new Error('expected a published event');
    expect(published.event.tags).toEqual([
      ['d', REPO],
      ...FOREIGN_TAGS,
      ['maintainers', M1],
      // …and the #158 conformance backfill, which is the ONLY other addition.
      ['relays', RELAY],
      ['web', webUrl()],
    ]);
    expect(published.event.content).toBe(prose);
  });

  it('add is a no-op (nothing published) when already a maintainer', async () => {
    const io = makeIo();
    const fake = makeStandalone();
    const code = await runMaintainers(
      ['add', M1, ...ADDR, '--yes'],
      makeDeps(io, fake, [announcement(OWNER, [M1])])
    );
    expect(code).toBe(0);
    expect(fake.published).toHaveLength(0);
    expect(io.err.join('\n')).toContain('already a maintainer');
  });

  it('remove is a no-op when the pubkey is not a maintainer', async () => {
    const io = makeIo();
    const fake = makeStandalone();
    const code = await runMaintainers(
      ['remove', M1, ...ADDR, '--yes'],
      makeDeps(io, fake, [announcement(OWNER, [M2])])
    );
    expect(code).toBe(0);
    expect(fake.published).toHaveLength(0);
    expect(io.err.join('\n')).toContain('not a declared maintainer');
  });

  it('REFUSES a non-owner republish (only the owner is authoritative, #287)', async () => {
    const io = makeIo();
    // The standalone identity is M1, but the repo owner (--owner) is OWNER.
    const fake = makeStandalone(M1);
    const code = await runMaintainers(
      ['add', M2, ...ADDR, '--yes'],
      makeDeps(io, fake, [announcement(OWNER, [])])
    );
    expect(code).toBe(1);
    expect(fake.published).toHaveLength(0);
    expect(io.err.join('\n')).toContain('only the repo owner');
  });

  it('REFUSES add/remove on an unannounced repo (no phantom 30617, #287)', async () => {
    // No existing announcement on the relay → republishing would mint a
    // placeholder 30617 for real money that `rig push` could never fix.
    for (const op of ['add', 'remove'] as const) {
      const io = makeIo();
      const fake = makeStandalone();
      const code = await runMaintainers(
        [op, M1, ...ADDR, '--yes'],
        makeDeps(io, fake, []) // remoteEvents: [] ⇒ announced === false
      );
      expect(code).toBe(1);
      expect(fake.published).toHaveLength(0);
      expect(io.err.join('\n')).toContain('has no announcement');
      expect(io.err.join('\n')).toContain('rig push');
    }
  });

  it('estimate only: --json without --yes publishes nothing', async () => {
    const io = makeIo();
    const fake = makeStandalone();
    const code = await runMaintainers(
      ['add', M1, ...ADDR, '--json'],
      makeDeps(io, fake, [announcement(OWNER, [])])
    );
    expect(code).toBe(0);
    expect(fake.published).toHaveLength(0);
    expect(io.json[0]).toMatchObject({
      command: 'maintainers add',
      executed: false,
      maintainers: [M1],
    });
  });

  it('backfills relays/web/euc on a repo announced before #158', async () => {
    const io = makeIo();
    const fake = makeStandalone();
    const LOCAL_ROOT = 'a1'.repeat(20);
    const deps = {
      ...makeDeps(io, fake, [announcement(OWNER, [])]),
      // The local checkout's history, at the injectable git seam.
      rootCommits: async () => [LOCAL_ROOT],
    };
    const code = await runMaintainers(['add', M1, ...ADDR, '--yes'], deps);
    expect(code).toBe(0);
    const published = fake.published[0];
    expect(published).toBeDefined();
    const tags = published?.event.tags ?? [];
    expect(tags).toContainEqual(['relays', RELAY]);
    expect(tags).toContainEqual(['web', webUrl()]);
    expect(tags).toContainEqual(['r', LOCAL_ROOT, 'euc']);
    // …and the edit it was actually asked to make still happened.
    expect(parseMaintainers(tags)).toEqual([M1]);
  });

  it('NEVER recomputes an announced euc, even when local git disagrees', async () => {
    // A repo's fork identity must not change under its owner.
    const ANNOUNCED_EUC = 'be'.repeat(20);
    const io = makeIo();
    const fake = makeStandalone();
    const base = announcement(OWNER, []);
    const deps = {
      ...makeDeps(io, fake, [
        { ...base, tags: [...base.tags, ['r', ANNOUNCED_EUC, 'euc']] },
      ]),
      rootCommits: async () => ['ff'.repeat(20)], // a DIFFERENT local root
    };
    const code = await runMaintainers(['add', M1, ...ADDR, '--yes'], deps);
    expect(code).toBe(0);
    const tags = fake.published[0]?.event.tags ?? [];
    expect(tags.filter((t) => t[0] === 'r' && t[2] === 'euc')).toEqual([
      ['r', ANNOUNCED_EUC, 'euc'],
    ]);
  });

  it('backfills relays/web without an euc when run outside a git repo', async () => {
    const io = makeIo();
    const fake = makeStandalone();
    const code = await runMaintainers(
      ['add', M1, ...ADDR, '--yes'],
      makeDeps(io, fake, [announcement(OWNER, [])]) // cwd is not a repo
    );
    expect(code).toBe(0);
    const tags = fake.published[0]?.event.tags ?? [];
    expect(tags).toContainEqual(['relays', RELAY]);
    expect(tags).toContainEqual(['web', webUrl()]);
    expect(tags.some((t) => t[0] === 'r' && t[2] === 'euc')).toBe(false);
  });

  it('never writes a clone tag, and never removes one', async () => {
    const io = makeIo();
    const fake = makeStandalone();
    const code = await runMaintainers(
      ['add', M1, ...ADDR, '--yes'],
      makeDeps(io, fake, [foreignAnnouncement([])])
    );
    expect(code).toBe(0);
    const tags = fake.published[0]?.event.tags ?? [];
    expect(tags.filter((t) => t[0] === 'clone')).toEqual([
      ['clone', 'https://relay.ngit.dev/npub1abc/demo.git'],
    ]);
  });

  it('lists the tags being added or changed before the confirm gate', async () => {
    const io = makeIo(true, true);
    const fake = makeStandalone();
    const code = await runMaintainers(
      ['add', M1, ...ADDR],
      makeDeps(io, fake, [announcement(OWNER, [])])
    );
    expect(code).toBe(0);
    const printed = io.out.join('\n');
    expect(printed).toContain('Tags changed:');
    expect(printed).toContain(`+ relays ${RELAY}`);
    expect(printed).toContain('+ web ');
  });

  it('validates the pubkey and subcommand (exit 2)', async () => {
    const io = makeIo();
    const fake = makeStandalone();
    expect(
      await runMaintainers(['add', 'nothex', ...ADDR], makeDeps(io, fake, []))
    ).toBe(2);
    expect(await runMaintainers(['bogus'], makeDeps(makeIo(), fake, []))).toBe(
      2
    );
    expect(fake.published).toHaveLength(0);
  });
});
