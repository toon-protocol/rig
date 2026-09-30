import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  BatchChannelSummary,
  BatchExitResult,
  NodeSelfDescription,
} from '@toon-protocol/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChannelMapStore } from '../standalone/channel-map.js';
import {
  buildMoneyOps,
  chainFamilyOf,
  createStandaloneContext,
  defaultStoreDestinationFor,
  readSolanaKeyFile,
  resolveConnectorSettings,
  resolveDestinations,
  type MoneyClientLike,
} from './standalone-mode.js';

const DIR = '/home/u/.toon-client';

describe('resolveConnectorSettings', () => {
  it('reads the connector from TOON_CONNECTOR before the config file', () => {
    const s = resolveConnectorSettings({
      env: { TOON_CONNECTOR: 'https://a.example' },
      file: { connectorUrl: 'https://b.example' },
      configDir: DIR,
    });
    expect(s.connectorUrl).toBe('https://a.example');
    expect(s.connectorSource).toBe('env');
    expect(s.warnings).toEqual([]);
  });

  it('still reads the pre-4.0 proxy spellings, and says so', () => {
    const fromEnv = resolveConnectorSettings({
      env: { TOON_CLIENT_PROXY_URL: 'https://a.example/ilp' },
      file: {},
      configDir: DIR,
    });
    expect(fromEnv.connectorUrl).toBe('https://a.example/ilp');
    expect(fromEnv.connectorSource).toBe('legacy-env');
    expect(fromEnv.warnings.join('\n')).toMatch(/TOON_CONNECTOR/);
    const fromFile = resolveConnectorSettings({
      env: {},
      file: {
        proxyUrl: 'https://b.example/ilp',
        btpUrl: 'wss://b.example/ilp/btp',
      },
      configDir: DIR,
    });
    expect(fromFile.connectorSource).toBe('legacy-config');
    expect(fromFile.warnings.join('\n')).toMatch(/btpUrl is ignored/);
  });

  it('nothing configured: no connector, no warning, the x402 channel store', () => {
    const s = resolveConnectorSettings({ env: {}, file: {}, configDir: DIR });
    expect(s.connectorUrl).toBeUndefined();
    expect(s.connectorSource).toBeNull();
    // A new name for client 4.x: a 3.x `channels.json` beside it is never read.
    expect(s.channelStorePath).toBe(join(DIR, 'channels-x402.json'));
    expect(s.facilitatorUrl).toBeUndefined();
    expect(s.keyDerivation).toBe('legacy');
    expect(s.transport).toBe('auto');
    expect(s.eventFee).toBe(0n);
  });

  it('reads the chain by family and the RPC by the full chain key', () => {
    const s = resolveConnectorSettings({
      env: {},
      file: {
        chain: 'evm:8453',
        chainRpcUrls: { 'evm:8453': 'https://mainnet.base.org' },
      },
      configDir: DIR,
    });
    expect(s.chain).toBe('evm');
    expect(s.chainKey).toBe('evm:8453');
    expect(s.rpcUrl).toBe('https://mainnet.base.org');
  });

  it('an unsupported chain family is dropped with a warning', () => {
    const s = resolveConnectorSettings({
      env: { TOON_CLIENT_CHAIN: 'mina:devnet' },
      file: { supportedChains: ['solana'] },
      configDir: DIR,
    });
    expect(s.chain).toBeUndefined();
    expect(s.warnings.join('\n')).toMatch(/mina:devnet/);
  });

  it('a per-invocation store override outranks env and config', () => {
    const s = resolveConnectorSettings({
      env: { TOON_CLIENT_STORE_DESTINATION: 'g.a.store' },
      file: { storeDestination: 'g.b.store', publishDestination: 'g.b.relay' },
      configDir: DIR,
      storeDestinationOverride: 'g.via.ario',
    });
    expect(s.storeDestination).toBe('g.via.ario');
    expect(s.publishDestination).toBe('g.b.relay');
  });

  it('reads payer key overrides and the key derivation scheme', () => {
    const s = resolveConnectorSettings({
      env: {
        RIG_SOLANA_KEY_FILE: '/k/id.json',
        TOON_CLIENT_KEY_DERIVATION: 'standard',
      },
      file: { evmPrivateKey: '0xab', deposit: '5000000', feePerEvent: '7' },
      configDir: DIR,
    });
    expect(s.solanaKeyFile).toBe('/k/id.json');
    expect(s.evmPrivateKey).toBe('0xab');
    expect(s.keyDerivation).toBe('standard');
    expect(s.deposit).toBe(5_000_000n);
    expect(s.eventFee).toBe(7n);
  });

  it('reads the channel store and the x402 facilitator, env before file', () => {
    const s = resolveConnectorSettings({
      env: {
        TOON_CLIENT_CHANNEL_STORE: '/s/env.json',
        TOON_CLIENT_FACILITATOR_URL: 'https://f.env',
      },
      file: {
        channelStorePath: '/s/file.json',
        facilitatorUrl: 'https://f.file',
      },
      configDir: DIR,
    });
    expect(s.channelStorePath).toBe('/s/env.json');
    expect(s.facilitatorUrl).toBe('https://f.env');
    const fromFile = resolveConnectorSettings({
      env: {},
      file: { channelStorePath: '/s/file.json', facilitatorUrl: '' },
      configDir: DIR,
    });
    expect(fromFile.channelStorePath).toBe('/s/file.json');
    expect(fromFile.facilitatorUrl).toBe('');
  });
});

