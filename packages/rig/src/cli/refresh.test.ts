/**
 * `rig refresh` tests (#158) — the owner-only, no-field-edit republish of a
 * repo's kind:30617 that backfills its NIP-34 conformance tags.
 *
 * Same harness as maintainers.test.ts / payout.test.ts: the Publisher is
 * mocked at the StandaloneContext seam and a hermetic mock relay serves the
 * current announcement. What is asserted is wire behaviour — the unsigned
 * event handed to the Publisher, and what the command prints or emits.
 */

import { describe, it, expect } from 'vitest';
import type { NostrEvent } from '../remote-state.js';
import type { Publisher } from '../publisher.js';
import type { UnsignedEvent } from '../nip34-events.js';
import { parseMaintainers } from '../nip34-events.js';
import { repoWebUrl } from '../rig-pointer.js';
import type { CliIo } from './output.js';
import type { EventCommandDeps } from './events.js';
import { runRefresh } from './refresh.js';
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
const LOCAL_ROOT = 'a1'.repeat(20);

const ADDR = ['--repo-id', REPO, '--owner', OWNER, '--relay', RELAY];
const FOREIGN_TAGS = foreignAnnouncementTags(OWNER, M2);

/** The `web` value this repo's refresh writes. */
const WEB = repoWebUrl({
  env: {},
  relay: RELAY,
  ownerPubkey: OWNER,
  repoId: REPO,
});

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
      throw new Error('refresh never uploads objects');
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
        throw new Error('refresh uses fetchRemoteState, not fetchRemote');
      },
      stop: async () => undefined,
    },
  };
}

/** An announcement with the given extra tags after d/name/description. */
function announcement(extra: string[][] = []): NostrEvent {
  return {
    id: '30'.repeat(32),
    pubkey: OWNER,
    created_at: 1000,
    kind: 30617,
    tags: [
      ['d', REPO],
      ['name', 'Demo Repo'],
      ['description', 'A demo'],
      ...extra,
    ],
    content: '',
    sig: '0'.repeat(128),
  };
}

/** An announcement that is ALREADY fully conformant for this repo + relay. */
function conformantAnnouncement(extra: string[][] = []): NostrEvent {
  return announcement([
    ['relays', RELAY],
    ['web', WEB],
    ['r', LOCAL_ROOT, 'euc'],
    ...extra,
  ]);
}

function makeDeps(
  rec: Recorder,
  fake: Fake,
  remoteEvents: NostrEvent[],
  roots: string[] = [LOCAL_ROOT]
): EventCommandDeps {
  return {
    io: rec.io,
    env: {},
    cwd: '/nonexistent-not-a-repo',
    loadStandalone: async () => fake.context,
    rootCommits: async () => roots,
    webSocketFactory: makeMockRelayFactory(
      (filter) => filterEvents(remoteEvents, filter),
      'object'
    ),
  };
}

