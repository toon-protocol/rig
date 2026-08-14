/**
 * `rig payout set|clear|show` tests (rig#92): the FREE show read, the PAID
 * set/clear republish of the kind:30617 (owner-only), preservation of
 * name/description/maintainers, and the non-owner/unannounced/malformed-
 * address refusals. Mirrors maintainers.test.ts's harness: the Publisher is
 * mocked at the StandaloneContext seam and a hermetic mock relay serves the
 * current 30617.
 */

import { describe, it, expect } from 'vitest';
import type { NostrEvent } from '../remote-state.js';
import type { Publisher } from '../publisher.js';
import type { UnsignedEvent } from '../nip34-events.js';
import { parseMaintainers, parsePayout } from '../nip34-events.js';
import type { CliIo } from './output.js';
import type { EventCommandDeps } from './events.js';
import { runPayout } from './payout.js';
import type { StandaloneContext } from './standalone-context.js';
import { filterEvents, makeMockRelayFactory } from './read-testkit.js';

const OWNER = 'ab'.repeat(32);
const M1 = 'cd'.repeat(32);
const REPO = 'demo';
const RELAY = 'wss://relay.test.example';
const PUBLISHED_ID = '99'.repeat(32);
const ADDR1 = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';

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
      throw new Error('payout never uploads objects');
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
        throw new Error('payout uses fetchRemoteState, not fetchRemote');
      },
      stop: async () => undefined,
    },
  };
}

