/**
 * The standalone (embedded-client) session behind every paid command.
 *
 * One URL is the whole configuration. A TOON connector describes itself on
 * `GET /ilp` (connector ADR 0050): its ILP addresses, the routes it prices,
 * the x402 `batch-settlement` terms it accepts per chain and the key a payload
 * is sealed to. The client (`@toon-protocol/client` 4.x) reads that once,
 * opens or resumes an x402 channel with the node, and pays each request with a
 * signed voucher naming the running total (connector ADR 0075; the
 * toon-channel claims of client 3.x are refused). There is nothing to
 * discover and nothing to negotiate: kind:10032 announces were removed by
 * ADR 0046, and a node's word about itself replaced them.
 *
 * What this module resolves, in precedence order (env > config file):
 *
 *  - `TOON_CONNECTOR` / `connectorUrl` — the node's client-edge URL. The
 *    legacy `TOON_CLIENT_PROXY_URL` / `proxyUrl` (…`/ilp`) is still read; the
 *    client normalizes a trailing `/ilp` away. `btpUrl` is ignored (the client
 *    reads the BTP endpoint from `GET /ilp`).
 *  - `TOON_CLIENT_PUBLISH_DESTINATION` / `publishDestination` — the route
 *    events go to. Default: the first address the node publishes for itself
 *    that it also prices (`defaultDestinationFor`).
 *  - `TOON_CLIENT_STORE_DESTINATION` / `storeDestination` — the route git
 *    objects go to. Default: the node's first priced route named `*.store`,
 *    else `*.ario`. A `--via` override (`rig name`) outranks both.
 *  - `TOON_CLIENT_STORE_CONNECTOR_URL` / `storeConnectorUrl` — when the store
 *    route terminates on ANOTHER node that holds its own channel: that node's
 *    URL. Uploads then ride a second client with its own watermark file.
 *    `storeSealTo` alone (same channel, different terminating identity) makes
 *    the edge's client seal to that node instead.
 *  - `TOON_CLIENT_CHAIN` / `chain` — `evm` or `solana` (a full id such as
 *    `evm:8453` is read by its family). Default: the first chain in the node's
 *    `batchSettlements[]` this identity holds a key for. A phrase holds both,
 *    so name one when the node offers several.
 *  - `TOON_CLIENT_RPC_URL` / `rpcUrl` / `chainRpcUrls[<chain>]`.
 *  - `TOON_CLIENT_CHANNEL_STORE` / `channelStorePath`: the client's x402
 *    channel store. Default `<dir>/channels-x402.json` (+ `.peers.json`). A
 *    client 3.x toon-channel store is refused here and never written.
 *  - `TOON_CLIENT_FACILITATOR_URL` / `facilitatorUrl`: the x402 facilitator
 *    that submits a Base deposit and pays its gas. Solana needs none: the
 *    connector sponsors the open.
 *  - `RIG_SOLANA_KEY_FILE` / `solanaKeyFile`, `RIG_EVM_PRIVATE_KEY` /
 *    `evmPrivateKey` — pay with THIS key instead of the phrase's derived one.
 *    The author stays the phrase's Nostr key; who pays and who signs the
 *    event are independent facts (the connector attributes payment from the
 *    voucher, never from the event).
 *
 * Key derivation: a rig phrase yields its Nostr key at `m/44'/1237'/0'/0/i`,
 * and its EVM account has always been that same secp256k1 key — which the
 * client calls `keyDerivation: 'legacy'`. That is the default here, so every
 * channel an existing identity funded is still its own. `keyDerivation:
 * 'standard'` / `TOON_CLIENT_KEY_DERIVATION=standard` opts into the
 * MetaMask-importable path for a fresh identity.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  PAYMENT_CHANNELS_PROGRAM_ID,
  ToonClient,
  X402_BATCH_SETTLEMENT_ADDRESS,
  defaultDestinationFor,
  evmChainIdOf,
  type BatchChannelSummary,
  type BatchExitResult,
  type ChannelFacade,
  type NodeSelfDescription,
  type ToonClientConfig,
} from '@toon-protocol/client';
import { shaResolverFor } from '../git-sha-resolver.js';
import { fetchRemoteState } from '../remote-state.js';
import {
  CHANNEL_STORE_FILENAME,
  ChannelMapStore,
  RIG_CHANNEL_MAP_FILENAME,
  isToonChannelStore,
  legacyChannelFiles,
  type ChannelMapRecord,
} from '../standalone/channel-map.js';
import { ConnectorPublisher } from '../standalone/connector-publisher.js';
import type {
  ChannelCloseOutcome,
  ChannelOpenOutcome,
  ChannelSettleOutcome,
  StandaloneMoneyOps,
  WalletChainBalanceInfo,
} from '../standalone/money.js';
import {
  NonceLock,
  checkDaemonIdentity,
  standaloneForced,
} from '../standalone/nonce-guard.js';
import { deriveNostrKeyFromMnemonic } from '../standalone/nostr-identity.js';
import { resolveIdentity } from './identity.js';
import type {
  StandaloneContext,
  StandaloneLoadOptions,
} from './standalone-context.js';

// ---------------------------------------------------------------------------
// Config file
// ---------------------------------------------------------------------------

/** The shared `~/.toon-client/config.json` fields rig reads. */
export interface ClientConfigFile {
  /** The connector's client-edge URL (`GET /ilp` lives here). */
  connectorUrl?: string;
  /** @deprecated the pre-2.0 spelling: the connector's `…/ilp` ingress URL. */
  proxyUrl?: string;
  /** @deprecated ignored — the client reads the BTP endpoint from `GET /ilp`. */
  btpUrl?: string;
  /** Free-read relay (WebSocket) for the identity's kind:0 and NIP-34 reads. */
  relayUrl?: string;
  /** @deprecated alias of `publishDestination`. */
  destination?: string;
  publishDestination?: string;
  storeDestination?: string;
  storeConnectorUrl?: string;
  storeSealTo?: string;
  feePerEvent?: string;
  /** The client's x402 channel store; default `<dir>/channels-x402.json`. */
  channelStorePath?: string;
  /** The x402 facilitator for a Base deposit. */
  facilitatorUrl?: string;
  /** `evm` | `solana`, or a full id (`evm:8453`) read by its family. */
  chain?: string;
  /** @deprecated pre-2.0 chain list; the first entry is read as `chain`. */
  supportedChains?: string[];
  rpcUrl?: string;
  chainRpcUrls?: Record<string, string>;
  transport?: 'auto' | 'http' | 'btp';
  keyDerivation?: 'standard' | 'legacy';
  mnemonicAccountIndex?: number;
  /** What each x402 channel is opened with, base units. */
  deposit?: string;
  /** Path to a Solana keypair JSON (64-byte array) that pays instead of the phrase's key. */
  solanaKeyFile?: string;
  /** Hex EVM private key that pays instead of the phrase's key. */
  evmPrivateKey?: string;
  /** Per-packet timeout for uploads, ms. */
  uploadTimeoutMs?: number;
  [key: string]: unknown;
}

