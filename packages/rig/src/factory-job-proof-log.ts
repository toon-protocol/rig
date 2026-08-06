/**
 * Log formatting for a channel open/resume outcome (#67).
 *
 * `scripts/factory-job-proof.ts` opens the provider's settlement channel via
 * `StandalonePublisher.openChannelExplicit` (the same peer→channel map resume
 * path `rig channel open` uses, ./standalone/channel-map.ts) instead of an
 * unconditional `ToonClient.openChannel()` — so a rerun against the same
 * provider identity reuses its channel rather than locking another deposit.
 * This formats the {@link ChannelOpenOutcome} into one line so the run log
 * always says, unambiguously, which happened (the buzz#73 acceptance bar).
 */
import type { ChannelOpenOutcome } from './standalone/index.js';

export function describeChannelOpenOutcome(outcome: ChannelOpenOutcome): string {
  const depositSuffix =
    outcome.depositTotal !== undefined ? ` — deposit ${outcome.depositTotal}` : '';
  return outcome.resumed
    ? `resumed existing channel ${outcome.channelId}${depositSuffix} (no new collateral locked)`
    : `opened a FRESH channel ${outcome.channelId}${depositSuffix} (new collateral locked)`;
}
