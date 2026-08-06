import { describe, it, expect } from 'vitest';
import { describeChannelOpenOutcome } from './factory-job-proof-log.js';
import type { ChannelOpenOutcome } from './standalone/index.js';

describe('describeChannelOpenOutcome', () => {
  it('says RESUMED and reports the unchanged deposit when the channel was resumed', () => {
    const outcome: ChannelOpenOutcome = {
      channelId: '0xabc',
      resumed: true,
      destination: 'g.toon.provider',
      depositTotal: '100000',
    };

    const line = describeChannelOpenOutcome(outcome);

    expect(line).toContain('resumed');
    expect(line).toContain('0xabc');
    expect(line).toContain('100000');
    expect(line).not.toMatch(/fresh/i);
  });

  it('says FRESH and reports the newly locked deposit when a channel was opened', () => {
    const outcome: ChannelOpenOutcome = {
      channelId: '0xdef',
      resumed: false,
      destination: 'g.toon.provider',
      depositTotal: '100000',
    };

    const line = describeChannelOpenOutcome(outcome);

    expect(line).toMatch(/fresh/i);
    expect(line).toContain('0xdef');
    expect(line).toContain('100000');
    expect(line).not.toMatch(/resumed/i);
  });

  it('degrades gracefully when the deposit total is not known', () => {
    const resumed: ChannelOpenOutcome = {
      channelId: '0xabc',
      resumed: true,
      destination: 'g.toon.provider',
    };
    const fresh: ChannelOpenOutcome = {
      channelId: '0xdef',
      resumed: false,
      destination: 'g.toon.provider',
    };

    expect(describeChannelOpenOutcome(resumed)).toContain('0xabc');
    expect(describeChannelOpenOutcome(fresh)).toContain('0xdef');
  });
});