function configDir(env: NodeJS.ProcessEnv): string {
  return env['TOON_CLIENT_HOME'] ?? join(homedir(), '.toon-client');
}

export function readClientConfig(path: string): ClientConfigFile {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as ClientConfigFile;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new Error(
      `failed to read client config at ${path}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/** An identity was resolved, but there is no connector to pay. */
export class MissingUplinkError extends Error {
  constructor(configPath: string) {
    super(
      "no connector configured: set TOON_CONNECTOR to the node's URL " +
        '(the one whose GET /ilp describes it), run `rig entry <url>`, or add ' +
        `connectorUrl to ${configPath}`
    );
    this.name = 'MissingUplinkError';
  }
}

// ---------------------------------------------------------------------------
// Settings (pure: env + file → what the client is built from)
// ---------------------------------------------------------------------------

export type ChainFamily = 'evm' | 'solana';

export interface ConnectorSettings {
  connectorUrl?: string;
  connectorSource: 'env' | 'config' | 'legacy-env' | 'legacy-config' | null;
  publishDestination?: string;
  storeDestination?: string;
  storeConnectorUrl?: string;
  storeSealTo?: string;
  relayUrl?: string;
  chain?: ChainFamily;
  /** The full chain id the user named, when they named one (`evm:8453`). */
  chainKey?: string;
  rpcUrl?: string;
  transport: 'auto' | 'http' | 'btp';
  keyDerivation: 'standard' | 'legacy';
  channelStorePath: string;
  facilitatorUrl?: string;
  deposit?: bigint;
  eventFee: bigint;
  solanaKeyFile?: string;
  evmPrivateKey?: string;
  uploadTimeoutMs?: number;
  /** Notes for the caller's stderr: deprecated spellings met on the way. */
  warnings: string[];
}

/** `evm:8453` → `evm`; `solana` → `solana`; anything else → undefined. */
export function chainFamilyOf(
  chain: string | undefined
): ChainFamily | undefined {
  if (!chain) return undefined;
  const family = chain.split(':')[0];
  return family === 'evm' || family === 'solana' ? family : undefined;
}

export function resolveConnectorSettings(args: {
  env: NodeJS.ProcessEnv;
  file: ClientConfigFile;
  configDir: string;
  storeDestinationOverride?: string;
}): ConnectorSettings {
  const { env, file } = args;
  const warnings: string[] = [];

  let connectorUrl: string | undefined;
  let connectorSource: ConnectorSettings['connectorSource'] = null;
  if (env['TOON_CONNECTOR']) {
    connectorUrl = env['TOON_CONNECTOR'];
    connectorSource = 'env';
  } else if (env['TOON_CLIENT_PROXY_URL']) {
    connectorUrl = env['TOON_CLIENT_PROXY_URL'];
    connectorSource = 'legacy-env';
    warnings.push(
      'rig: TOON_CLIENT_PROXY_URL is the pre-2.0 spelling — set TOON_CONNECTOR to the node URL instead'
    );
  } else if (file.connectorUrl) {
    connectorUrl = file.connectorUrl;
    connectorSource = 'config';
  } else if (file.proxyUrl) {
    connectorUrl = file.proxyUrl;
    connectorSource = 'legacy-config';
    warnings.push(
      'rig: config `proxyUrl` is the pre-2.0 spelling — `rig entry <url>` records `connectorUrl`'
    );
  }
  if (env['TOON_CLIENT_BTP_URL'] || file.btpUrl) {
    warnings.push(
      "rig: btpUrl is ignored since 4.0 — the client reads the BTP endpoint from the node's GET /ilp"
    );
  }

  const chainKey =
    env['TOON_CLIENT_CHAIN'] ?? file.chain ?? file.supportedChains?.[0];
  const chain = chainFamilyOf(chainKey);
  if (chainKey && !chain) {
    warnings.push(
      `rig: chain ${JSON.stringify(chainKey)} is not a settlement chain the connector supports (evm | solana) — ignoring it`
    );
  }
  const rpcUrl =
    env['TOON_CLIENT_RPC_URL'] ??
    file.rpcUrl ??
    (chainKey ? file.chainRpcUrls?.[chainKey] : undefined) ??
    (chain ? file.chainRpcUrls?.[chain] : undefined);

  const transportRaw = env['TOON_CLIENT_TRANSPORT'] ?? file.transport;
  const transport: ConnectorSettings['transport'] =
    transportRaw === 'http' || transportRaw === 'btp' ? transportRaw : 'auto';

  const derivationRaw = env['TOON_CLIENT_KEY_DERIVATION'] ?? file.keyDerivation;
  const keyDerivation: ConnectorSettings['keyDerivation'] =
    derivationRaw === 'standard' ? 'standard' : 'legacy';

  const depositRaw = env['TOON_CLIENT_DEPOSIT'] ?? file.deposit;
  const publishDestination =
    env['TOON_CLIENT_PUBLISH_DESTINATION'] ??
    env['TOON_CLIENT_DESTINATION'] ??
    file.publishDestination ??
    file.destination;
  const storeDestination =
    args.storeDestinationOverride ??
    env['TOON_CLIENT_STORE_DESTINATION'] ??
    file.storeDestination;
  const relayUrl = env['TOON_CLIENT_RELAY_URL'] ?? file.relayUrl;

  return {
    ...(connectorUrl ? { connectorUrl } : {}),
    connectorSource,
    ...(publishDestination ? { publishDestination } : {}),
    ...(storeDestination ? { storeDestination } : {}),
    ...((env['TOON_CLIENT_STORE_CONNECTOR_URL'] ?? file.storeConnectorUrl)
      ? {
          storeConnectorUrl:
            env['TOON_CLIENT_STORE_CONNECTOR_URL'] ?? file.storeConnectorUrl,
        }
      : {}),
    ...((env['TOON_CLIENT_STORE_SEAL_TO'] ?? file.storeSealTo)
      ? { storeSealTo: env['TOON_CLIENT_STORE_SEAL_TO'] ?? file.storeSealTo }
      : {}),
    ...(relayUrl ? { relayUrl } : {}),
    ...(chain ? { chain } : {}),
    ...(chainKey ? { chainKey } : {}),
    ...(rpcUrl ? { rpcUrl } : {}),
    transport,
    keyDerivation,
    channelStorePath:
      env['TOON_CLIENT_CHANNEL_STORE'] ??
      file.channelStorePath ??
      join(args.configDir, CHANNEL_STORE_FILENAME),
    ...((env['TOON_CLIENT_FACILITATOR_URL'] ?? file.facilitatorUrl) !==
    undefined
      ? {
          facilitatorUrl:
            env['TOON_CLIENT_FACILITATOR_URL'] ?? file.facilitatorUrl,
        }
      : {}),
    ...(depositRaw !== undefined ? { deposit: BigInt(depositRaw) } : {}),
    eventFee: BigInt(
      env['TOON_CLIENT_FEE_PER_EVENT'] ?? file.feePerEvent ?? '0'
    ),
    ...((env['RIG_SOLANA_KEY_FILE'] ?? file.solanaKeyFile)
      ? { solanaKeyFile: env['RIG_SOLANA_KEY_FILE'] ?? file.solanaKeyFile }
      : {}),
    ...((env['RIG_EVM_PRIVATE_KEY'] ?? file.evmPrivateKey)
      ? { evmPrivateKey: env['RIG_EVM_PRIVATE_KEY'] ?? file.evmPrivateKey }
      : {}),
    ...(file.uploadTimeoutMs !== undefined
      ? { uploadTimeoutMs: file.uploadTimeoutMs }
      : {}),
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Destinations (pure: settings + the node's self-description)
// ---------------------------------------------------------------------------

/**
 * The store route a node offers, when the caller named none: its first priced
 * route spelled `*.store`, else `*.ario` (the AR.IO-backed store this
 * repository has always uploaded to), else nothing.
 */
export function defaultStoreDestinationFor(
  desc: NodeSelfDescription
): string | undefined {
  const prefixes = desc.routes.map((r) => r.prefix);
  return (
    prefixes.find((p) => p === 'store' || p.endsWith('.store')) ??
    prefixes.find((p) => p === 'ario' || p.endsWith('.ario')) ??
    prefixes.find((p) => /store/i.test(p))
  );
}

export function resolveDestinations(
  desc: NodeSelfDescription,
  settings: Pick<ConnectorSettings, 'publishDestination' | 'storeDestination'>,
  connectorUrl: string
): { publish: string; store: string } {
  const publish = settings.publishDestination ?? defaultDestinationFor(desc);
  if (!publish) {
    throw new Error(
      `the connector at ${connectorUrl} publishes no priced address of its own — ` +
        'set publishDestination / TOON_CLIENT_PUBLISH_DESTINATION to one of its GET /ilp routes'
    );
  }
  const store = settings.storeDestination ?? defaultStoreDestinationFor(desc);
  if (!store) {
    throw new Error(
      `the connector at ${connectorUrl} prices no store route (none named *.store or *.ario) — ` +
        'set storeDestination / TOON_CLIENT_STORE_DESTINATION to the route its store answers on'
    );
  }
  return { publish, store };
}

// ---------------------------------------------------------------------------
// Key files
// ---------------------------------------------------------------------------

/** A Solana keypair file: the 64-byte JSON array `solana-keygen` writes. */
export function readSolanaKeyFile(path: string): Uint8Array {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(
      `failed to read the Solana key file ${path}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (
    !Array.isArray(parsed) ||
    (parsed.length !== 64 && parsed.length !== 32) ||
    !parsed.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)
  ) {
    throw new Error(
      `${path} is not a Solana keypair file (expected a JSON array of 64 bytes)`
    );
  }
  return Uint8Array.from(parsed as number[]);
}

