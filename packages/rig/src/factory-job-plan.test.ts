import { describe, it, expect } from 'vitest';
import { planFactoryJob, type FactoryTicket } from './factory-job-plan.js';

const TICKET_1: FactoryTicket = { id: '1', title: 'Do A', branch: 'sandcastle/issue-1' };
const TICKET_2: FactoryTicket = { id: '2', title: 'Do B', branch: 'sandcastle/issue-2' };
const TICKET_3: FactoryTicket = { id: '3', title: 'Do C', branch: 'sandcastle/issue-3' };

describe('planFactoryJob', () => {
  it('emits plan, one increment per ticket, then review — in that order', () => {
    const schedule = planFactoryJob('5000000', [TICKET_1, TICKET_2, TICKET_3]);

    expect(schedule.map((s) => s.milestone)).toEqual([
      'plan',
      'implement',
      'implement',
      'implement',
      'review',
    ]);
    expect(schedule.map((s) => s.n)).toEqual([1, 2, 3, 4, 5]);
    expect(schedule.every((s) => s.of === 5)).toBe(true);
  });

  it('never collapses multiple tickets into one implement increment', () => {
    const schedule = planFactoryJob('9000000', [TICKET_1, TICKET_2]);
    const implementIncrements = schedule.filter((s) => s.milestone === 'implement');

    expect(implementIncrements).toHaveLength(2);
    expect(implementIncrements[0]?.ticket).toEqual(TICKET_1);
    expect(implementIncrements[1]?.ticket).toEqual(TICKET_2);
  });

  it('prices sum exactly to the bid (no leftover micro-USDC)', () => {
    const bid = '1000003'; // deliberately not evenly divisible
    const schedule = planFactoryJob(bid, [TICKET_1, TICKET_2, TICKET_3]);

    const sum = schedule.reduce((acc, s) => acc + BigInt(s.priceUsdc), 0n);
    expect(sum).toBe(BigInt(bid));
  });

  it('gives plan and review each a fixed 10% share of the bid', () => {
    const schedule = planFactoryJob('1000000', [TICKET_1]);

    expect(schedule.find((s) => s.milestone === 'plan')?.priceUsdc).toBe('100000');
    expect(schedule.find((s) => s.milestone === 'review')?.priceUsdc).toBe('100000');
  });

  it('splits the implement share evenly across tickets, remainder to the earliest', () => {
    // implement total = 1000000 - 100000 - 100000 = 800000; /3 = 266666 r2
    const schedule = planFactoryJob('1000000', [TICKET_1, TICKET_2, TICKET_3]);
    const implementPrices = schedule
      .filter((s) => s.milestone === 'implement')
      .map((s) => s.priceUsdc);

    expect(implementPrices).toEqual(['266667', '266667', '266666']);
  });

  it('throws when there are no tickets', () => {
    expect(() => planFactoryJob('1000000', [])).toThrow(/at least one/);
  });

  it('throws when the bid is not positive', () => {
    expect(() => planFactoryJob('0', [TICKET_1])).toThrow(/positive/);
    expect(() => planFactoryJob('-5', [TICKET_1])).toThrow(/positive/);
  });

  it('throws when the bid is not an integer string', () => {
    expect(() => planFactoryJob('not-a-number', [TICKET_1])).toThrow(/integer/);
  });

  it('handles a single-ticket job (implement is still its own increment)', () => {
    const schedule = planFactoryJob('300000', [TICKET_1]);
    expect(schedule).toHaveLength(3);
    expect(schedule[1]?.milestone).toBe('implement');
    expect(schedule[1]?.ticket).toEqual(TICKET_1);
  });
});
