/**
 * `@toon-protocol/rig/standalone` — the embedded Publisher that pays a TOON
 * connector (`@toon-protocol/client` 2.x).
 *
 * Separate subpath entry so the core package stays light at import time:
 * only this entry needs `@toon-protocol/client`.
 */

export {
  ConnectorPublisher,
  ConnectorPublishError,
  extractArweaveTxId,
  type ConnectorPublisherOptions,
  type PaidClientLike,
  type PaidFulfilled,
  type PaidLeg,
  type PaidRefused,
  type PaidRequest,
  type PaidSendOptions,
  type PaidSendResult,
  type RouteTerms,
} from './connector-publisher.js';

export {
  deriveNostrKeyFromMnemonic,
  nostrDerivationPath,
  MAX_ACCOUNT_INDEX,
  type NostrKey,
} from './nostr-identity.js';

export type {
  ChannelCloseOutcome,
  ChannelOpenOutcome,
  ChannelSettleOutcome,
  StandaloneMoneyOps,
  WalletChainBalanceInfo,
  WalletTokenAmountInfo,
} from './money.js';

export {
  ChannelMapCorruptError,
  ChannelMapStore,
  RIG_CHANNEL_MAP_FILENAME,
  channelStatus,
  counterpartyMatch,
  recordKey,
  resolveChannelPaths,
  sameSettlementAddress,
  type ChannelMapKey,
  type ChannelMapRecord,
  type ChannelMapStoreOptions,
  type PersistedChannelContext,
  type WatermarkEntry,
} from './channel-map.js';

export {
  DEFAULT_DAEMON_PORT,
  DaemonIdentityConflictError,
  NonceLock,
  StandaloneLockError,
  checkDaemonIdentity,
  defaultDaemonPort,
  defaultLockDir,
  type AcquireLockOptions,
  type CheckDaemonOptions,
} from './nonce-guard.js';