// ---------------------------------------------------------------------------
// Money ops on the client's channel and wallet facades
// ---------------------------------------------------------------------------

/** One x402 channel as the peer→channel map records it. */
export function recordFor(
  summary: BatchChannelSummary,
  args: { identity: string; destination: string; peerId: string }
): Omit<ChannelMapRecord, 'openedAt' | 'lastUsedAt'> {
  const { channel } = summary;
  const tokenNetwork =
    channel.chain === 'evm'
      ? X402_BATCH_SETTLEMENT_ADDRESS
      : PAYMENT_CHANNELS_PROGRAM_ID;
  return {
    channelId: channel.channelId,
    peerId: args.peerId,
    identity: args.identity,
    destination: args.destination,
    chain: channel.network,
    tokenNetwork,
    context: {
      chainType: channel.chain,
      chainId: channel.chain === 'evm' ? evmChainIdOf(channel.network) : 0,
      tokenNetworkAddress: tokenNetwork,
      tokenAddress: channel.config.token,
      recipient: channel.config.receiver,
    },
    depositTotal: summary.depositTotal.toString(),
  };
}

/**
 * Record `summary` in the peer→channel map, or refresh its deposit when it is
 * already there. A different channel recorded under the same key (one the
 * client replaced when it ran out) is superseded, not overwritten: it still
 * holds what it has left, and `rig channel close/settle` find it by listing.
 */