describe('chainFamilyOf', () => {
  it('maps ids to families and rejects the rest', () => {
    expect(chainFamilyOf('evm')).toBe('evm');
    expect(chainFamilyOf('evm:84532')).toBe('evm');
    expect(chainFamilyOf('solana')).toBe('solana');
    expect(chainFamilyOf('solana:mainnet')).toBe('solana');
    expect(chainFamilyOf('mina:devnet')).toBeUndefined();
    expect(chainFamilyOf(undefined)).toBeUndefined();
  });
});

const desc = (routes: string[], addresses = routes): NodeSelfDescription => ({
  ilpAddresses: addresses,
  peerCarriages: ['http'],
  batchSettlements: [],
  voucherSigners: [],
  routes: routes.map((prefix) => ({ prefix, price: 1000n })),
  supportedVersions: [1],
  defaultVersion: 1,
  raw: {} as NodeSelfDescription['raw'],
});

describe('resolveDestinations', () => {
  it("defaults publish to the node's first priced address and store to its *.ario route", () => {
    const d = resolveDestinations(
      desc(['g.drew.relay', 'g.drew.ario', 'g.drew.gas']),
      {},
      'https://node.example'
    );
    expect(d).toEqual({ publish: 'g.drew.relay', store: 'g.drew.ario' });
  });

  it('prefers a *.store route over *.ario, and a forwarded store the node prices', () => {
    expect(
      defaultStoreDestinationFor(
        desc(['g.toon.relay', 'g.toon.relay.store', 'g.toon.ario'])
      )
    ).toBe('g.toon.relay.store');
    expect(defaultStoreDestinationFor(desc(['g.x.relay']))).toBeUndefined();
  });

  it('explicit settings win, and a missing store route names the knob', () => {
    expect(
      resolveDestinations(
        desc(['g.a', 'g.b']),
        { publishDestination: 'g.b', storeDestination: 'g.a' },
        'u'
      )
    ).toEqual({ publish: 'g.b', store: 'g.a' });
    expect(() =>
      resolveDestinations(desc(['g.a.relay']), {}, 'https://node.example')
    ).toThrow(/prices no store route.*TOON_CLIENT_STORE_DESTINATION/);
  });

  it('a node with no priced address of its own needs an explicit publish destination', () => {
    expect(() =>
      resolveDestinations(desc(['g.fwd.store'], []), {}, 'https://node.example')
    ).toThrow(/no priced address of its own/);
  });
});

describe('readSolanaKeyFile', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rig-solkey-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads the 64-byte array solana-keygen writes', () => {
    const path = join(dir, 'id.json');
    writeFileSync(
      path,
      JSON.stringify(Array.from({ length: 64 }, (_, i) => i))
    );
    const key = readSolanaKeyFile(path);
    expect(key).toHaveLength(64);
    expect(key[63]).toBe(63);
  });

  it('rejects anything that is not a keypair array', () => {
    const path = join(dir, 'bad.json');
    writeFileSync(path, JSON.stringify({ secret: 'nope' }));
    expect(() => readSolanaKeyFile(path)).toThrow(/not a Solana keypair file/);
    writeFileSync(path, JSON.stringify([1, 2, 3]));
    expect(() => readSolanaKeyFile(path)).toThrow(/not a Solana keypair file/);
    expect(() => readSolanaKeyFile(join(dir, 'missing.json'))).toThrow(
      /failed to read/
    );
  });
});

