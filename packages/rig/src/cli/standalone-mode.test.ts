import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NodeSelfDescription } from '@toon-protocol/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  chainFamilyOf,
  defaultStoreDestinationFor,
  readSolanaKeyFile,
  resolveConnectorSettings,
  resolveDestinations,
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

  it('nothing configured: no connector, no warning, the default watermark path', () => {
    const s = resolveConnectorSettings({ env: {}, file: {}, configDir: DIR });
    expect(s.connectorUrl).toBeUndefined();
    expect(s.connectorSource).toBeNull();
    expect(s.channelStorePath).toBe(join(DIR, 'channels.json'));
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
  settlements: [],
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