export function recordChannel(
  channelMap: ChannelMapStore,
  summary: BatchChannelSummary,
  args: { identity: string; destination: string; peerId: string }
): void {
  const next = recordFor(summary, args);
  const previous = channelMap
    .listFor(args.identity, args.destination)
    .find(
      (r) =>
        r.chain === next.chain &&
        r.tokenNetwork === next.tokenNetwork &&
        r.channelId !== next.channelId
    );
  if (previous) channelMap.supersede(previous);
  if (channelMap.list().some((r) => r.channelId === next.channelId)) {
    channelMap.touch(
      {
        identity: next.identity,
        destination: next.destination,
        chain: next.chain,
        tokenNetwork: next.tokenNetwork,
      },
      { depositTotal: next.depositTotal ?? '0' }
    );
  } else {
    channelMap.record(next);
  }
}

/** The slice of `ToonClient` the money ops drive (structural, so tests fake it). */
export interface MoneyClientLike {
  readonly chain: 'evm' | 'solana';
  readonly channel: ChannelFacade;
  readonly wallet: Pick<ToonClient['wallet'], 'balances'>;
}

/** This channel's step out of a close()/settle() that walks every channel. */
function exitResultFor(
  results: BatchExitResult[],
  channelId: string,
  step: 'close' | 'settle'
): BatchExitResult | undefined {
  const result = results.find((r) => r.channelId === channelId);
  if (result?.error !== undefined) {
    throw new Error(`channel ${step} of ${channelId} failed: ${result.error}`);
  }
  return result;
}