// ---------------------------------------------------------------------------
// Money ops on the x402 channel facade (client 4.x)
// ---------------------------------------------------------------------------

const SOLANA_NETWORK = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const RECEIVER = '4s2JSwCFJZ7iTmPoLXLhFnfrEvybMTxuWCA2LfMRhyv1';

function solanaChannel(
  channelId: string,
  over: Partial<BatchChannelSummary> = {}
): BatchChannelSummary {
  return {
    channel: {
      chain: 'solana',
      channelId,
      network: SOLANA_NETWORK,
      sponsor: RECEIVER,
      config: {
        payer: 'payer1111111111111111111111111111111111111',
        payerAuthorizer: 'payer1111111111111111111111111111111111111',
        receiver: RECEIVER,
        token: USDC_MINT,
        withdrawDelay: 86_400,
        salt: 1n,
        openSlot: 2n,
      },
    },
    depositTotal: 2_000_000n,
    signed: 0n,
    ...over,
  };
}

/**
 * A stand-in for `client.channel`: an x402 channel set the test drives by
 * hand. The facade has no nonce; `signed` is the running total.
 */
function fakeClient(
  chain: 'evm' | 'solana',
  held: BatchChannelSummary[]
): MoneyClientLike & { calls: string[]; held: BatchChannelSummary[] } {
  const calls: string[] = [];
  const state = { calls, held };
  const live = () =>
    state.held.find(
      (c) => c.closedAt === undefined && c.settledAt === undefined
    );
  return {
    ...state,
    chain,
    wallet: { balances: () => Promise.resolve([]) },
    channel: {
      channels: () => state.held,
      current: () => Promise.resolve(live()),
      open: () => {
        calls.push('open');
        const opened = solanaChannel(`ch${String(state.held.length + 1)}`);
        state.held.push(opened);
        return Promise.resolve(opened);
      },
      deposit: (amount: bigint) => {
        calls.push(`deposit ${String(amount)}`);
        const c = live();
        if (!c) return Promise.reject(new Error('no channel'));
        c.depositTotal += amount;
        return Promise.resolve(c);
      },
      close: () => {
        calls.push('close');
        const results: BatchExitResult[] = [];
        for (const c of state.held) {
          if (c.closedAt !== undefined) continue;
          c.closedAt = 1_000n;
          c.settleableAt = 1_000n + 86_400n;
          results.push({
            channelId: c.channel.channelId,
            transaction: `tx-close-${c.channel.channelId}`,
            settleableAt: c.settleableAt,
          });
        }
        return Promise.resolve(results);
      },
      settle: () => {
        calls.push('settle');
        return Promise.resolve([]);
      },
    },
  };
}

function only<T>(items: T[]): T {
  const [item] = items;
  if (items.length !== 1 || item === undefined) {
    throw new Error(`expected exactly one, got ${String(items.length)}`);
  }
  return item;
}

