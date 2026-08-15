/**
 * Tests for the #264 topology resolution in standalone mode:
 * `explicit config > live announce > genesis seed`, per field, plus the
 * tokenNetwork derivation and settlement-chain wiring.
 *
 * `resolveNetworkTopology` is pure (announce/genesis/records injected), so
 * the full matrix runs without any network or client start.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { deriveFullIdentity } from '@toon-protocol/client';

import {
  solanaPresetForChain,
  type AnnouncedPeer,
} from '../standalone/network-bootstrap.js';
import { MinaZkAppStore } from '../standalone/mina-zkapp-store.js';
import {
  OFFICIAL_BTP_URL,
  OFFICIAL_PROXY_URL,
  OFFICIAL_PUBLISH_DESTINATION,
  bootstrapRecoveries,
  buildMinaAutoDeploy,
  isBtpTransportError,
  resolveNetworkTopology,
  resolveUplinkConfig,
  type ClientConfigFile,
  type GenesisSeedLike,
  type NetworkTopology,
  type NetworkTopologyInputs,
} from './standalone-mode.js';
import type { StandalonePublisher } from '../standalone/standalone-publisher.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Standard BIP-39 test vector phrase (never holds real funds). */
const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

const APEX_PUBKEY = 'a1'.repeat(32);
const RELAY = 'wss://relay-ws.devnet.toonprotocol.dev';

/**
 * Live-devnet-shaped apex announce. Its endpoints deliberately sit on a
 * DIFFERENT host from the `OFFICIAL_*` constants so precedence is provable
 * either way — that the announce does not place the HTTP uplink, and that it
 * DOES place the BTP one. Trusting a live announce over the baked constant is
 * intentional: the announce is current where a constant is baked, and an
 * unreachable announced endpoint is caught by the degrade recovery.
 */
function apexAnnounce(
  overrides: Partial<Record<string, unknown>> = {}
): AnnouncedPeer {
  const content: Record<string, unknown> = {
    ilpAddress: 'g.proxy.relay',
    btpEndpoint: 'wss://proxy.devnet.toonprotocol.dev:443',
    assetCode: 'USDC',
    assetScale: 6,
    httpEndpoint: 'https://proxy.devnet.toonprotocol.dev/ilp',
    relayUrl: RELAY,
    supportedChains: ['evm:31337', 'solana:devnet', 'mina:devnet'],
    settlementAddresses: {
      'evm:31337': '0xF29fD62C4848B9573C9b90adbF61b664F386d9CF',
      'solana:devnet': 'A3FG5y6rfBNJQrsGYTNNR7UHAXCREPJgV362LdTQGNwK',
      'mina:devnet': 'B62qkEx3MsKtaEJqJMg8ZC2eXtz8FNpZy4huVpBnnUHVRUEf5f1vqdq',
    },
    ...overrides,
  };
  return {
    pubkey: APEX_PUBKEY,
    info: content as unknown as AnnouncedPeer['info'],
    routes: { publish: 'g.proxy.relay', store: 'g.proxy.store' },
    ...(content['minaTokenIds']
      ? { minaTokenIds: content['minaTokenIds'] as Record<string, string> }
      : {}),
    ...(content['chainRpcUrls']
      ? { chainRpcUrls: content['chainRpcUrls'] as Record<string, string> }
      : {}),
    createdAt: 1000,
  };
}

const GENESIS: GenesisSeedLike = {
  pubkey: 'c3'.repeat(32),
  relayUrl: RELAY,
  ilpAddress: 'g.proxy',
  btpEndpoint: 'wss://proxy.devnet.toonprotocol.dev:443',
};

