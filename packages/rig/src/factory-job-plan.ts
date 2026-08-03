/**
 * Factory job protocol — increment schedule planner (#52).
 *
 * `planFactoryJob` is the network-free half of the adapter (mirrors
 * `planPush`'s split from `executePush` in push.ts): given a job's `bid` and
 * the ticket list the factory's plan phase produced, it prices the
 * milestone boundaries decision 6 of toon-meta#262 fixed as increments —
 * plan → implement ×N tickets → review — and returns the schedule that
 * becomes the `kind:7000 status:"quote"` content (§3.2 of
 * `docs/factory-job-protocol.md`).
 *
 * Per the issue gotcha, `implement` must be many increments, not one: this
 * always emits one increment per ticket rather than a single lump-sum
 * implement increment, using the factory's existing parallel per-issue
 * fan-out (`.sandcastle/main.ts`'s Plan phase output — `{issues: [{id,
 * title, branch}]}`) as the boundary.
 */

/** One ticket the factory's plan phase fanned the implement milestone into. */
export interface FactoryTicket {
  id: string;
  title: string;
  branch: string;
}

export type FactoryMilestone = 'plan' | 'implement' | 'review';

/** One priced increment in the schedule (§3.2's `increments[]` shape). */
export interface IncrementSpec {
  n: number;
  of: number;
  milestone: FactoryMilestone;
  /** Set only for `milestone: "implement"` increments. */
  ticket?: FactoryTicket;
  priceUsdc: string;
}

/** Plan milestone's share of the bid, in basis points. */
const PLAN_SHARE_BPS = 1000n; // 10%
/** Review milestone's share of the bid, in basis points. */
const REVIEW_SHARE_BPS = 1000n; // 10%
const BPS_DENOM = 10000n;

/**
 * Build the increment schedule for a job, given the tickets its plan phase
 * produced. Plan and review each get a fixed 10% of the bid; the remaining
 * 80% ("implement") splits evenly across tickets, with the integer-division
 * remainder distributed one micro-USDC at a time to the earliest tickets —
 * so `sum(priceUsdc) === bid` exactly (§3.2 only requires `<=`, but an exact
 * match avoids "where did the leftover micro-USDC go" questions).
 *
 * Per decision 7, this schedule is agreed before any paid work starts and is
 * never repriced — a job that runs larger than `tickets` implied is a
 * lesson, not a renegotiation.
 *
 * Throws if `tickets` is empty (a job with no implementation work has no
 * increments to schedule) or `bidMicroUsdc` is not a positive integer.
 */
export function planFactoryJob(
  bidMicroUsdc: string,
  tickets: FactoryTicket[]
): IncrementSpec[] {
  if (tickets.length === 0) {
    throw new Error(
      'planFactoryJob requires at least one implementation ticket from the plan phase'
    );
  }

  let bid: bigint;
  try {
    bid = BigInt(bidMicroUsdc);
  } catch {
    throw new Error(`bidMicroUsdc must be an integer string, got ${bidMicroUsdc}`);
  }
  if (bid <= 0n) {
    throw new Error(`bidMicroUsdc must be positive, got ${bidMicroUsdc}`);
  }

  const planPrice = (bid * PLAN_SHARE_BPS) / BPS_DENOM;
  const reviewPrice = (bid * REVIEW_SHARE_BPS) / BPS_DENOM;
  const implementTotal = bid - planPrice - reviewPrice;

  const ticketCount = BigInt(tickets.length);
  const base = implementTotal / ticketCount;
  const remainder = implementTotal % ticketCount;

  const total = tickets.length + 2;
  const schedule: IncrementSpec[] = [
    { n: 1, of: total, milestone: 'plan', priceUsdc: planPrice.toString() },
  ];

  tickets.forEach((ticket, i) => {
    const price = base + (BigInt(i) < remainder ? 1n : 0n);
    schedule.push({
      n: i + 2,
      of: total,
      milestone: 'implement',
      ticket,
      priceUsdc: price.toString(),
    });
  });

  schedule.push({
    n: total,
    of: total,
    milestone: 'review',
    priceUsdc: reviewPrice.toString(),
  });

  return schedule;
}
