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

  it('omits the deposit clause entirely when the deposit total is not known', () => {
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

    const resumedLine = describeChannelOpenOutcome(resumed);
    const freshLine = describeChannelOpenOutcome(fresh);

    expect(resumedLine).toContain('0xabc');
    expect(resumedLine).not.toContain('deposit');
    expect(freshLine).toContain('0xdef');
    expect(freshLine).not.toContain('deposit');
  });
});