function announcement(
  owner: string,
  overrides: {
    name?: string;
    description?: string;
    maintainers?: string[];
    payout?: string;
  } = {}
): NostrEvent {
  const maintainers = overrides.maintainers ?? [];
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

describe('rig payout show (free)', () => {
  it('prints the declared payout pointer', async () => {
    const io = makeIo();
    const fake = makeStandalone();
    const code = await runPayout(
      ['show', ...ADDR, '--json'],
      makeDeps(io, fake, [announcement(OWNER, { payout: ADDR1 })])
    );
    expect(code).toBe(0);
    expect(io.json[0]).toMatchObject({
      command: 'payout show',
      announced: true,
      payout: { chain: 'evm', address: ADDR1 },
    });
    expect(fake.published).toHaveLength(0); // free — nothing published
  });

  it('reports payout: null when no pointer is declared', async () => {
    const io = makeIo();
    const fake = makeStandalone();
    const code = await runPayout(
      ['show', ...ADDR, '--json'],
      makeDeps(io, fake, [announcement(OWNER)])
    );
    expect(code).toBe(0);
    expect(io.json[0]).toMatchObject({ announced: true, payout: null });
  });

  it('reports announced: false when there is no announcement', async () => {
    const io = makeIo();
    const fake = makeStandalone();
    const code = await runPayout(
      ['show', ...ADDR, '--json'],
      makeDeps(io, fake, [])
    );
    expect(code).toBe(0);
    expect(io.json[0]).toMatchObject({ announced: false, payout: null });
  });
});

describe('rig payout set/clear (paid, owner-only)', () => {
  it('set republishes the 30617 with the payout tag, preserving metadata + maintainers', async () => {
    const io = makeIo();
    const fake = makeStandalone();
    const code = await runPayout(
      ['set', ADDR1, ...ADDR, '--yes'],
      makeDeps(io, fake, [
        announcement(OWNER, {
          name: 'Keep Me',
          description: 'Keep this',
          maintainers: [M1],
        }),
      ])
    );
    expect(code).toBe(0);
    expect(fake.published).toHaveLength(1);
    const { event, relayUrls } = fake.published[0]!;
    expect(event.kind).toBe(30617);
    expect(parsePayout(event.tags)).toEqual({ chain: 'evm', address: ADDR1 });
    expect(event.tags).toContainEqual(['name', 'Keep Me']);
    expect(event.tags).toContainEqual(['description', 'Keep this']);
    expect(parseMaintainers(event.tags)).toEqual([M1]);
    expect(relayUrls).toEqual([RELAY]);
  });

  it('set normalizes a lowercase address to its EIP-55 checksummed form', async () => {
    const io = makeIo();
    const fake = makeStandalone();
    const code = await runPayout(
      ['set', ADDR1.toLowerCase(), ...ADDR, '--yes'],
      makeDeps(io, fake, [announcement(OWNER)])
    );
    expect(code).toBe(0);
    expect(parsePayout(fake.published[0]!.event.tags)).toEqual({
      chain: 'evm',
      address: ADDR1,
    });
  });

  it('clear republishes the 30617 without the payout tag', async () => {
    const io = makeIo();
    const fake = makeStandalone();
    const code = await runPayout(
      ['clear', ...ADDR, '--yes'],
      makeDeps(io, fake, [announcement(OWNER, { payout: ADDR1 })])
    );
    expect(code).toBe(0);
    expect(fake.published).toHaveLength(1);
    expect(parsePayout(fake.published[0]!.event.tags)).toBeNull();
  });

  it('set is a no-op (nothing published) when already set to the same address', async () => {
    const io = makeIo();
    const fake = makeStandalone();
    const code = await runPayout(
      ['set', ADDR1, ...ADDR, '--yes'],
      makeDeps(io, fake, [announcement(OWNER, { payout: ADDR1 })])
    );
    expect(code).toBe(0);
    expect(fake.published).toHaveLength(0);
    expect(io.err.join('\n')).toContain('already set');
  });

  it('clear is a no-op when no payout pointer is set', async () => {
    const io = makeIo();
    const fake = makeStandalone();
    const code = await runPayout(
      ['clear', ...ADDR, '--yes'],
      makeDeps(io, fake, [announcement(OWNER)])
    );
    expect(code).toBe(0);
    expect(fake.published).toHaveLength(0);
    expect(io.err.join('\n')).toContain('no payout pointer is set');
  });

  it('REFUSES a non-owner republish', async () => {
    const io = makeIo();
    // The standalone identity is M1, but the repo owner (--owner) is OWNER.
    const fake = makeStandalone(M1);
    const code = await runPayout(
      ['set', ADDR1, ...ADDR, '--yes'],
      makeDeps(io, fake, [announcement(OWNER)])
    );
    expect(code).toBe(1);
    expect(fake.published).toHaveLength(0);
    expect(io.err.join('\n')).toContain('only the repo owner');
  });

  it('REFUSES set/clear on an unannounced repo (no phantom 30617)', async () => {
    for (const args of [['set', ADDR1], ['clear']]) {
      const io = makeIo();
      const fake = makeStandalone();
      const code = await runPayout(
        [...args, ...ADDR, '--yes'],
        makeDeps(io, fake, []) // remoteEvents: [] ⇒ announced === false
      );
      expect(code).toBe(1);
      expect(fake.published).toHaveLength(0);
      expect(io.err.join('\n')).toContain('has no announcement');
      expect(io.err.join('\n')).toContain('rig push');
    }
  });

  it('REFUSES a malformed address client-side (bad checksum) — no relay/identity work, exit 2', async () => {
    const io = makeIo();
    const fake = makeStandalone();
    const badChecksum =
      ADDR1.slice(0, -1) + (ADDR1.slice(-1) === 'a' ? 'A' : 'a');
    const code = await runPayout(
      ['set', badChecksum, ...ADDR, '--yes'],
      makeDeps(io, fake, [announcement(OWNER)])
    );
    expect(code).toBe(2);
    expect(fake.published).toHaveLength(0);
    expect(io.err.join('\n')).toContain('toon-meta#391');
  });

  it('REFUSES a malformed address shape client-side — no relay/identity work, exit 2', async () => {
    const io = makeIo();
    const fake = makeStandalone();
    const code = await runPayout(
      ['set', 'not-an-address', ...ADDR, '--yes'],
      makeDeps(io, fake, [announcement(OWNER)])
    );
    expect(code).toBe(2);
    expect(fake.published).toHaveLength(0);
  });

  it('estimate only: --json without --yes publishes nothing', async () => {
    const io = makeIo();
    const fake = makeStandalone();
    const code = await runPayout(
      ['set', ADDR1, ...ADDR, '--json'],
      makeDeps(io, fake, [announcement(OWNER)])
    );
    expect(code).toBe(0);
    expect(fake.published).toHaveLength(0);
    expect(io.json[0]).toMatchObject({
      command: 'payout set',
      executed: false,
      payout: { chain: 'evm', address: ADDR1 },
    });
  });

  it('validates the address and subcommand (exit 2)', async () => {
    const io = makeIo();
    const fake = makeStandalone();
    expect(
      await runPayout(['set', ...ADDR], makeDeps(io, fake, []))
    ).toBe(2); // missing <address>
    expect(await runPayout(['bogus'], makeDeps(makeIo(), fake, []))).toBe(2);
    expect(fake.published).toHaveLength(0);
  });
});
