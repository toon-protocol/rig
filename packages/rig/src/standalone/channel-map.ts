/**
 * Peer→channel map for the STANDALONE embedded publisher (#262).
 *
 * Why this exists: rig used to open (and fund) a FRESH on-chain channel per
 * invocation, because the client of the day kept the peer→channelId mapping
 * only in memory (the #260 fresh-outsider e2e stranded five deposits across
 * five commands). Since client 4.x the client persists its own channel config
 * beside the watermark (`JsonFileChannelStore`: `channels-x402.json` plus its
 * `.peers.json` sibling) and resumes from it by itself. This map remains the
 * record `rig channel list/close/settle`, `rig balance` and `rig ci serve`
 * read: WHICH channel the identity holds with each peer, keyed by
 * `identity pubkey | ILP anchor (peer/apex destination) | chain | tokenNetwork`.
 *
 * VOUCHERS (client 4.x, connector ADR 0075): every paid packet carries an x402
 * `batch-settlement` voucher naming the running total. There is no nonce; the
 * watermark is the cumulative amount alone. The toon-channel claims client
 * 3.x signed are refused by a current connector, so a 3.x rig's files
 * (`rig-channels.json`, `channels.json`) are never read by this module and
 * never written: they are only named, so their deposits can still be taken
 * back with the rig that opened them ({@link legacyChannelFiles}).
 *
 * It is the standalone twin of the daemon's
 * `packages/client-mcp/src/daemon/apex-channel-store.ts` — same record shape
 * (channelId + the chain context), extended with the identity pubkey (rig
 * identities come from an env/`.env` precedence chain, so one state dir can
 * serve several identities) and the tokenNetwork.
 * `@toon-protocol/rig` must not import `@toon-protocol/client-mcp` (that
 * package depends on this one — circular), hence the twin; keep the
 * semantics in sync.
 *
 * CONCURRENCY: writes happen only from paid commands, which already hold the
 * per-identity advisory lockfile (./nonce-guard.ts `NonceLock`) for their
 * whole lifetime: the same guard that serializes the voucher watermark also
 * serializes this file for one identity. `rig channel list` reads only.
 *
 * COUNTERPARTY: the key names a ROUTE, not a node — an ILP name can change
 * hands (the devnet apex `g.toon` was retired and another node took over
 * `g.toon.relay`). A record therefore also carries the counterparty
 * settlement address it was opened against (`context.recipient`), which can be
 * re-checked against the destination's announced address ({@link
 * counterpartyMatch}); a rotated counterparty {@link ChannelMapStore.supersede}s
 * the record rather than paying a connector with no record of that channel.
 *
 * CORRUPTION: an unreadable/invalid map file is a hard
 * {@link ChannelMapCorruptError} — surfaced BEFORE any on-chain open — never
 * an empty fallback. Falling back to "no channels" would silently open (and
 * fund) a duplicate channel, which is exactly the #262 bug.
 *
 * This module is dependency-light on purpose (node:fs only): the free
 * `rig channel list` command reads it without the optional
 * `@toon-protocol/client` peer dependency installed.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

// ---------------------------------------------------------------------------
// Paths (TOON_CLIENT_HOME conventions — see nonce-guard.ts module doc)
// ---------------------------------------------------------------------------

/** Map filename under the shared client state dir (x402 voucher channels). */
export const RIG_CHANNEL_MAP_FILENAME = 'rig-channels-x402.json';

/**
 * The client's x402 channel store under the shared client state dir: the
 * voucher watermark, with every channel's config in the `.peers.json` sibling.
 * A new name for client 4.x so a 3.x store is never read as one.
 */
export const CHANNEL_STORE_FILENAME = 'channels-x402.json';

/** What a client 3.x rig kept its toon-channel map in. Never read or written. */
export const LEGACY_RIG_CHANNEL_MAP_FILENAME = 'rig-channels.json';

/** What a client 3.x rig kept its toon-channel watermark in. Never read or written. */
export const LEGACY_CHANNEL_STORE_FILENAME = 'channels.json';

/**
 * Resolve the two channel-state files under `TOON_CLIENT_HOME` (default
 * `~/.toon-client`): the rig peer→channel map, and the client's x402 voucher
 * store (`config.json`'s `channelStorePath`, default
 * `<dir>/channels-x402.json`: the same resolution `cli/standalone-mode.ts`
 * feeds the embedded ToonClient).
 */