export function buildMoneyOps(args: {
  client: MoneyClientLike;
  channelMap: ChannelMapStore;
  identity: string;
  destination: string;
  peerId: string;
  now?: () => bigint;
}): StandaloneMoneyOps {
  const { client, channelMap } = args;
  const now = args.now ?? (() => BigInt(Math.floor(Date.now() / 1000)));
  const known = (channelId: string) =>
    channelMap.list().some((r) => r.channelId === channelId);
  /**
   * The client's own record of a recorded channel. Exit is by channel config,
   * which only the client's store holds; a record it does not know belongs to
   * another store or another node.
   */
  const held = (record: ChannelMapRecord): BatchChannelSummary => {
    const summary = client.channel
      .channels()
      .find((c) => c.channel.channelId === record.channelId);
    if (!summary) {
      throw new Error(
        `channel ${record.channelId} is not in this client's x402 channel store: ` +
          'the record belongs to another store (TOON_CLIENT_CHANNEL_STORE) or another node'
      );
    }
    return summary;
  };
  const record = (summary: BatchChannelSummary) =>
    recordChannel(channelMap, summary, args);
  return {
    async openChannel(opts): Promise<ChannelOpenOutcome> {
      const before = await client.channel.current();
      // A Solana channel has no top-up that costs no SOL: the client opens a
      // fresh sponsored one when the next packet no longer fits instead. Say
      // so before anything is opened, rather than open and then refuse.
      if (opts?.deposit !== undefined && client.chain === 'solana') {
        throw new Error(
          'a Solana x402 channel cannot be topped up: set TOON_CLIENT_DEPOSIT ' +
            '(config `deposit`) to what a channel opens with; the client opens a ' +
            'fresh sponsored channel when the current one runs out'
        );
      }
      const resumed = before !== undefined && known(before.channel.channelId);
      let summary = before ?? (await client.channel.open());
      if (opts?.deposit !== undefined) {
        summary = await client.channel.deposit(opts.deposit);
      }
      record(summary);
      return {
        channelId: summary.channel.channelId,
        resumed,
        destination: args.destination,
        chain: summary.channel.network,
        peerId: args.peerId,
        depositTotal: summary.depositTotal.toString(),
        ...(opts?.deposit !== undefined
          ? { depositAdded: opts.deposit.toString() }
          : {}),
      };
    },
    async closeChannel(rec): Promise<ChannelCloseOutcome> {
      held(rec);
      // The client leaves EVERY channel still open with the node in one call:
      // a channel replaced when it ran out still holds what it has left.
      const results = await client.channel.close();
      const result = exitResultFor(results, rec.channelId, 'close');
      const after = held(rec);
      const closedAt = after.closedAt ?? now();
      return {
        channelId: rec.channelId,
        ...(result?.transaction ? { txHash: result.transaction } : {}),
        closedAt: closedAt.toString(),
        settleableAt: (
          result?.settleableAt ??
          after.settleableAt ??
          closedAt
        ).toString(),
      };
    },
    async settleChannel(rec): Promise<ChannelSettleOutcome> {
      held(rec);
      const results = await client.channel.settle();
      const result = exitResultFor(results, rec.channelId, 'settle');
      const after = held(rec);
      if (after.settledAt === undefined) {
        const at = after.settleableAt;
        throw new Error(
          `channel ${rec.channelId} is not settleable yet` +
            (at !== undefined
              ? ` (settleable at ${new Date(Number(at) * 1000).toISOString()})`
              : '') +
            ': nothing was spent; re-run after that time'
        );
      }
      channelMap.supersede(rec);
      return {
        channelId: rec.channelId,
        ...(result?.transaction ? { txHash: result.transaction } : {}),
      };
    },
    async walletChainBalances(): Promise<WalletChainBalanceInfo[]> {
      return (await client.wallet.balances()).map((b) => ({
        chain: b.chain,
        chainKey: b.chainKey,
        address: b.address,
        ...(b.native ? { native: b.native } : {}),
        tokens: b.tokens,
        ...(b.unreadable !== undefined ? { unreadable: b.unreadable } : {}),
        ...(b.error !== undefined ? { error: b.error } : {}),
      }));
    },
  };
}