function inputs(
  overrides: Partial<NetworkTopologyInputs> & {
    file?: ClientConfigFile;
  } = {}
): NetworkTopologyInputs {
  return {
    env: {},
    file: {},
    configPath: '/tmp/test/config.json',
    relayUrl: RELAY,
    announce: apexAnnounce(),
    genesisSeed: GENESIS,
    identity: { mnemonic: MNEMONIC, accountIndex: 0, pubkey: 'd4'.repeat(32) },
    channelRecords: () => [],
    probeBalance: () => Promise.resolve(0n),
    probeSolanaBalance: () => Promise.resolve(0n),
    warn: () => {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Official defaults
//
// The two baked-in endpoints rig falls back to. They are the ONLY network
// addresses a default install dials, so they get pinned here: the two-box
// cutover retired the apex, and a default still pointing at it fails a fresh
// channel open (the x402 greeting) even when paid writes ride BTP.
// ---------------------------------------------------------------------------

describe('official default endpoints', () => {
  /** The apex destroyed in the two-box cutover — resolves, refuses connections. */
  const RETIRED_APEX_HOST = 'proxy.devnet.toonprotocol.dev';

  it('no default references the retired apex', () => {
    for (const url of [OFFICIAL_PROXY_URL, OFFICIAL_BTP_URL]) {
      expect(new URL(url).hostname).not.toBe(RETIRED_APEX_HOST);
    }
  });

  it('both defaults live on the relay box that serves the publish route', () => {
    // OFFICIAL_PUBLISH_DESTINATION is `g.toon.relay`, so the uplink that
    // terminates it must be the relay box — not the ario/store box.
    expect(OFFICIAL_PUBLISH_DESTINATION).toBe('g.toon.relay');
    for (const url of [OFFICIAL_PROXY_URL, OFFICIAL_BTP_URL]) {
      expect(new URL(url).hostname).toBe('proxy.relay.devnet.toonprotocol.dev');
    }
  });

  it('uses the live ingress paths, not the legacy apex ones', () => {
    // The edge serves ILP-over-HTTP at plain `/ilp` (a GET answers `405
    // allow: POST`) and answers `410 Gone` on the old `/rust/ilp`.
    const proxy = new URL(OFFICIAL_PROXY_URL);
    expect(proxy.protocol).toBe('https:');
    expect(proxy.pathname).toBe('/ilp');
    expect(OFFICIAL_PROXY_URL).not.toContain('/rust/');

    const btp = new URL(OFFICIAL_BTP_URL);
    expect(btp.protocol).toBe('wss:');
    expect(btp.pathname).toBe('/ilp/btp');
  });
});

// ---------------------------------------------------------------------------
// Uplink resolution order
// ---------------------------------------------------------------------------

describe('resolveNetworkTopology — uplink', () => {
  // The cutover (connector #616): the Rust connector is the official TOON
  // relay implementation, so with no EXPLICIT entry the uplink is the
  // official edge — even when a live announce names another fleet's
  // endpoints. The announce keeps informing the destination anchor, routes,
  // prices and bootstrap peers; it just no longer places the uplink.
  it('defaults the uplink to the official edge, announce or not', async () => {
    const topology = await resolveNetworkTopology(inputs());
    expect(topology.proxyUrl).toBe(OFFICIAL_PROXY_URL);
  });

  it('explicit env proxy beats the official default', async () => {
    const topology = await resolveNetworkTopology(
      inputs({ env: { TOON_CLIENT_PROXY_URL: 'https://my-proxy.example' } })
    );
    expect(topology.proxyUrl).toBe('https://my-proxy.example');
  });

  it('explicit config-file btpUrl beats the official default', async () => {
    const topology = await resolveNetworkTopology(
      inputs({ file: { btpUrl: 'wss://my-btp.example:443' } })
    );
    expect(topology.btpUrl).toBe('wss://my-btp.example:443');
    expect(topology.proxyUrl).toBeUndefined();
  });

  it('an announce without an httpEndpoint still does not place the uplink', async () => {
    const topology = await resolveNetworkTopology(
      inputs({ announce: apexAnnounce({ httpEndpoint: undefined }) })
    );
    expect(topology.proxyUrl).toBe(OFFICIAL_PROXY_URL);
  });

  it('needs neither an announce nor a genesis seed for an uplink', async () => {
    const topology = await resolveNetworkTopology(
      inputs({ announce: undefined, genesisSeed: undefined })
    );
    expect(topology.proxyUrl).toBe(OFFICIAL_PROXY_URL);
    // Both legs are official constants — discovery only ever refines them.
    expect(topology.btpUrl).toBe(OFFICIAL_BTP_URL);
  });
});

// ---------------------------------------------------------------------------
// Paid-write BTP companion
//
// The proxy default alone leaves the embedded client with no BTP session, so
// every paid write goes out as an unauthenticated `POST /ilp` — which the
// live edge answers `401 Unauthorized: identity 'g.toon.client' failed to
// authenticate`. NOTE the announces on the live fleet carry NO
// `requiredTransport` field, so the client's own #558 guard never fires:
// placing the endpoint (and preferring it, in createStandaloneContext) is
// what actually gets a claim onto BTP.
// ---------------------------------------------------------------------------

describe('resolveNetworkTopology — paid-write BTP companion', () => {
  it("adopts the announce's btpEndpoint alongside the official proxy", async () => {
    const topology = await resolveNetworkTopology(inputs());
    expect(topology.proxyUrl).toBe(OFFICIAL_PROXY_URL);
    expect(topology.btpUrl).toBe('wss://proxy.devnet.toonprotocol.dev:443');
  });

  it('does so even though the announce declares no requiredTransport', async () => {
    // The live corpus: not one kind:10032 announce carries the field. The BTP
    // endpoint must be adopted on its presence alone.
    const announce = apexAnnounce();
    expect(
      (announce.info as unknown as Record<string, unknown>)['requiredTransport']
    ).toBeUndefined();
    const topology = await resolveNetworkTopology(inputs({ announce }));
    expect(topology.btpUrl).toBe('wss://proxy.devnet.toonprotocol.dev:443');
  });

  it('falls back to the official relay BTP ingress, NOT the genesis seed', async () => {
    // The committed seed in @toon-protocol/core still names the RETIRED apex
    // (`proxy.devnet.toonprotocol.dev`), a host that resolves but refuses
    // connections since the two-box cutover. Because the embedded client
    // dials BTP during start(), adopting it would turn a late 401 into rig
    // refusing to run at all.
    const topology = await resolveNetworkTopology(
      inputs({ announce: undefined })
    );
    expect(topology.btpUrl).toBe(OFFICIAL_BTP_URL);
    expect(topology.btpUrl).not.toBe(GENESIS.btpEndpoint);
    expect(OFFICIAL_BTP_URL).not.toContain('//proxy.devnet.');
  });

  it('ignores an announce whose btpEndpoint is empty', async () => {
    const topology = await resolveNetworkTopology(
      inputs({ announce: apexAnnounce({ btpEndpoint: '' }) })
    );
    expect(topology.btpUrl).toBe(OFFICIAL_BTP_URL);
  });

  it('marks a discovered endpoint as derived (droppable when unreachable)', async () => {
    for (const announce of [apexAnnounce(), undefined]) {
      const topology = await resolveNetworkTopology(inputs({ announce }));
      expect(topology.btpUrlDerived).toBe(true);
    }
  });

  // An operator who pinned an uplink pinned the transport with it — silently
  // adding an announced BTP endpoint would route their paid writes off it.
  it('never overrides an explicitly pinned proxy uplink', async () => {
    const topology = await resolveNetworkTopology(
      inputs({ env: { TOON_CLIENT_PROXY_URL: 'https://my-proxy.example' } })
    );
    expect(topology.proxyUrl).toBe('https://my-proxy.example');
    expect(topology.btpUrl).toBeUndefined();
  });

  it('never overrides an explicitly pinned BTP uplink, and never marks it derived', async () => {
    const topology = await resolveNetworkTopology(
      inputs({ file: { btpUrl: 'wss://my-btp.example:443' } })
    );
    expect(topology.btpUrl).toBe('wss://my-btp.example:443');
    expect(topology.proxyUrl).toBeUndefined();
    expect(topology.btpUrlDerived).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Unreachable-BTP classification
//
// The gate on dropping a derived BTP leg. Narrow on purpose: it decides
// whether rig may abandon a configured transport, so anything broader would
// paper over unrelated bootstrap failures.
// ---------------------------------------------------------------------------

describe('isBtpTransportError', () => {
  const named = (name: string, message = 'boom'): Error => {
    const err = new Error(message);
    err.name = name;
    return err;
  };

  it('matches the client BTP socket/auth failures', () => {
    // @toon-protocol/client throws these (unexported) for a websocket that
    // would not open or would not authenticate.
    expect(
      isBtpTransportError(
        named('BtpConnectionError', 'WebSocket connection error: ECONNREFUSED')
      )
    ).toBe(true);
    expect(isBtpTransportError(named('BtpAuthError'))).toBe(true);
  });

  it('does NOT match unrelated bootstrap failures', () => {
    expect(isBtpTransportError(named('Error', 'connect ECONNREFUSED'))).toBe(
      false
    );
    expect(isBtpTransportError(named('ToonClientError'))).toBe(false);
    expect(isBtpTransportError(named('ChannelMapCorruptError'))).toBe(false);
    expect(isBtpTransportError(named('MinaFeePayerUnfundedError'))).toBe(false);
    expect(isBtpTransportError('BtpConnectionError')).toBe(false);
    expect(isBtpTransportError(undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Bootstrap recoveries
//
// The safety net behind the BTP companion: the embedded client dials BTP
// during start(), so an unreachable DERIVED endpoint must degrade to HTTP
// rather than stop rig from running — a strictly worse failure than the 401
// it replaces.
// ---------------------------------------------------------------------------

describe('bootstrapRecoveries', () => {
  const DERIVED: NetworkTopology = {
    proxyUrl: OFFICIAL_PROXY_URL,
    btpUrl: OFFICIAL_BTP_URL,
    btpUrlDerived: true,
    destination: 'g.toon.relay',
    knownPeers: [],
  };
  const btpDown = (): Error => {
    const err = new Error('WebSocket connection error: ECONNREFUSED');
    err.name = 'BtpConnectionError';
    return err;
  };

  /** Records every topology a rebuild built from. */
  function harness(
    topology: NetworkTopology,
    reresolve?: () => Promise<NetworkTopology>
  ) {
    const built: NetworkTopology[] = [];
    const recoveries = bootstrapRecoveries({
      topology,
      buildPublisher: (topo) => {
        built.push(topo);
        return {} as StandalonePublisher;
      },
      ...(reresolve ? { reresolve } : {}),
    });
    return { built, recoveries };
  }

  it('drops an unreachable DERIVED BTP leg, keeping the HTTP uplink', async () => {
    const { built, recoveries } = harness(DERIVED);
    const btp = recoveries.find((r) => r.applies(btpDown()));
    expect(btp).toBeDefined();
    await btp?.rebuild();
    expect(built).toHaveLength(1);
    expect(built[0]?.btpUrl).toBeUndefined();
    expect(built[0]?.btpUrlDerived).toBeUndefined();
    // Everything else survives — this degrades one transport, not the topology.
    expect(built[0]?.proxyUrl).toBe(OFFICIAL_PROXY_URL);
    expect(built[0]?.destination).toBe('g.toon.relay');
  });

  it('names the dead endpoint and the remedy in the warning', () => {
    const { recoveries } = harness(DERIVED);
    const line = recoveries[recoveries.length - 1]?.describe(btpDown()) ?? '';
    expect(line).toContain(OFFICIAL_BTP_URL);
    expect(line).toContain('ECONNREFUSED');
    expect(line).toContain('rig entry');
  });

  it('never drops an EXPLICITLY pinned BTP uplink', () => {
    const { recoveries } = harness({
      ...DERIVED,
      btpUrl: 'wss://pinned.example:443',
      btpUrlDerived: undefined,
    });
    expect(recoveries.some((r) => r.applies(btpDown()))).toBe(false);
  });

  it('does not fire for a non-BTP bootstrap failure', () => {
    const { recoveries } = harness(DERIVED);
    expect(
      recoveries.some((r) => r.applies(new Error('chain misconfig')))
    ).toBe(false);
  });

  it('registers no cache recovery for a live-resolved topology', () => {
    const { recoveries } = harness(DERIVED);
    expect(recoveries).toHaveLength(1);
  });

  // The two recoveries COMPOSE: the degrade must drop the BTP leg of whatever
  // the cache recovery re-resolved, not of the topology it started from.
  it('degrades the RE-RESOLVED topology after a cache recovery', async () => {
    const fresh: NetworkTopology = {
      ...DERIVED,
      btpUrl: 'wss://rotated.example/ilp/btp',
      destination: 'g.toon.relay',
    };
    const { built, recoveries } = harness(DERIVED, async () => fresh);
    expect(recoveries).toHaveLength(2);

    await recoveries[0]?.rebuild(); // cache miss → live re-resolve
    expect(built[0]?.btpUrl).toBe('wss://rotated.example/ilp/btp');

    expect(recoveries[1]?.applies(btpDown())).toBe(true);
    expect(recoveries[1]?.describe(btpDown())).toContain(
      'wss://rotated.example/ilp/btp'
    );
    await recoveries[1]?.rebuild();
    expect(built[1]?.btpUrl).toBeUndefined();
    expect(built[1]?.proxyUrl).toBe(OFFICIAL_PROXY_URL);
  });

  it('the cache recovery applies to ANY failure (staleness is untypeable)', () => {
    const { recoveries } = harness(DERIVED, async () => DERIVED);
    expect(recoveries[0]?.applies(new Error('anything at all'))).toBe(true);
  });
});

describe('resolveUplinkConfig', () => {
  it('prefers BTP for paid writes whenever a BTP uplink is available', () => {
    expect(
      resolveUplinkConfig({
        proxyUrl: OFFICIAL_PROXY_URL,
        btpUrl: 'wss://proxy.devnet.toonprotocol.dev/ilp/btp',
      })
    ).toEqual({
      proxyUrl: OFFICIAL_PROXY_URL,
      btpUrl: 'wss://proxy.devnet.toonprotocol.dev/ilp/btp',
      btpAuthToken: '',
      preferBtpForPaidWrites: true,
    });
  });

  it('keeps the proxy as the HTTP leg the x402 greeting bootstrap needs', () => {
    const config = resolveUplinkConfig({
      proxyUrl: OFFICIAL_PROXY_URL,
      btpUrl: 'wss://btp.example:443',
    });
    expect(config.proxyUrl).toBe(OFFICIAL_PROXY_URL);
    expect(config.connectorUrl).toBeUndefined();
  });

  it('sets the flag on a BTP-only topology too (ordered claim dispatch)', () => {
    const config = resolveUplinkConfig({ btpUrl: 'wss://btp.example:443' });
    expect(config.preferBtpForPaidWrites).toBe(true);
    // validateConfig demands one of connectorUrl/proxyUrl; the dummy is
    // never dialled (the BTP session is the runtime transport).
    expect(config.connectorUrl).toBe('http://127.0.0.1:1');
    expect(config.proxyUrl).toBeUndefined();
  });

  it('leaves a proxy-only topology on its historical HTTP-first path', () => {
    expect(
      resolveUplinkConfig({ proxyUrl: 'https://my-proxy.example' })
    ).toEqual({ proxyUrl: 'https://my-proxy.example' });
  });
});

// ---------------------------------------------------------------------------
// Destination anchor + routes
// ---------------------------------------------------------------------------

describe('resolveNetworkTopology — destination and routes', () => {
  it('anchors at the announce ilpAddress with announce routes', async () => {
    const topology = await resolveNetworkTopology(inputs());
    expect(topology.destination).toBe('g.proxy.relay');
    expect(topology.publishDestination).toBe('g.proxy.relay');
    expect(topology.storeDestination).toBe('g.proxy.store');
  });

  it('explicit destination + routes beat the announce', async () => {
    const topology = await resolveNetworkTopology(
      inputs({
        env: {
          TOON_CLIENT_DESTINATION: 'g.proxy.relay.store',
          TOON_CLIENT_PUBLISH_DESTINATION: 'g.mine.relay',
          TOON_CLIENT_STORE_DESTINATION: 'g.mine.store',
        },
      })
    );
    expect(topology.destination).toBe('g.proxy.relay.store');
    expect(topology.publishDestination).toBe('g.mine.relay');
    expect(topology.storeDestination).toBe('g.mine.store');
  });

  it('explicit destination keeps announce routes for unset route fields', async () => {
    const topology = await resolveNetworkTopology(
      inputs({ env: { TOON_CLIENT_DESTINATION: 'g.proxy.relay.store' } })
    );
    expect(topology.destination).toBe('g.proxy.relay.store');
    expect(topology.publishDestination).toBe('g.proxy.relay');
    expect(topology.storeDestination).toBe('g.proxy.store');
  });

  it('falls back to the genesis ilpAddress without an announce (no routes)', async () => {
    const topology = await resolveNetworkTopology(
      inputs({ announce: undefined })
    );
    expect(topology.destination).toBe('g.proxy');
    // The uplink defaulted to the official edge, so the publish route is
    // that edge's own (connector #616); store has no official default yet.
    expect(topology.publishDestination).toBe(OFFICIAL_PUBLISH_DESTINATION);
    expect(topology.storeDestination).toBeUndefined();
  });

  it('bootstraps the client against the announced peer, else the seed', async () => {
    const withAnnounce = await resolveNetworkTopology(inputs());
    expect(withAnnounce.knownPeers).toEqual([
      {
        pubkey: APEX_PUBKEY,
        relayUrl: RELAY,
        btpEndpoint: 'wss://proxy.devnet.toonprotocol.dev:443',
      },
    ]);
    const seedOnly = await resolveNetworkTopology(
      inputs({ announce: undefined })
    );
    expect(seedOnly.knownPeers).toEqual([
      {
        pubkey: GENESIS.pubkey,
        relayUrl: GENESIS.relayUrl,
        btpEndpoint: GENESIS.btpEndpoint,
      },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Settlement chain + tokenNetwork derivation
// ---------------------------------------------------------------------------

describe('resolveNetworkTopology — settlement', () => {
  it('selects the first announced EVM chain and derives its full settlement', async () => {
    const warnings: string[] = [];
    const topology = await resolveNetworkTopology(
      inputs({ warn: (line) => warnings.push(line) })
    );
    expect(topology.selection).toMatchObject({
      chain: 'evm:31337',
      reason: 'default',
    });
    expect(topology.supportedChains).toEqual(['evm:31337']);
    // Deterministic anvil contracts + RPC (core preset, matched by chain id).
    expect(topology.tokenNetworks?.['evm:31337']).toMatch(/^0x/);
    expect(topology.preferredTokens?.['evm:31337']).toMatch(/^0x/);
    expect(topology.chainRpcUrls?.['evm:31337']).toBe('http://localhost:8545');
    expect(warnings.some((w) => w.includes('settlement chain evm:31337'))).toBe(
      true
    );
  });

  it('prefers the funded chain (balance probe)', async () => {
    const topology = await resolveNetworkTopology(
      inputs({ probeBalance: () => Promise.resolve(12345n) })
    );
    expect(topology.selection).toMatchObject({
      chain: 'evm:31337',
      reason: 'funded',
    });
  });

  it('zero-config devnet: a qualified EVM chain key still probes and wins (#384)', async () => {
    // rig 2.7.1 regression: bare mnemonic + relay URL against the devnet,
    // Solana announced FIRST, and the EVM chain spelled with the qualified
    // `evm:{network}:{chainId}` key. An exact-key preset miss skipped the
    // EVM probe and negotiation fell through to `solana:devnet` — which
    // then died at push time. The chain must resolve its preset RPC by
    // chain id and win the funded probe.
    const probed: string[] = [];
    const topology = await resolveNetworkTopology(
      inputs({
        announce: apexAnnounce({
          supportedChains: ['solana:devnet', 'evm:anvil:31337'],
          settlementAddresses: {
            'evm:anvil:31337': '0xF29fD62C4848B9573C9b90adbF61b664F386d9CF',
            'solana:devnet': 'A3FG5y6rfBNJQrsGYTNNR7UHAXCREPJgV362LdTQGNwK',
          },
        }),
        probeBalance: (args) => {
          probed.push(args.rpcUrl);
          return Promise.resolve(12345n);
        },
      })
    );
    expect(topology.selection).toMatchObject({
      chain: 'evm:anvil:31337',
      reason: 'funded',
    });
    expect(probed).toEqual(['http://localhost:8545']);
    expect(topology.supportedChains).toEqual(['evm:anvil:31337']);
    expect(topology.chainRpcUrls).toEqual({
      'evm:anvil:31337': 'http://localhost:8545',
    });
    // Deterministic anvil contracts still derive from the chain-id preset.
    expect(topology.tokenNetworks?.['evm:anvil:31337']).toMatch(/^0x/);
    expect(topology.preferredTokens?.['evm:anvil:31337']).toMatch(/^0x/);
    expect(topology.solanaChannel).toBeUndefined();
  });

  it('prefers a Solana chain funded for the identity-derived address', async () => {
    // A wallet funded ONLY on Solana settles there automatically: the EVM
    // probe finds nothing, the SPL probe (against the mnemonic's own derived
    // base58 address) does. Announce-provided program id/mint take
    // precedence over the public-cluster preset; the RPC (which the
    // announce does not carry) comes from the preset.
    const probedOwners: string[] = [];
    const topology = await resolveNetworkTopology(
      inputs({
        announce: apexAnnounce({
          tokenNetworks: { 'solana:devnet': 'ProgramAnnounced11111' },
          preferredTokens: { 'solana:devnet': 'MintAnnounced1111111' },
        }),
        probeBalance: () => Promise.resolve(0n),
        probeSolanaBalance: (args) => {
          probedOwners.push(args.owner);
          expect(args.rpcUrl).toBe('https://api.devnet.solana.com');
          expect(args.tokenAddress).toBe('MintAnnounced1111111');
          return Promise.resolve(5000n);
        },
      })
    );
    expect(topology.selection).toMatchObject({
      chain: 'solana:devnet',
      reason: 'funded',
    });
    // The probed owner is the identity's own Solana address (the client's
    // SLIP-0010 m/44'/501'/{account}'/0' derivation from the mnemonic).
    const identity = await deriveFullIdentity(MNEMONIC, 0);
    expect(probedOwners).toEqual([identity.solana.publicKey]);
    expect(identity.solana.publicKey).not.toBe('');
    // The funded Solana pick is settlement-complete for the embedded client.
    expect(topology.supportedChains).toEqual(['solana:devnet']);
    expect(topology.solanaChannel).toEqual({
      rpcUrl: 'https://api.devnet.solana.com',
      programId: 'ProgramAnnounced11111',
      tokenMint: 'MintAnnounced1111111',
    });
  });

  it('falls back to the default EVM chain when the Solana probe errors', async () => {
    const topology = await resolveNetworkTopology(
      inputs({
        announce: apexAnnounce({
          tokenNetworks: { 'solana:devnet': 'ProgramAnnounced11111' },
          preferredTokens: { 'solana:devnet': 'MintAnnounced1111111' },
        }),
        probeBalance: () => Promise.resolve(0n),
        probeSolanaBalance: () => Promise.reject(new Error('rpc down')),
      })
    );
    expect(topology.selection).toMatchObject({
      chain: 'evm:31337',
      reason: 'default',
    });
  });

  it('prefers a live persisted channel chain (#262 map)', async () => {
    const topology = await resolveNetworkTopology(
      inputs({
        channelRecords: () => [
          {
            chain: 'solana:devnet',
            lastUsedAt: '2026-07-01T00:00:00Z',
            closed: false,
          },
        ],
      })
    );
    expect(topology.selection).toMatchObject({
      chain: 'solana:devnet',
      reason: 'persisted-channel',
    });
    expect(topology.supportedChains).toEqual(['solana:devnet']);
    // The selected Solana chain is settlement-complete straight from the
    // public-cluster core preset — even though the announcing peer lives
    // under the devnet zone and carries no program id/mint itself (the
    // zone's self-hosted validator is retired; no zone special-casing).
    const preset = solanaPresetForChain('solana:devnet');
    expect(topology.solanaChannel).toEqual({
      rpcUrl: 'https://api.devnet.solana.com',
      programId: preset?.programId,
      tokenMint: preset?.tokenMint,
    });
  });

  it('honors TOON_CLIENT_CHAIN as an explicit family pick', async () => {
    const topology = await resolveNetworkTopology(
      inputs({ env: { TOON_CLIENT_CHAIN: 'evm' } })
    );
    expect(topology.selection).toMatchObject({
      chain: 'evm:31337',
      reason: 'explicit',
    });
  });

  it('passes an explicit supportedChains list through unchanged, filling gaps', async () => {
    const topology = await resolveNetworkTopology(
      inputs({
        file: {
          supportedChains: ['solana:devnet', 'evm:31337'],
          tokenNetworks: { 'evm:31337': '0xEXPLICIT' },
          // A listed Solana chain must be settlement-complete; the explicit
          // channel object covers it.
          solanaChannel: {
            rpcUrl: 'http://explicit:8899',
            programId: 'ProgramExplicit111111',
          },
        },
      })
    );
    expect(topology.supportedChains).toEqual(['solana:devnet', 'evm:31337']);
    expect(topology.selection).toMatchObject({ reason: 'explicit' });
    // Explicit tokenNetwork kept; token/RPC gaps filled by derivation.
    expect(topology.tokenNetworks?.['evm:31337']).toBe('0xEXPLICIT');
    expect(topology.preferredTokens?.['evm:31337']).toMatch(/^0x/);
    expect(topology.chainRpcUrls?.['evm:31337']).toBe('http://localhost:8545');
    // The explicit solanaChannel rides through buildPublisher verbatim — the
    // topology does not re-derive one.
    expect(topology.solanaChannel).toBeUndefined();
  });

  it('fails fast on an underivable EVM chain in an explicit supportedChains list', async () => {
    // Explicit config naming a custom EVM chain that no source (config map,
    // announce, core preset) can derive a TokenNetwork for must throw the
    // same actionable error as the announce-driven path — not sail through
    // and die later inside the embedded client.
    await expect(
      resolveNetworkTopology(
        inputs({
          file: { supportedChains: ['evm:999999'] },
        })
      )
    ).rejects.toThrow(/TokenNetwork.*evm:999999/s);
  });

  it('fails fast on a missing RPC URL for an explicit EVM chain', async () => {
    await expect(
      resolveNetworkTopology(
        inputs({
          file: {
            supportedChains: ['evm:999999'],
            tokenNetworks: { 'evm:999999': '0xEXPLICIT' },
          },
        })
      )
    ).rejects.toThrow(/RPC URL.*evm:999999/s);
  });

  it('throws the clear tokenNetwork error for an underivable EVM chain', async () => {
    await expect(
      resolveNetworkTopology(
        inputs({
          announce: apexAnnounce({
            supportedChains: ['evm:999999'],
            settlementAddresses: { 'evm:999999': '0xPEER' },
          }),
        })
      )
    ).rejects.toThrow(/TokenNetwork.*evm:999999/s);
  });

  it('warns instead of selecting when nothing is announced or configured', async () => {
    const warnings: string[] = [];
    const topology = await resolveNetworkTopology(
      inputs({
        announce: undefined,
        warn: (line) => warnings.push(line),
      })
    );
    expect(topology.selection).toBeUndefined();
    expect(topology.supportedChains).toBeUndefined();
    expect(warnings.some((w) => w.includes('no settlement chains'))).toBe(true);
  });

  it('drops a listed Solana chain with no derivable channel params (warned)', async () => {
    // A listed Solana cluster no source can derive channel params for (no
    // preset, no announce params, no solanaChannel config) cannot be
    // settled on, so it must not be advertised to negotiation — negotiation
    // landing there is guaranteed to die later as the embedded client's
    // "Solana channel config not provided". The remaining chains keep
    // working.
    const warnings: string[] = [];
    const topology = await resolveNetworkTopology(
      inputs({
        file: { supportedChains: ['evm:31337', 'solana:localnet'] },
        warn: (line) => warnings.push(line),
      })
    );
    expect(topology.supportedChains).toEqual(['evm:31337']);
    expect(topology.solanaChannel).toBeUndefined();
    const dropWarning = warnings.find((w) => w.includes('dropping'));
    expect(dropWarning).toContain('solana:localnet');
    expect(dropWarning).toContain('solanaChannel');
  });

  it('aligns a configured EVM spelling to the announced chain id (devnet config shape)', async () => {
    // The live-devnet failure shape: the shared daemon config lists
    // `evm:base:31337` while the apex announces `evm:31337` — negotiation
    // matches identifiers exactly, so the EVM chain was silently stranded
    // and negotiation fell through to solana:devnet (which standalone could
    // not open). The listed chain must be advertised under the ANNOUNCED
    // spelling, its explicit parameters carried over, and the chain-keyed
    // maps pruned to the advertised list (the client validates
    // chainRpcUrls keys ⊆ supportedChains).
    const warnings: string[] = [];
    const topology = await resolveNetworkTopology(
      inputs({
        file: {
          supportedChains: ['evm:base:31337', 'solana:devnet', 'mina:devnet'],
          tokenNetworks: {
            'evm:base:31337': '0xCafac3dD18aC6c6e92c921884f9E4176737C052c',
          },
          preferredTokens: {
            'evm:base:31337': '0x5FbDB2315678afecb367f032d93F642f64180aa3',
          },
          chainRpcUrls: {
            'evm:base:31337': 'http://localhost:8545',
            'mina:devnet': 'https://api.minascan.io/node/devnet/v1/graphql',
          },
        },
        warn: (line) => warnings.push(line),
      })
    );
    // evm aligned to the announced spelling; solana settlement-complete via
    // the public-cluster preset; mina passed through.
    expect(topology.supportedChains).toEqual([
      'evm:31337',
      'solana:devnet',
      'mina:devnet',
    ]);
    expect(topology.selection?.chain).toBe('evm:31337');
    // Explicit parameters carried over under the announced spelling.
    expect(topology.tokenNetworks).toEqual({
      'evm:31337': '0xCafac3dD18aC6c6e92c921884f9E4176737C052c',
    });
    const solPreset = solanaPresetForChain('solana:devnet');
    expect(topology.preferredTokens).toEqual({
      'evm:31337': '0x5FbDB2315678afecb367f032d93F642f64180aa3',
      'solana:devnet': solPreset?.tokenMint,
    });
    expect(topology.chainRpcUrls).toEqual({
      'evm:31337': 'http://localhost:8545',
      'solana:devnet': 'https://api.devnet.solana.com',
      'mina:devnet': 'https://api.minascan.io/node/devnet/v1/graphql',
    });
    expect(topology.solanaChannel).toEqual({
      rpcUrl: 'https://api.devnet.solana.com',
      programId: solPreset?.programId,
      tokenMint: solPreset?.tokenMint,
    });
    expect(warnings.some((w) => w.includes('aligning'))).toBe(true);
  });

  it('fails fast when EVERY listed chain is an underivable Solana chain', async () => {
    await expect(
      resolveNetworkTopology(
        inputs({
          file: { supportedChains: ['solana:localnet'] },
        })
      )
    ).rejects.toThrow(/Solana channel parameters.*solana:localnet/s);
  });

  it('fails fast when the SELECTED chain is Solana with no derivable params', async () => {
    await expect(
      resolveNetworkTopology(
        inputs({
          announce: apexAnnounce({
            supportedChains: ['evm:31337', 'solana:localnet'],
            settlementAddresses: {
              'evm:31337': '0xF29fD62C4848B9573C9b90adbF61b664F386d9CF',
              'solana:localnet': 'A3FG5y6rfBNJQrsGYTNNR7UHAXCREPJgV362LdTQGNwK',
            },
          }),
          channelRecords: () => [
            {
              chain: 'solana:localnet',
              lastUsedAt: '2026-07-01T00:00:00Z',
              closed: false,
            },
          ],
        })
      )
    ).rejects.toThrow(/Solana channel parameters.*solana:localnet/s);
  });

  it('derives solanaChannel for a listed Solana chain from the announce', async () => {
    const topology = await resolveNetworkTopology(
      inputs({
        announce: apexAnnounce({
          tokenNetworks: { 'solana:devnet': 'ProgramAnnounced11111' },
          preferredTokens: { 'solana:devnet': 'MintAnnounced1111111' },
        }),
        file: { supportedChains: ['solana:devnet'] },
      })
    );
    // Announce-provided program id/mint beat the public-cluster preset; the
    // RPC (not announced) comes from the preset.
    expect(topology.solanaChannel).toEqual({
      rpcUrl: 'https://api.devnet.solana.com',
      programId: 'ProgramAnnounced11111',
      tokenMint: 'MintAnnounced1111111',
    });
    // The mint also fills the chain-keyed token map (negotiation fallback).
    expect(topology.preferredTokens?.['solana:devnet']).toBe(
      'MintAnnounced1111111'
    );
  });

  it('supports Solana mainnet-beta once the program id is known', async () => {
    // A non-devnet-zone peer announcing mainnet-beta with its program id:
    // RPC + Circle USDC mint come from the core preset, the program from the
    // announce — settlement-complete without any local config.
    const mainnetAnnounce = apexAnnounce({
      httpEndpoint: 'https://proxy.example.com/ilp',
      btpEndpoint: 'wss://proxy.example.com:443',
      relayUrl: 'wss://relay.example.com',
      supportedChains: ['solana:mainnet-beta'],
      settlementAddresses: {
        'solana:mainnet-beta': 'A3FG5y6rfBNJQrsGYTNNR7UHAXCREPJgV362LdTQGNwK',
      },
      tokenNetworks: { 'solana:mainnet-beta': 'ProgramMainnet111111' },
    });
    const topology = await resolveNetworkTopology(
      inputs({ announce: mainnetAnnounce })
    );
    expect(topology.selection?.chain).toBe('solana:mainnet-beta');
    expect(topology.solanaChannel).toEqual({
      rpcUrl: 'https://api.mainnet-beta.solana.com',
      programId: 'ProgramMainnet111111',
      tokenMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    });
  });

  it('fails fast on Solana mainnet-beta without a program id, naming it', async () => {
    const mainnetAnnounce = apexAnnounce({
      httpEndpoint: 'https://proxy.example.com/ilp',
      btpEndpoint: 'wss://proxy.example.com:443',
      relayUrl: 'wss://relay.example.com',
      supportedChains: ['solana:mainnet-beta'],
      settlementAddresses: {
        'solana:mainnet-beta': 'A3FG5y6rfBNJQrsGYTNNR7UHAXCREPJgV362LdTQGNwK',
      },
    });
    await expect(
      resolveNetworkTopology(inputs({ announce: mainnetAnnounce }))
    ).rejects.toThrow(/solana:mainnet-beta.*missing: programId/s);
  });

  it('supports EVM mainnet (Base 8453) when the announce carries its TokenNetwork', async () => {
    const mainnetAnnounce = apexAnnounce({
      httpEndpoint: 'https://proxy.example.com/ilp',
      btpEndpoint: 'wss://proxy.example.com:443',
      relayUrl: 'wss://relay.example.com',
      supportedChains: ['evm:base:8453'],
      settlementAddresses: {
        'evm:base:8453': '0xF29fD62C4848B9573C9b90adbF61b664F386d9CF',
      },
      tokenNetworks: { 'evm:base:8453': '0xMAINNETTN' },
    });
    const topology = await resolveNetworkTopology(
      inputs({ announce: mainnetAnnounce })
    );
    expect(topology.selection?.chain).toBe('evm:base:8453');
    expect(topology.tokenNetworks?.['evm:base:8453']).toBe('0xMAINNETTN');
    // RPC + Circle USDC from the core base-mainnet preset (chain-id match).
    expect(topology.chainRpcUrls?.['evm:base:8453']).toBe(
      'https://mainnet.base.org'
    );
    expect(topology.preferredTokens?.['evm:base:8453']).toBe(
      '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
    );
    expect(topology.solanaChannel).toBeUndefined();
  });

  it('fails fast on EVM mainnet without an announced TokenNetwork', async () => {
    // TOON's TokenNetwork is not deployed on Base mainnet, so the preset
    // cannot fill it — only the announce or explicit config can.
    const mainnetAnnounce = apexAnnounce({
      httpEndpoint: 'https://proxy.example.com/ilp',
      btpEndpoint: 'wss://proxy.example.com:443',
      relayUrl: 'wss://relay.example.com',
      supportedChains: ['evm:base:8453'],
      settlementAddresses: {
        'evm:base:8453': '0xF29fD62C4848B9573C9b90adbF61b664F386d9CF',
      },
    });
    await expect(
      resolveNetworkTopology(inputs({ announce: mainnetAnnounce }))
    ).rejects.toThrow(/TokenNetwork.*evm:base:8453/s);
  });

  it('ignores the network preset for settlement (#260) with a warning', async () => {
    const warnings: string[] = [];
    const topology = await resolveNetworkTopology(
      inputs({
        file: { network: 'devnet' },
        warn: (line) => warnings.push(line),
      })
    );
    // The announce's chain wins — never the preset's Solana-first ordering.
    expect(topology.selection?.chain).toBe('evm:31337');
    expect(
      warnings.some((w) => w.includes('ignoring the "devnet" network preset'))
    ).toBe(true);
    // #280: user-facing warnings explain themselves in plain language — no
    // internal tracker numbers.
    expect(warnings.join('\n')).not.toMatch(/#\d+/);
  });

  it('aligns an explicit TOON_CLIENT_CHAIN spelling to the announced chain id (warned)', async () => {
    // `TOON_CLIENT_CHAIN=evm:base:31337` pins the SAME chain the apex
    // announces as `evm:31337` — the pin must survive the embedded client's
    // exact-string chain negotiation.
    const warnings: string[] = [];
    const topology = await resolveNetworkTopology(
      inputs({
        env: { TOON_CLIENT_CHAIN: 'evm:base:31337' },
        warn: (line) => warnings.push(line),
      })
    );
    expect(topology.selection).toMatchObject({
      chain: 'evm:31337',
      reason: 'explicit',
    });
    expect(topology.supportedChains).toEqual(['evm:31337']);
    const alignWarning = warnings.find((w) => w.includes('aligning'));
    expect(alignWarning).toContain('evm:base:31337');
    expect(alignWarning).toContain('evm:31337');
  });
});

// ---------------------------------------------------------------------------
// Route-price floors (announce `capabilities` → topology.routePrices)
// ---------------------------------------------------------------------------

describe('resolveNetworkTopology — route prices', () => {
  const CAPABILITIES = [
    { capability: 'os.publish', address: 'g.proxy.relay', price: '1000' },
    { capability: 'os.store', address: 'g.proxy.store', price: '1500' },
  ];

  it('matches announced capability prices to the resolved routes', async () => {
    const announce = { ...apexAnnounce(), capabilities: CAPABILITIES };
    const topology = await resolveNetworkTopology(inputs({ announce }));
    expect(topology.routePrices).toEqual({ publish: '1000', store: '1500' });
  });

  it('absent capabilities leave routePrices unset (behavior unchanged)', async () => {
    const topology = await resolveNetworkTopology(inputs());
    expect(topology.routePrices).toBeUndefined();
  });

  it('an explicitly overridden destination without an announced price gets no floor', async () => {
    const announce = { ...apexAnnounce(), capabilities: CAPABILITIES };
    const topology = await resolveNetworkTopology(
      inputs({
        announce,
        env: { TOON_CLIENT_STORE_DESTINATION: 'g.mine.store' },
      })
    );
    // The publish route still matches; the custom store route has no price.
    expect(topology.routePrices).toEqual({ publish: '1000' });
  });

  it('prices match the anchor-derived routes when the announce carries no routes map', async () => {
    const announce: AnnouncedPeer = {
      ...apexAnnounce(),
      capabilities: CAPABILITIES,
    };
    delete (announce as { routes?: unknown }).routes;
    const topology = await resolveNetworkTopology(
      inputs({
        announce,
        env: { TOON_CLIENT_DESTINATION: 'g.proxy.relay.store' },
      })
    );
    // The uplink defaulted to the official edge, so the effective publish
    // destination is g.toon.relay — which this announce's capabilities do
    // NOT price. A floor from one fleet's announce must not bind a write
    // that targets another fleet's edge; only the still-derived store
    // route keeps its announced floor.
    expect(topology.publishDestination).toBe(OFFICIAL_PUBLISH_DESTINATION);
    expect(topology.storeDestination).toBeUndefined();
    expect(topology.routePrices).toEqual({ store: '1500' });
  });
});

// ---------------------------------------------------------------------------
// Mina channel auto-derivation (zero-config onboarding) + announce RPC
// ---------------------------------------------------------------------------

describe('resolveNetworkTopology — mina channel auto-derivation', () => {
  /** Authoritative current devnet Mina values (docs/deployment.md). */
  const DEVNET_MINA = {
    graphqlUrl: 'https://api.minascan.io/node/devnet/v1/graphql',
    zkAppAddress: 'B62qmgPhv2Xo6QVEtwjLja8UZJUtu8yapRFAR6gaoGtbM9zE5hG7Tkf',
    tokenId:
      '9497120696276615621907376728658022802954262638363646162765282600447713419198',
    networkId: 'devnet' as const,
  };

  /** A devnet apex that advertises its OWN Mina zkApp + token id (path B). */
  function minaApex(): AnnouncedPeer {
    return apexAnnounce({
      tokenNetworks: { 'mina:devnet': DEVNET_MINA.zkAppAddress },
      minaTokenIds: { 'mina:devnet': DEVNET_MINA.tokenId },
    });
  }

  it('derives a working minaChannel with NO minaChannel in config (pins mina)', async () => {
    const topology = await resolveNetworkTopology(
      inputs({
        file: { chain: 'mina' }, // pin the Mina family; no minaChannel block
        announce: minaApex(),
      })
    );
    expect(topology.selection).toMatchObject({
      chain: 'mina:devnet',
      reason: 'explicit',
    });
    // The derived channel matches the CURRENT devnet values: zkApp + token id
    // from the announce, graphqlUrl + networkId from the core preset.
    expect(topology.minaChannel).toEqual({
      graphqlUrl: DEVNET_MINA.graphqlUrl,
      zkAppAddress: DEVNET_MINA.zkAppAddress,
      tokenId: DEVNET_MINA.tokenId,
      networkId: DEVNET_MINA.networkId,
    });
  });

  it('derives minaChannel for a listed mina:* chain without a minaChannel block', async () => {
    const topology = await resolveNetworkTopology(
      inputs({
        file: { supportedChains: ['mina:devnet'] },
        announce: minaApex(),
      })
    );
    expect(topology.supportedChains).toEqual(['mina:devnet']);
    expect(topology.minaChannel).toEqual({
      graphqlUrl: DEVNET_MINA.graphqlUrl,
      zkAppAddress: DEVNET_MINA.zkAppAddress,
      tokenId: DEVNET_MINA.tokenId,
      networkId: DEVNET_MINA.networkId,
    });
  });

  it('an explicit minaChannel config wins — the topology does not re-derive one', async () => {
    const explicit = {
      graphqlUrl: 'https://my-own-graphql.example/graphql',
      zkAppAddress: 'B62qEXPLICITuserSuppliedZkApp',
      tokenId: '1',
      networkId: 'devnet' as const,
    };
    const topology = await resolveNetworkTopology(
      inputs({
        file: { chain: 'mina', minaChannel: explicit },
        announce: minaApex(),
      })
    );
    // buildPublisher applies `file.minaChannel` verbatim; the topology stays
    // out of the way (mirrors the explicit-solanaChannel precedence).
    expect(topology.minaChannel).toBeUndefined();
  });

  it('drops a listed mina:* chain when no source can derive its channel (warned)', async () => {
    // No announce zkApp + no core preset (mina:localnet is not a real network)
    // + no minaChannel config → the chain cannot be settled on and is dropped.
    const warnings: string[] = [];
    const topology = await resolveNetworkTopology(
      inputs({
        file: { supportedChains: ['evm:31337', 'mina:localnet'] },
        warn: (line) => warnings.push(line),
      })
    );
    expect(topology.supportedChains).toEqual(['evm:31337']);
    expect(topology.minaChannel).toBeUndefined();
    const dropWarning = warnings.find(
      (w) => w.includes('dropping') && w.includes('mina:localnet')
    );
    expect(dropWarning).toContain('minaChannel');
  });

  it('EVM RPC comes from the announce over the (broken) baked preset', async () => {
    const WORKING = 'https://base-sepolia-rpc.publicnode.com';
    const topology = await resolveNetworkTopology(
      inputs({
        env: { TOON_CLIENT_CHAIN: 'evm' },
        announce: apexAnnounce({ chainRpcUrls: { 'evm:31337': WORKING } }),
      })
    );
    expect(topology.selection?.chain).toBe('evm:31337');
    expect(topology.chainRpcUrls?.['evm:31337']).toBe(WORKING);
  });
});

// ---------------------------------------------------------------------------
// buildMinaAutoDeploy — persist-before-deploy → reuse-next-run (bug #3)
// ---------------------------------------------------------------------------

describe('buildMinaAutoDeploy — zkApp key persistence', () => {
  let dir: string;
  const IDENTITY = 'ab'.repeat(32);
  const CHAIN = 'mina:devnet';

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rig-mina-autodeploy-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('onDeploying persists the key BEFORE deploy, so the NEXT run reuses it (no orphan)', () => {
    const warnings: string[] = [];
    const warn = (line: string) => warnings.push(line);

    // Run 1: no prior record → no `deployed` seed; the deploy path fires
    // onDeploying with the fresh key, which must be persisted immediately.
    const first = buildMinaAutoDeploy(dir, IDENTITY, CHAIN, warn);
    expect(first.deployed).toBeUndefined();
    first.onDeploying?.({
      zkAppAddress: 'B62qPENDINGzkApp',
      zkAppPrivateKey: 'EKpendingKey',
      feePayer: 'B62qFEEPAYER',
    });

    // The store now holds the pending record (survives a crash before confirm).
    const store = MinaZkAppStore.forHome(dir);
    const rec = store.lookup(IDENTITY, CHAIN);
    expect(rec?.zkAppAddress).toBe('B62qPENDINGzkApp');
    expect(rec?.zkAppPrivateKey).toBe('EKpendingKey');
    expect(
      warnings.some((w) => w.includes('recorded pending Mina zkApp'))
    ).toBe(true);

    // Run 2 (fresh process): the recorded key is surfaced as `deployed`, so
    // ensureOwnedMinaZkApp redeploys the SAME address instead of a new zkApp.
    const second = buildMinaAutoDeploy(dir, IDENTITY, CHAIN, warn);
    expect(second.deployed).toEqual({
      zkAppAddress: 'B62qPENDINGzkApp',
      zkAppPrivateKey: 'EKpendingKey',
    });
  });

  it('onDeployed upgrades the pending record with tx hash + vk hash', () => {
    const store = MinaZkAppStore.forHome(dir);
    const auto = buildMinaAutoDeploy(dir, IDENTITY, CHAIN, () => {});
    auto.onDeploying?.({
      zkAppAddress: 'B62qPENDINGzkApp',
      zkAppPrivateKey: 'EKpendingKey',
      feePayer: 'B62qFEEPAYER',
    });
    auto.onDeployed?.({
      zkAppAddress: 'B62qPENDINGzkApp',
      zkAppPrivateKey: 'EKpendingKey',
      feePayer: 'B62qFEEPAYER',
      deployTxHash: 'tx-abc',
      vkHash: 'vk-1',
    });
    const rec = store.lookup(IDENTITY, CHAIN);
    expect(rec).toMatchObject({
      zkAppAddress: 'B62qPENDINGzkApp',
      deployTxHash: 'tx-abc',
      vkHash: 'vk-1',
    });
  });
});

// ---------------------------------------------------------------------------
// Store leg
//
// The store route can terminate on a DIFFERENT node than publishes, and that
// node holds its own payment channel. A claim signed on the publish channel
// is refused by it outright (`F01 - claim rejected: names a channel this
// connector has no record of`), which is what made every `rig push` fail on
// the two-box fleet: rig had one uplink and paid the store from the publish
// channel. Each node also prices its OWN routes, so the store price has to be
// read from the store node's announce, not the payment peer's — reading the
// wrong one leaves the fee at 0 and the connector answers `F03 - claim
// rejected: advances value by 0, less than this route's price`.
// ---------------------------------------------------------------------------

function storeAnnounce(
  overrides: Partial<Record<string, unknown>> = {}
): AnnouncedPeer {
  const content: Record<string, unknown> = {
    ilpAddress: 'g.proxy.store',
    btpEndpoint: 'wss://store.example.test/ilp/btp',
    assetCode: 'USDC',
    assetScale: 6,
    routePrices: { 'g.proxy.store': '1000' },
    ...overrides,
  };
  return {
    pubkey: 'ab'.repeat(32),
    info: content as unknown as AnnouncedPeer['info'],
    routes: { publish: 'g.proxy.store', store: 'g.proxy.store' },
    ...(content['routePrices']
      ? { routePrices: content['routePrices'] as Record<string, string> }
      : {}),
    createdAt: 1001,
  };
}

describe('resolveNetworkTopology — store leg', () => {
  it('takes the store uplink from the STORE node announce, not the payment peer', async () => {
    const topology = await resolveNetworkTopology(
      inputs({ peers: [apexAnnounce(), storeAnnounce()] })
    );
    expect(topology.storeDestination).toBe('g.proxy.store');
    expect(topology.storeBtpUrl).toBe('wss://store.example.test/ilp/btp');
    // Never the payment peer's own endpoint — that is the publish leg's.
    expect(topology.storeBtpUrl).not.toBe(topology.btpUrl);
  });

  it('prices the store route from the store node announce', async () => {
    const topology = await resolveNetworkTopology(
      inputs({ peers: [apexAnnounce(), storeAnnounce()] })
    );
    // Without this the upload fee floors at 0 and the store answers F03.
    expect(topology.routePrices?.store).toBe('1000');
  });

  it('resolves no store uplink when the store terminates on the publish node', async () => {
    // Single-box: one node, one channel — a second uplink would open a
    // redundant on-chain channel against the same counterparty.
    const announce = apexAnnounce();
    announce.routes = { publish: 'g.proxy.relay', store: 'g.proxy.relay' };
    const topology = await resolveNetworkTopology(
      inputs({ announce, peers: [announce] })
    );
    expect(topology.storeBtpUrl).toBeUndefined();
  });

  it('never guesses a store uplink when no announce claims the route', async () => {
    // A guessed store endpoint would send real claims to a node nobody
    // advertised. Undiscovered stays undiscovered.
    const warnings: string[] = [];
    const topology = await resolveNetworkTopology(
      inputs({ peers: [apexAnnounce()], warn: (l) => warnings.push(l) })
    );
    expect(topology.storeBtpUrl).toBeUndefined();
    expect(warnings.join('\n')).toContain('g.proxy.store');
  });

  it('lets an explicit pin override the announced store uplink', async () => {
    const topology = await resolveNetworkTopology(
      inputs({
        peers: [apexAnnounce(), storeAnnounce()],
        file: { storeBtpUrl: 'wss://pinned.example.test/ilp/btp' },
      })
    );
    expect(topology.storeBtpUrl).toBe('wss://pinned.example.test/ilp/btp');
  });
});
