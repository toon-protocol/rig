/**
 * Log formatting for a channel open/resume outcome (#67).
 *
 * `scripts/factory-job-proof.ts` opens the provider's settlement channel via
 * `StandalonePublisher.openChannelExplicit`, which resumes the identity's
 * recorded channel when there is one — see that script's CHANNEL REUSE note
 * for the why. This renders the {@link ChannelOpenOutcome} as one line so the
 * run log always says, unambiguously, which of the two happened (the buzz#73
 * acceptance bar).
 */
import type { ChannelOpenOutcome } from './standalone/index.js';

export function describeChannelOpenOutcome(outcome: ChannelOpenOutcome): string {
  const { channelId, depositTotal, resumed } = outcome;
  const deposit = depositTotal !== undefined ? ` — deposit ${depositTotal}` : '';
  return resumed
    ? `resumed existing channel ${channelId}${deposit} (no new collateral locked)`
    : `opened a FRESH channel ${channelId}${deposit} (new collateral locked)`;
}