// ---------------------------------------------------------------------------
// The context factory
// ---------------------------------------------------------------------------

/** What `rig balance` gets when nothing is configured to pay with. */
class UnconfiguredPublisher {
  constructor(private readonly error: MissingUplinkError) {}
  getFeeRates(): Promise<never> {
    return Promise.reject(this.error);
  }
  uploadGitObject(): Promise<never> {
    return Promise.reject(this.error);
  }
  publishEvent(): Promise<never> {
    return Promise.reject(this.error);
  }
}

export async function createStandaloneContext(
  options: StandaloneLoadOptions
): Promise<StandaloneContext> {
  const { env } = options;
  const warn = (line: string) => options.warn(line);
  const dir = configDir(env);
  const configPath = join(dir, 'config.json');
  const file = readClientConfig(configPath);
  const identity = await resolveIdentity(options);
  const nostr = deriveNostrKeyFromMnemonic(
    identity.mnemonic,
    identity.accountIndex
  );

  const settings = resolveConnectorSettings({
    env,
    file,
    configDir: dir,
    ...(options.storeDestination
      ? { storeDestinationOverride: options.storeDestination }
      : {}),
  });
  for (const line of settings.warnings) warn(line);
  const defaultRelayUrls = settings.relayUrl ? [settings.relayUrl] : [];

  if (!settings.connectorUrl) {
    const missing = new MissingUplinkError(configPath);
    if (options.requireUplink === false) {
      return {
        ownerPubkey: nostr.pubkey,
        identitySource: identity.source,
        identitySourceLabel: identity.sourceLabel,
        publisher: new UnconfiguredPublisher(missing),
        defaultRelayUrls,
        // SHAs the 30618 object map does not cover are resolved against
        // the configured gateway's GraphQL endpoint, not arweave.net (#183).
        fetchRemote: (args) =>
          fetchRemoteState({
            ...args,
            resolveSha: shaResolverFor(undefined, env),
          }),
        stop: () => Promise.resolve(),
      };
    }
    throw missing;
  }
  const connectorUrl = settings.connectorUrl;

  // Client 4.x pays with x402 vouchers from its own store. A 3.x toon-channel
  // store is never handed to it (the connector refuses those claims, and the
  // file is what the 3.x rig needs to take its deposits back): only named.
  if (isToonChannelStore(settings.channelStorePath)) {
    throw new Error(
      `${settings.channelStorePath} is a client 3.x toon-channel store, which a current ` +
        'connector no longer honours: point TOON_CLIENT_CHANNEL_STORE (config ' +
        `channelStorePath) at a new file, e.g. ${join(dir, CHANNEL_STORE_FILENAME)}; ` +
        'the old file is left as it is'
    );
  }
  for (const legacy of legacyChannelFiles(dir)) {
    if (legacy === settings.channelStorePath) continue;
    warn(
      `rig: ${legacy} is client 3.x toon-channel state; client 4.x ignores it and keeps its ` +
        `x402 channels in ${settings.channelStorePath}`
    );
  }

  // One writer per identity per machine: two rig processes signing vouchers on
  // one channel race the running total, and the connector refuses the loser.
  if (!standaloneForced(env)) await checkDaemonIdentity(nostr.pubkey);
  const lock = await NonceLock.acquire(nostr.pubkey);

  const clients: ToonClient[] = [];
  // Set once the client is up: records the channel paid work drew on (the
  // client opens one on first use), so `rig channel list/close/settle` and
  // `rig balance` see it. Best effort: a failure here loses no money, the
  // client's own store still holds the channel.
  let recordHeld: (() => Promise<void>) | undefined;
  const stop = async () => {
    await recordHeld?.().catch(() => undefined);
    for (const c of clients) await c.close();
    lock.release();
  };

  try {
    const payerKeys: Pick<
      ToonClientConfig,
      | 'mnemonic'
      | 'accountIndex'
      | 'keyDerivation'
      | 'solanaSecretKey'
      | 'evmPrivateKey'
    > = {
      mnemonic: identity.mnemonic,
      accountIndex: identity.accountIndex,
      keyDerivation: settings.keyDerivation,
      ...(settings.solanaKeyFile
        ? { solanaSecretKey: readSolanaKeyFile(settings.solanaKeyFile) }
        : {}),
      ...(settings.evmPrivateKey
        ? { evmPrivateKey: settings.evmPrivateKey }
        : {}),
    };
    const shared: Omit<ToonClientConfig, 'connector' | 'channelStore'> = {
      ...payerKeys,
      ...(settings.chain ? { chain: settings.chain } : {}),
      ...(settings.rpcUrl ? { rpcUrl: settings.rpcUrl } : {}),
      transport: settings.transport,
      // The first paid send opens the channel (on Solana the connector
      // sponsors the open: USDC for the deposit, no SOL), and a send the
      // channel cannot cover opens a fresh one.
      autoOpenChannel: true,
      ...(settings.deposit !== undefined ? { deposit: settings.deposit } : {}),
      // A Base deposit goes through a facilitator; Solana names none, so an
      // unset facilitator on Solana is '' rather than the devnet default.
      ...(settings.facilitatorUrl !== undefined
        ? { facilitatorUrl: settings.facilitatorUrl }
        : settings.chain === 'solana'
          ? { facilitatorUrl: '' }
          : {}),
    };
    if (settings.chain && !settings.rpcUrl) {
      warn(
        `rig: no rpcUrl configured for ${settings.chain} — the client falls back to its devnet preset; ` +
          'set TOON_CLIENT_RPC_URL (or config rpcUrl) for a mainnet node'
      );
    }

    const client = await ToonClient.create({
      ...shared,
      connector: connectorUrl,
      channelStore: settings.channelStorePath,
    });
    clients.push(client);
    const desc = await client.describe();
    const destinations = resolveDestinations(desc, settings, connectorUrl);
    if (!settings.chain && desc.batchSettlements.length > 1) {
      warn(
        `rig: paying on ${client.chain}, the first chain ${connectorUrl} offers that this ` +
          `identity holds a key for (it offers ${desc.batchSettlements.map((t) => t.network).join(', ')}); ` +
          'set TOON_CLIENT_CHAIN (config chain) to choose'
      );
    }

    // The store leg: the same client unless the store terminates on another
    // node that holds its own channel (then its own client + channel store).
    let storeClient = client;
    if (
      settings.storeConnectorUrl &&
      normalizeUrl(settings.storeConnectorUrl) !== normalizeUrl(connectorUrl)
    ) {
      storeClient = await ToonClient.create({
        ...shared,
        connector: settings.storeConnectorUrl,
        channelStore: settings.channelStorePath.replace(
          /(\.json)?$/,
          '.store.json'
        ),
      });
      clients.push(storeClient);
    }

    const publisher = new ConnectorPublisher({
      publish: { client, destination: destinations.publish },
      store: {
        client: storeClient,
        destination: destinations.store,
        ...(storeClient === client && settings.storeSealTo
          ? { sealTo: settings.storeSealTo }
          : {}),
      },
      nostrSecretKey: nostr.secretKey,
      eventFee: settings.eventFee,
      ...(settings.uploadTimeoutMs !== undefined
        ? { uploadTimeoutMs: settings.uploadTimeoutMs }
        : {}),
      warn,
    });

    const channelMap = new ChannelMapStore({
      mapPath: join(dir, RIG_CHANNEL_MAP_FILENAME),
      watermarkPath: settings.channelStorePath,
    });
    const anchor = {
      identity: nostr.pubkey,
      destination: options.channelDestination ?? destinations.publish,
      peerId: desc.edgeIdentity?.keyId ?? connectorUrl,
    };
    const money = buildMoneyOps({ client, channelMap, ...anchor });
    recordHeld = async () => {
      const current = await client.channel.current();
      if (current) recordChannel(channelMap, current, anchor);
    };

    return {
      ownerPubkey: nostr.pubkey,
      identitySource: identity.source,
      identitySourceLabel: identity.sourceLabel,
      publisher,
      defaultRelayUrls,
      // As above (#183): the GraphQL fallback follows RIG_ARWEAVE_GATEWAY.
      fetchRemote: (args) =>
        fetchRemoteState({
          ...args,
          resolveSha: shaResolverFor(undefined, env),
        }),
      money,
      stop,
    };
  } catch (err) {
    await stop().catch(() => undefined);
    throw err;
  }
}

function normalizeUrl(url: string): string {
  return url.replace(/\/+$/, '').replace(/\/ilp$/, '');
}