describe('buildMoneyOps (x402 channels)', () => {
  let dir: string;
  let channelMap: ChannelMapStore;
  const anchor = {
    identity: 'a'.repeat(64),
    destination: 'g.drew.relay',
    peerId: 'connector-signer',
  };
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rig-money-'));
    channelMap = new ChannelMapStore({
      mapPath: join(dir, 'rig-channels-x402.json'),
      watermarkPath: join(dir, 'channels-x402.json'),
    });
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('opens a channel when none is held and records it by network and program', async () => {
    const client = fakeClient('solana', []);
    const money = buildMoneyOps({ client, channelMap, ...anchor });
    const outcome = await money.openChannel();
    expect(client.calls).toEqual(['open']);
    expect(outcome).toMatchObject({
      channelId: 'ch1',
      resumed: false,
      chain: SOLANA_NETWORK,
      depositTotal: '2000000',
    });
    const record = only(channelMap.list());
    expect(record).toMatchObject({
      channelId: 'ch1',
      chain: SOLANA_NETWORK,
      context: {
        chainType: 'solana',
        tokenAddress: USDC_MINT,
        recipient: RECEIVER,
      },
    });
    // Re-running resumes the channel the client already holds: no second open.
    const again = await money.openChannel();
    expect(again).toMatchObject({ channelId: 'ch1', resumed: true });
    expect(client.calls).toEqual(['open']);
  });

  it('refuses a Solana top-up before anything is opened', async () => {
    const client = fakeClient('solana', []);
    const money = buildMoneyOps({ client, channelMap, ...anchor });
    await expect(money.openChannel({ deposit: 500_000n })).rejects.toThrow(
      /cannot be topped up.*TOON_CLIENT_DEPOSIT/
    );
    expect(client.calls).toEqual([]);
    expect(channelMap.list()).toEqual([]);
  });

  it('tops up a Base channel on --deposit', async () => {
    const client = fakeClient('evm', [solanaChannel('ch1')]);
    const money = buildMoneyOps({ client, channelMap, ...anchor });
    const outcome = await money.openChannel({ deposit: 500_000n });
    expect(client.calls).toEqual(['deposit 500000']);
    expect(outcome).toMatchObject({
      depositTotal: '2500000',
      depositAdded: '500000',
    });
  });

  it('a replaced channel is superseded, not overwritten, so its deposit stays listed', async () => {
    const old = solanaChannel('ch1', { signed: 1_999_000n });
    const client = fakeClient('solana', [old]);
    const money = buildMoneyOps({ client, channelMap, ...anchor });
    await money.openChannel();
    // The client ran ch1 out and opened ch2 by itself on the next send.
    old.closedAt = 5n;
    client.held.push(solanaChannel('ch2'));
    await money.openChannel();
    const byId = Object.fromEntries(
      channelMap.list().map((r) => [r.channelId, r])
    );
    expect(Object.keys(byId).sort()).toEqual(['ch1', 'ch2']);
    expect(byId['ch1']?.supersededAt).toBeDefined();
    expect(byId['ch2']?.supersededAt).toBeUndefined();
  });

  it("close reads this channel's step out of the client's walk over all of them", async () => {
    const client = fakeClient('solana', [solanaChannel('ch1')]);
    const money = buildMoneyOps({ client, channelMap, ...anchor });
    await money.openChannel();
    const record = only(channelMap.list());
    const closed = await money.closeChannel(record);
    expect(closed).toEqual({
      channelId: 'ch1',
      txHash: 'tx-close-ch1',
      closedAt: '1000',
      settleableAt: String(1_000 + 86_400),
    });
  });

  it("close surfaces the client's per-channel error, and refuses a channel it does not hold", async () => {
    const client = fakeClient('solana', [solanaChannel('ch1')]);
    client.channel.close = () =>
      Promise.resolve([
        { channelId: 'ch1', error: 'leaving a channel needs SOL' },
      ]);
    const money = buildMoneyOps({ client, channelMap, ...anchor });
    await money.openChannel();
    const record = only(channelMap.list());
    await expect(money.closeChannel(record)).rejects.toThrow(/needs SOL/);
    await expect(
      money.closeChannel({ ...record, channelId: 'elsewhere' })
    ).rejects.toThrow(/not in this client's x402 channel store/);
  });

  it('settle before the exit window says so; after it, the record is retired', async () => {
    const client = fakeClient('solana', [solanaChannel('ch1')]);
    const money = buildMoneyOps({ client, channelMap, ...anchor });
    await money.openChannel();
    const record = only(channelMap.list());
    await money.closeChannel(record);
    await expect(money.settleChannel(record)).rejects.toThrow(
      /not settleable yet/
    );
    client.channel.settle = () => {
      only(client.held).settledAt = 90_000n;
      return Promise.resolve([
        { channelId: 'ch1', transaction: 'tx-withdraw' },
      ]);
    };
    expect(await money.settleChannel(record)).toEqual({
      channelId: 'ch1',
      txHash: 'tx-withdraw',
    });
    expect(channelMap.list()[0]?.supersededAt).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// The context against a stand-in edge: fresh x402 store, 3.x store untouched
// ---------------------------------------------------------------------------

const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

describe('createStandaloneContext on client 4.x', () => {
  let home: string;
  let server: Server;
  let edge: string;
  let lockHome: string | undefined;
  // What a 3.x rig left under TOON_CLIENT_HOME: a toon-channel watermark with
  // a nonce, its binding, and rig's own map.
  const legacy = JSON.stringify({
    ['0x' + 'ab'.repeat(32)]: { nonce: 73, cumulativeAmount: '1234567' },
  });
  const legacyPeers = JSON.stringify({
    'g.drew|solana': {
      channelId: '0x' + 'ab'.repeat(32),
      context: { chainType: 'solana', chainId: 0, tokenNetworkAddress: 'x' },
      depositTotal: '2000000',
    },
  });
  const legacyMap = JSON.stringify({ version: 1, channels: {} });

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'rig-client4-'));
    writeFileSync(join(home, 'channels.json'), legacy);
    writeFileSync(join(home, 'channels.peers.json'), legacyPeers);
    writeFileSync(join(home, 'rig-channels.json'), legacyMap);
    // A stand-in edge that answers GET /ilp with a mainnet Solana
    // batch-settlement offer, two priced routes, and nothing else.
    server = createServer((req, res) => {
      if (req.method === 'GET' && req.url === '/ilp') {
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({
            ilpAddresses: ['g.drew.relay', 'g.drew.ario'],
            peerCarriages: ['http'],
            batchSettlements: [
              {
                network: SOLANA_NETWORK,
                asset: USDC_MINT,
                payTo: RECEIVER,
                feePayer: RECEIVER,
                withdrawDelay: 86_400,
                tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
                minDeposit: '1000000',
                sponsorEndpoint: '/ilp/batch-settlement/solana/open',
              },
            ],
            routes: [
              { prefix: 'g.drew.relay', price: '1000' },
              { prefix: 'g.drew.ario', price: '1000', pricePerKib: '30' },
            ],
          })
        );
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    edge = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
    // The advisory lock lives under the process's TOON_CLIENT_HOME.
    lockHome = process.env['TOON_CLIENT_HOME'];
    process.env['TOON_CLIENT_HOME'] = home;
  });
  afterEach(async () => {
    if (lockHome === undefined) delete process.env['TOON_CLIENT_HOME'];
    else process.env['TOON_CLIENT_HOME'] = lockHome;
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(home, { recursive: true, force: true });
  });

  const env = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
    TOON_CLIENT_HOME: home,
    RIG_MNEMONIC: MNEMONIC,
    RIG_STANDALONE: '1',
    TOON_CONNECTOR: edge,
    TOON_CLIENT_CHAIN: 'solana',
    TOON_CLIENT_RPC_URL: 'http://127.0.0.1:9',
    ...extra,
  });

  it('starts on a fresh x402 store and leaves the 3.x files alone', async () => {
    const warnings: string[] = [];
    const ctx = await createStandaloneContext({
      env: env(),
      cwd: home,
      warn: (line) => warnings.push(line),
    });
    try {
      expect(
        (ctx.publisher as { destinations?: unknown }).destinations
      ).toEqual({ publish: 'g.drew.relay', store: 'g.drew.ario' });
      expect(
        warnings.some((w) => w.includes('channels.json') && w.includes('3.x'))
      ).toBe(true);
      expect(
        warnings.some(
          (w) => w.includes('rig-channels.json') && w.includes('3.x')
        )
      ).toBe(true);
    } finally {
      await ctx.stop();
    }
    expect(readFileSync(join(home, 'channels.json'), 'utf8')).toBe(legacy);
    expect(readFileSync(join(home, 'channels.peers.json'), 'utf8')).toBe(
      legacyPeers
    );
    expect(readFileSync(join(home, 'rig-channels.json'), 'utf8')).toBe(
      legacyMap
    );
    // Nothing was paid, so nothing was opened or recorded.
    expect(existsSync(join(home, 'rig-channels-x402.json'))).toBe(false);
  });

  it('refuses a configured channel store that is a 3.x toon-channel store', async () => {
    await expect(
      createStandaloneContext({
        env: env({ TOON_CLIENT_CHANNEL_STORE: join(home, 'channels.json') }),
        cwd: home,
        warn: () => undefined,
      })
    ).rejects.toThrow(/client 3\.x toon-channel store/);
    expect(readFileSync(join(home, 'channels.json'), 'utf8')).toBe(legacy);
  });
});