describe('rig refresh (paid, owner-only)', () => {
  it('backfills relays, web and the euc on an announcement that has none', async () => {
    const io = makeIo();
    const fake = makeStandalone();
    const code = await runRefresh(
      [...ADDR, '--yes'],
      makeDeps(io, fake, [announcement()])
    );
    expect(code).toBe(0);
    expect(fake.published).toHaveLength(1);
    const published = fake.published[0];
    expect(published?.event.kind).toBe(30617);
    expect(published?.relayUrls).toEqual([RELAY]);
    expect(published?.event.tags).toEqual([
      ['d', REPO],
      ['name', 'Demo Repo'],
      ['description', 'A demo'],
      ['relays', RELAY],
      ['web', WEB],
      ['r', LOCAL_ROOT, 'euc'],
    ]);
  });

  it('edits no field: name, description and maintainers are untouched', async () => {
    const io = makeIo();
    const fake = makeStandalone();
    const code = await runRefresh(
      [...ADDR, '--yes'],
      makeDeps(io, fake, [announcement([['maintainers', M1]])])
    );
    expect(code).toBe(0);
    const tags = fake.published[0]?.event.tags ?? [];
    expect(tags).toContainEqual(['name', 'Demo Repo']);
    expect(tags).toContainEqual(['description', 'A demo']);
    expect(parseMaintainers(tags)).toEqual([M1]);
  });

  it('preserves every tag rig does not model, including clone (#154)', async () => {
    const io = makeIo();
    const fake = makeStandalone();
    const base = announcement();
    const code = await runRefresh(
      [...ADDR, '--yes'],
      makeDeps(io, fake, [{ ...base, tags: [...base.tags, ...FOREIGN_TAGS] }])
    );
    expect(code).toBe(0);
    const tags = fake.published[0]?.event.tags ?? [];
    expect(survivingForeignTags(tags, FOREIGN_TAGS)).toEqual(FOREIGN_TAGS);
    expect(tags.filter((t) => t[0] === 'clone')).toEqual([
      ['clone', 'https://relay.ngit.dev/npub1abc/demo.git'],
    ]);
  });

  it('NEVER recomputes an announced euc, even when local git disagrees', async () => {
    const ANNOUNCED_EUC = 'be'.repeat(20);
    const io = makeIo();
    const fake = makeStandalone();
    const code = await runRefresh(
      [...ADDR, '--yes'],
      makeDeps(
        io,
        fake,
        [announcement([['r', ANNOUNCED_EUC, 'euc']])],
        ['ff'.repeat(20)] // a DIFFERENT local root
      )
    );
    expect(code).toBe(0);
    const tags = fake.published[0]?.event.tags ?? [];
    expect(tags.filter((t) => t[0] === 'r' && t[2] === 'euc')).toEqual([
      ['r', ANNOUNCED_EUC, 'euc'],
    ]);
  });

  it('does nothing and pays nothing when there is nothing to change', async () => {
    const io = makeIo();
    const fake = makeStandalone();
    const code = await runRefresh(
      [...ADDR, '--yes'],
      makeDeps(io, fake, [conformantAnnouncement()])
    );
    expect(code).toBe(0);
    expect(fake.published).toHaveLength(0);
    expect(io.out.join('\n')).toContain('already up to date');
  });

  it('--json reports the no-op with no fee estimate and publishes nothing', async () => {
    const io = makeIo();
    const fake = makeStandalone();
    const code = await runRefresh(
      [...ADDR, '--json', '--yes'],
      makeDeps(io, fake, [conformantAnnouncement()])
    );
    expect(code).toBe(0);
    expect(fake.published).toHaveLength(0);
    expect(io.json[0]).toMatchObject({
      command: 'refresh',
      executed: false,
      feeEstimate: null,
      changes: { added: [], removed: [] },
    });
  });

  it('lists the tags being added or changed before the confirm gate', async () => {
    const io = makeIo(true, true);
    const fake = makeStandalone();
    const code = await runRefresh([...ADDR], makeDeps(io, fake, [announcement()]));
    expect(code).toBe(0);
    const printed = io.out.join('\n');
    expect(printed).toContain('Tags changed:');
    expect(printed).toContain(`+ relays ${RELAY}`);
    expect(printed).toContain(`+ web ${WEB}`);
    expect(printed).toContain(`+ r ${LOCAL_ROOT} euc`);
    expect(fake.published).toHaveLength(1);
  });

  it('aborts without publishing when the confirmation is declined', async () => {
    const io = makeIo(true, false);
    const fake = makeStandalone();
    const code = await runRefresh([...ADDR], makeDeps(io, fake, [announcement()]));
    expect(code).toBe(1);
    expect(fake.published).toHaveLength(0);
    expect(io.err.join('\n')).toContain('aborted');
  });

  it('estimate only: --json without --yes publishes nothing', async () => {
    const io = makeIo();
    const fake = makeStandalone();
    const code = await runRefresh(
      [...ADDR, '--json'],
      makeDeps(io, fake, [announcement()])
    );
    expect(code).toBe(0);
    expect(fake.published).toHaveLength(0);
    expect(io.json[0]).toMatchObject({
      command: 'refresh',
      executed: false,
      feeEstimate: '5',
      changes: {
        added: [
          ['relays', RELAY],
          ['web', WEB],
          ['r', LOCAL_ROOT, 'euc'],
        ],
        removed: [],
      },
    });
  });

  it('--json --yes emits the receipt of the published event', async () => {
    const io = makeIo();
    const fake = makeStandalone();
    const code = await runRefresh(
      [...ADDR, '--json', '--yes'],
      makeDeps(io, fake, [announcement()])
    );
    expect(code).toBe(0);
    expect(fake.published).toHaveLength(1);
    expect(io.json[0]).toMatchObject({
      command: 'refresh',
      executed: true,
      feeEstimate: '5',
      result: { eventId: PUBLISHED_ID },
    });
  });

  it('refuses a non-TTY confirm without --yes, publishing nothing', async () => {
    const io = makeIo(false, false);
    const fake = makeStandalone();
    const code = await runRefresh([...ADDR], makeDeps(io, fake, [announcement()]));
    expect(code).toBe(1);
    expect(fake.published).toHaveLength(0);
    expect(io.err.join('\n')).toContain('--yes');
  });

  it('REFUSES a non-owner republish (only the owner is authoritative)', async () => {
    const io = makeIo();
    const fake = makeStandalone(M1); // active identity is not the owner
    const code = await runRefresh(
      [...ADDR, '--yes'],
      makeDeps(io, fake, [announcement()])
    );
    expect(code).toBe(1);
    expect(fake.published).toHaveLength(0);
    expect(io.err.join('\n')).toContain('only the repo owner');
  });

  it('REFUSES an unannounced repo (no phantom 30617)', async () => {
    const io = makeIo();
    const fake = makeStandalone();
    const code = await runRefresh([...ADDR, '--yes'], makeDeps(io, fake, []));
    expect(code).toBe(1);
    expect(fake.published).toHaveLength(0);
    expect(io.err.join('\n')).toContain('has no announcement');
    expect(io.err.join('\n')).toContain('rig push');
  });

  it('takes no positional arguments (exit 2)', async () => {
    const io = makeIo();
    const fake = makeStandalone();
    expect(
      await runRefresh(['nonsense', ...ADDR], makeDeps(io, fake, []))
    ).toBe(2);
    expect(fake.published).toHaveLength(0);
  });

  it('prints its usage for --help without touching the relay', async () => {
    const io = makeIo();
    const fake = makeStandalone();
    expect(await runRefresh(['--help'], makeDeps(io, fake, []))).toBe(0);
    expect(io.out.join('\n')).toContain('Usage: rig refresh');
    expect(fake.published).toHaveLength(0);
  });
});