export function resolveChannelPaths(env: NodeJS.ProcessEnv): {
  mapPath: string;
  watermarkPath: string;
} {
  const dir = env['TOON_CLIENT_HOME'] ?? join(homedir(), '.toon-client');
  let configured: string | undefined;
  try {
    const raw = readFileSync(join(dir, 'config.json'), 'utf8');
    const parsed = JSON.parse(raw) as { channelStorePath?: unknown };
    if (typeof parsed.channelStorePath === 'string') {
      configured = parsed.channelStorePath;
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new Error(
        `failed to read client config at ${join(dir, 'config.json')}: ` +
          `${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
  return {
    mapPath: join(dir, RIG_CHANNEL_MAP_FILENAME),
    watermarkPath: configured ?? join(dir, CHANNEL_STORE_FILENAME),
  };
}

/**
 * The client 3.x channel files present in a state dir: a toon-channel map and
 * watermark a current connector no longer honours. Named so a caller can say
 * they were skipped; the deposits they record are left for the 3.x rig that
 * opened them (`npm i -g @toon-protocol/rig@4.7.0`, then `rig channel close`).
 */
export function legacyChannelFiles(dir: string): string[] {
  return [LEGACY_RIG_CHANNEL_MAP_FILENAME, LEGACY_CHANNEL_STORE_FILENAME]
    .map((name) => join(dir, name))
    .filter((path) => existsSync(path));
}

/**
 * Does `path` hold a client 3.x toon-channel store? Its watermark entries
 * carry a nonce that moved (a 4.x entry keeps `nonce: 0` for the file's
 * sake), and its `.peers.json` bindings carry no `batchSettlement` config.
 * An unreadable file answers false: the client reports it on its own read.
 */
export function isToonChannelStore(path: string): boolean {
  const read = (p: string): Record<string, unknown> | undefined => {
    try {
      const parsed: unknown = JSON.parse(readFileSync(p, 'utf8'));
      return typeof parsed === 'object' && parsed !== null
        ? (parsed as Record<string, unknown>)
        : undefined;
    } catch {
      return undefined;
    }
  };
  const entries = Object.values(read(path) ?? {});
  if (
    entries.some(
      (e) =>
        typeof e === 'object' &&
        e !== null &&
        typeof (e as { nonce?: unknown }).nonce === 'number' &&
        (e as { nonce: number }).nonce > 0
    )
  ) {
    return true;
  }
  const bindings = Object.values(
    read(path.replace(/(\.json)?$/, '.peers.json')) ?? {}
  );
  return bindings.some(
    (b) =>
      typeof b === 'object' &&
      b !== null &&
      (b as { batchSettlement?: unknown }).batchSettlement === undefined
  );
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A channel's chain context (same shape the daemon's apex-channel-store
 * persists, and the client's own binding carries).
 */
export interface PersistedChannelContext {
  chainType: string;
  chainId: number;
  tokenNetworkAddress: string;
  tokenAddress?: string;
  /** Counterparty settlement address (required for Solana/Mina proofs). */
  recipient?: string;
}

/** One persisted peer→channel binding. */
export interface ChannelMapRecord {
  /** On-chain payment channel id. */
  channelId: string;
  /** The node's sealing key id (`GET /ilp` `edgeIdentity.keyId`), else its URL. */
  peerId: string;
  /** Hex Nostr pubkey of the identity that opened the channel. */
  identity: string;
  /** ILP anchor destination the channel was opened against (peer/apex). */
  destination: string;
  /** The x402 network the channel lives on, e.g. `eip155:8453`, `solana:5eykt…`. */
  chain: string;
  /** The batch-settlement contract (EVM) or program (Solana) holding it. */
  tokenNetwork: string;
  /** Chain context: chain type, token, counterparty. */
  context: PersistedChannelContext;
  /** On-chain deposit total (base units, string), when known. */
  depositTotal?: string;
  /** ISO timestamps. */
  openedAt: string;
  lastUsedAt: string;
  /**
   * ISO timestamp this record was RETIRED from the resume path because the
   * destination now announces a different settlement address than the channel
   * was opened against (see {@link counterpartyMatch} /
   * {@link ChannelMapStore.supersede}). A superseded record is never resumed
   * again, but stays in {@link ChannelMapStore.list} so `rig channel
   * list/close/settle` can still reclaim whatever it holds on-chain.
   */
  supersededAt?: string;
}

/** The composite key a record is stored under. */
export interface ChannelMapKey {
  identity: string;
  destination: string;
  chain: string;
  tokenNetwork: string;
}

/**
 * One entry of the client's voucher watermark store (`channels-x402.json`):
 * format DUPLICATED from `@toon-protocol/client`'s `JsonFileChannelStore`
 * (`packages/client/src/channel/ChannelStore.ts`); keep in sync.
 */
export interface WatermarkEntry {
  /** Always 0 for an x402 channel: vouchers carry no nonce. Kept for the file's shape. */
  nonce?: number;
  /** Cumulative amount signed so far, base units (string-encoded bigint). */
  cumulativeAmount: string;
  /** Exit timers, string-encoded unix SECONDS. */
  closedAt?: string;
  settleableAt?: string;
  settledAt?: string;
}

/** The peer→channel map file is unreadable or malformed. */
export class ChannelMapCorruptError extends Error {
  constructor(
    public readonly path: string,
    detail: string
  ) {
    super(
      `channel state file ${path} is corrupt (${detail}) — refusing to ` +
        'continue: proceeding would silently open (and fund) a duplicate ' +
        'on-chain channel. Fix or remove the file; removing it makes rig ' +
        'forget which channels it holds (existing deposits stay locked ' +
        'on-chain until settled).'
    );
    this.name = 'ChannelMapCorruptError';
  }
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

interface MapFile {
  version: 1;
  channels: Record<string, ChannelMapRecord>;
}

function keyOf(key: ChannelMapKey): string {
  return `${key.identity}|${key.destination}|${key.chain}|${key.tokenNetwork}`;
}

/**
 * Archive key a {@link ChannelMapStore.supersede}d record moves to: the live
 * key plus the channel id, so the retired record survives the fresh channel
 * being recorded under the live key (deposits it still holds stay reachable
 * from `rig channel list/close/settle`) and several supersessions of the same
 * route never collide.
 */
function supersededKeyOf(record: ChannelMapRecord): string {
  return `${keyOf(recordKey(record))}|superseded:${record.channelId}`;
}

/**
 * Compare settlement addresses. EVM addresses travel in mixed checksum case
 * (an announce may say `0xF29f…` where the record says `0xf29f…`) and are
 * compared case-insensitively; anything else (base58 Solana, base58check
 * Mina) is case-SIGNIFICANT and compared verbatim.
 */
export function sameSettlementAddress(a: string, b: string): boolean {
  const normalize = (v: string): string =>
    /^0x[0-9a-fA-F]+$/.test(v) ? v.toLowerCase() : v;
  return normalize(a) === normalize(b);
}

/**
 * Does a recorded channel still belong to the counterparty the destination
 * announces TODAY?
 *
 * The map key is `identity|destination|chain|tokenNetwork` — it carries no
 * counterparty. When the node terminating an ILP name is REPLACED (the devnet
 * apex `g.toon` was retired and another node took over `g.toon.relay`), all
 * four key fields still match, so rig resumed a channel opened against the
 * old node and signed claims against it. The new connector holds no record of
 * that channel and refuses every packet: `F01 - claim rejected: names a
 * channel this connector has no record of`. Every paid write failed until the
 * cache entry was deleted by hand.
 *
 * - `'match'` — same counterparty, safe to resume.
 * - `'mismatch'` — the counterparty rotated: the record must be superseded and
 *   the channel re-resolved.
 * - `'unrecorded'` — nothing to compare (a record written before this field
 *   was validated, or a peer that announced no settlement address). Resume is
 *   allowed and the caller should enrich the record with what the announce
 *   says, so the NEXT run is verifiable.
 */
export function counterpartyMatch(
  record: Pick<ChannelMapRecord, 'context'>,
  announced: string | undefined
): 'match' | 'mismatch' | 'unrecorded' {
  const recorded = record.context.recipient;
  if (!recorded || !announced) return 'unrecorded';
  return sameSettlementAddress(recorded, announced) ? 'match' : 'mismatch';
}

/** The key fields of a full record. */
export function recordKey(record: ChannelMapRecord): ChannelMapKey {
  return {
    identity: record.identity,
    destination: record.destination,
    chain: record.chain,
    tokenNetwork: record.tokenNetwork,
  };
}

function isContext(v: unknown): v is PersistedChannelContext {
  if (typeof v !== 'object' || v === null) return false;
  const c = v as Record<string, unknown>;
  return (
    typeof c['chainType'] === 'string' &&
    typeof c['chainId'] === 'number' &&
    typeof c['tokenNetworkAddress'] === 'string'
  );
}

function isRecord(v: unknown): v is ChannelMapRecord {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r['channelId'] === 'string' &&
    typeof r['peerId'] === 'string' &&
    typeof r['identity'] === 'string' &&
    typeof r['destination'] === 'string' &&
    typeof r['chain'] === 'string' &&
    typeof r['tokenNetwork'] === 'string' &&
    isContext(r['context'])
  );
}

export interface ChannelMapStoreOptions {
  /** The rig peer→channel map file (`rig-channels.json`). */
  mapPath: string;
  /** The client's voucher watermark store (`channels-x402.json`). */
  watermarkPath: string;
}

/**
 * File-backed peer→channel map + read/seed access to the client's voucher
 * watermark store. Synchronous I/O (matches the client's `ChannelStore`
 * surface); see the module doc for the locking and corruption contracts.
 */
export class ChannelMapStore {
  readonly mapPath: string;
  readonly watermarkPath: string;

  constructor(options: ChannelMapStoreOptions) {
    this.mapPath = options.mapPath;
    this.watermarkPath = options.watermarkPath;
  }

  /** All recorded channels. @throws {ChannelMapCorruptError} */
  list(): ChannelMapRecord[] {
    return Object.values(this.readMap().channels);
  }

  /**
   * Recorded channels for one (identity, destination) pair — the resume
   * candidates for a paid command. Superseded records are EXCLUDED: they are
   * retired from the resume path for good, and only `list()` (what `rig
   * channel` enumerates) still shows them. @throws {ChannelMapCorruptError}
   */
  listFor(identity: string, destination: string): ChannelMapRecord[] {
    return this.list().filter(
      (r) =>
        r.identity === identity &&
        r.destination === destination &&
        r.supersededAt === undefined
    );
  }

  /**
   * Record a (freshly opened) channel. Overwrites any previous record under
   * the same (identity, destination, chain, tokenNetwork) key; a caller that
   * replaces a channel still holding a deposit {@link supersede}s the old
   * record first. Its watermark stays in the watermark store.
   */
  record(
    record: Omit<ChannelMapRecord, 'openedAt' | 'lastUsedAt'> &
      Partial<Pick<ChannelMapRecord, 'openedAt' | 'lastUsedAt'>>
  ): void {
    const now = new Date().toISOString();
    const full: ChannelMapRecord = {
      ...record,
      openedAt: record.openedAt ?? now,
      lastUsedAt: record.lastUsedAt ?? now,
    };
    const data = this.readMap();
    data.channels[keyOf(recordKey(full))] = full;
    this.writeMap(data);
  }

  /**
   * Bump a record's `lastUsedAt` (and optionally its known on-chain deposit,
   * or the counterparty a pre-validation record was written without) after
   * resuming it. Unknown keys are a no-op.
   */
  touch(
    key: ChannelMapKey,
    update?: { depositTotal?: string; recipient?: string }
  ): void {
    const data = this.readMap();
    const existing = data.channels[keyOf(key)];
    if (!existing) return;
    existing.lastUsedAt = new Date().toISOString();
    if (update?.depositTotal !== undefined) {
      existing.depositTotal = update.depositTotal;
    }
    if (update?.recipient !== undefined) {
      existing.context.recipient = update.recipient;
    }
    this.writeMap(data);
  }

  /**
   * Retire a record from the resume path — the counterparty that terminates
   * its destination has been REPLACED, so the channel it names is dead to the
   * new node (`F01 - claim rejected`) even though every key field still
   * matches (see {@link counterpartyMatch}).
   *
   * The record is MOVED to an archive key rather than deleted: it may still
   * hold an on-chain deposit, and `rig channel list/close/settle` find
   * channels by scanning `list()`, so deleting it would strand those funds
   * behind hand-editing the JSON. Moving it also frees the live key for the
   * re-resolved channel. Idempotent, and a no-op for an unknown record.
   */
  supersede(record: ChannelMapRecord): void {
    const data = this.readMap();
    const liveKey = keyOf(recordKey(record));
    const existing = data.channels[liveKey];
    const isLive =
      existing !== undefined && existing.channelId === record.channelId;
    const retired: ChannelMapRecord = {
      ...(isLive && existing ? existing : record),
      supersededAt: record.supersededAt ?? new Date().toISOString(),
    };
    const channels: Record<string, ChannelMapRecord> = {};
    for (const [key, value] of Object.entries(data.channels)) {
      // The live key is FREED (not just re-pointed): the re-resolved channel
      // is recorded under it moments later.
      if (isLive && key === liveKey) continue;
      channels[key] = value;
    }
    channels[supersededKeyOf(retired)] = retired;
    this.writeMap({ ...data, channels });
  }

  /**
   * Read one channel's watermark entry from the client's voucher store
   * (undefined when the file or entry is missing).
   * @throws {ChannelMapCorruptError} when the watermark file is unreadable.
   */
  readWatermark(channelId: string): WatermarkEntry | undefined {
    return this.readWatermarkFile()[channelId];
  }

  /**
   * Seed a fresh channel's watermark entry (cumulative 0) so a
   * later resume can tell "never claimed against" apart from "watermark
   * lost". Never overwrites an existing entry.
   */
  seedWatermark(channelId: string): void {
    const data = this.readWatermarkFile();
    if (data[channelId]) return;
    data[channelId] = { nonce: 0, cumulativeAmount: '0' };
    mkdirSync(dirname(this.watermarkPath), { recursive: true });
    writeFileSync(this.watermarkPath, JSON.stringify(data, null, 2), 'utf-8');
  }

  // ── file I/O ───────────────────────────────────────────────────────────────

  private readMap(): MapFile {
    let raw: string;
    try {
      raw = readFileSync(this.mapPath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return { version: 1, channels: {} };
      }
      throw new ChannelMapCorruptError(
        this.mapPath,
        err instanceof Error ? err.message : String(err)
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new ChannelMapCorruptError(
        this.mapPath,
        `invalid JSON: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      (parsed as { version?: unknown }).version !== 1 ||
      typeof (parsed as { channels?: unknown }).channels !== 'object' ||
      (parsed as { channels?: unknown }).channels === null
    ) {
      throw new ChannelMapCorruptError(
        this.mapPath,
        'expected { "version": 1, "channels": { … } }'
      );
    }
    const channels = (parsed as { channels: Record<string, unknown> }).channels;
    for (const [key, value] of Object.entries(channels)) {
      if (!isRecord(value)) {
        throw new ChannelMapCorruptError(
          this.mapPath,
          `entry ${JSON.stringify(key)} is missing required fields`
        );
      }
    }
    return parsed as MapFile;
  }

  private writeMap(data: MapFile): void {
    mkdirSync(dirname(this.mapPath), { recursive: true });
    writeFileSync(this.mapPath, JSON.stringify(data, null, 2), {
      mode: 0o600,
    });
  }

  private readWatermarkFile(): Record<string, WatermarkEntry> {
    let raw: string;
    try {
      raw = readFileSync(this.watermarkPath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw new ChannelMapCorruptError(
        this.watermarkPath,
        err instanceof Error ? err.message : String(err)
      );
    }
    try {
      return JSON.parse(raw) as Record<string, WatermarkEntry>;
    } catch (err) {
      throw new ChannelMapCorruptError(
        this.watermarkPath,
        `invalid JSON: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Status derivation
// ---------------------------------------------------------------------------

/**
 * Where a channel sits in the exit journey, from its watermark timers:
 * mirrors what the client's `channel.channels()` reports. A missing entry reads as
 * `open` (recorded channels are seeded at open time; a lost watermark file
 * surfaces separately as unknown claim state).
 */
export function channelStatus(
  entry: WatermarkEntry | undefined,
  nowSec: number = Math.floor(Date.now() / 1000)
): 'open' | 'closing' | 'settleable' | 'settled' {
  if (!entry || entry.closedAt === undefined) return 'open';
  if (entry.settledAt !== undefined) return 'settled';
  if (
    entry.settleableAt !== undefined &&
    BigInt(nowSec) >= BigInt(entry.settleableAt)
  ) {
    return 'settleable';
  }
  return 'closing';
}
