/**
 * executeFactoryJob — the adapter's imperative shell (#52): runs the
 * factory's own milestones (`.sandcastle/main.ts`'s plan → per-ticket
 * implement+review → merge phases) through `hooks`, and turns each
 * milestone boundary into a paid increment via `publisher` (existing,
 * publisher.ts — upload + event publish) and `delivery` (new,
 * factory-job-delivery.ts — encrypt + payment wait).
 *
 * Mirrors `executePush`'s split from `planPush`: `planFactoryJob` is the
 * network-free planning half; this is the half that spends money.
 *
 * Decision 6 (toon-meta#262): work happens BEFORE the packet, so every
 * increment's artifact is produced and uploaded before that increment is
 * offered for payment. Decision 7: the schedule is fixed once the quote is
 * published — this never reprices mid-job. Per the issue: "Stop on
 * non-payment. One unpaid increment and work halts" — the symmetric
 * protection that neither side is ever exposed for more than one increment.
 */

import type { Publisher } from './publisher.js';
import type { JobDeliveryPort } from './factory-job-delivery.js';
import {
  buildIncrementOfferEvent,
  buildQuoteEvent,
  buildResultEvent,
  type FactoryJobOutcome,
  type FactoryJobRequest,
  type RelayEvent,
} from './factory-job-events.js';
import type { GateResult } from './factory-job-gate.js';
import {
  planFactoryJob,
  type FactoryTicket,
  type IncrementSpec,
} from './factory-job-plan.js';

/** One milestone's deliverable, plus the gate result that ran against it, when one did. */
export interface FactoryJobWork {
  artifact: Uint8Array;
  /**
   * The reproducible gate result (#53) for this milestone's work, per
   * `FACTORY.md`'s pinned pipeline (lint/typecheck/test/build). Omitted for
   * `plan` — there is no code to gate against a brief.
   */
  gate?: GateResult;
}

/** Runs one factory milestone and returns its deliverable, plus that milestone's gate result. */
export interface FactoryJobHooks {
  /**
   * Runs the factory's plan phase for `job` (mirrors `.sandcastle/main.ts`'s
   * Phase 1): returns the per-ticket fan-out the implement milestone splits
   * into, plus the plan document itself as increment 1's artifact. No gate
   * result — planning produces no code to lint/typecheck/test/build.
   */
  plan(
    job: FactoryJobRequest
  ): Promise<{ tickets: FactoryTicket[]; artifact: Uint8Array }>;
  /**
   * Runs one ticket's implement sandbox pipeline (mirrors Phase 2's
   * per-issue `sandbox.run`, which ends in the gate per `FACTORY.md`) and
   * returns its deliverable (e.g. the ticket's diff) plus that run's gate
   * result.
   */
  implement(ticket: FactoryTicket): Promise<FactoryJobWork>;
  /**
   * Runs the factory's merge/review phase over every completed ticket
   * (mirrors Phase 3, which re-runs the gate per `merge-prompt.md`) and
   * returns the final deliverable plus that run's gate result.
   */
  review(tickets: FactoryTicket[]): Promise<FactoryJobWork>;
}

export interface ExecuteFactoryJobOptions {
  job: FactoryJobRequest;
  /** The original kind:5097 request event, verbatim — carried in the result's `request` tag. */
  requestEvent: RelayEvent;
  hooks: FactoryJobHooks;
  publisher: Publisher;
  delivery: JobDeliveryPort;
  relayUrls: string[];
}

export interface FactoryJobExecution {
  outcome: FactoryJobOutcome;
  /** The last increment successfully paid for (0 if the buyer never paid increment 1). */
  reachedIncrement: number;
  totalIncrements: number;
  /** The published kind:6097 result event's id. */
  resultEventId: string;
}

async function workFor(
  spec: IncrementSpec,
  tickets: FactoryTicket[],
  planArtifact: Uint8Array,
  hooks: FactoryJobHooks
): Promise<FactoryJobWork> {
  if (spec.milestone === 'plan') return { artifact: planArtifact };
  if (spec.milestone === 'implement') {
    if (!spec.ticket) {
      throw new Error(
        `internal: implement increment ${spec.n} is missing its ticket`
      );
    }
    return hooks.implement(spec.ticket);
  }
  return hooks.review(tickets);
}

/**
 * Run a job end to end: plan → quote → one increment per milestone boundary
 * (encrypt, upload, offer, wait for payment) → terminal kind:6097 result.
 * Halts at the first unpaid increment (`abandoned-buyer`) or the first
 * hook failure once work is underway (`abandoned-provider`) — see §5.2 of
 * `docs/factory-job-protocol.md` for the three terminal outcomes.
 *
 * Throws if `hooks.plan` itself fails — with no quote ever published, there
 * is no prior kind:7000 event for a result's `reply` e-tag to reference, so
 * no protocol event can be honestly emitted for that failure.
 */
export async function executeFactoryJob(
  options: ExecuteFactoryJobOptions
): Promise<FactoryJobExecution> {
  const { job, requestEvent, hooks, publisher, delivery, relayUrls } =
    options;

  if (!publisher.uploadBlob) {
    throw new Error(
      'the active publisher cannot upload an encrypted increment artifact ' +
        '(uploadBlob unavailable) — executeFactoryJob requires the standalone publisher'
    );
  }
  const uploadBlob = publisher.uploadBlob.bind(publisher);

  const { tickets, artifact: planArtifact } = await hooks.plan(job);
  const schedule = planFactoryJob(job.bidMicroUsdc, tickets);
  const totalIncrements = schedule.length;

  const quoteEvent = buildQuoteEvent(job, schedule);
  const quoteReceipt = await publisher.publishEvent(quoteEvent, relayUrls);

  let parentEventId = quoteReceipt.eventId;
  let reachedIncrement = 0;
  let finalArtifactTxId: string | undefined;

  const haltWith = async (
    outcome: FactoryJobOutcome
  ): Promise<FactoryJobExecution> => {
    const resultEvent = buildResultEvent({
      job,
      requestEvent,
      lastEventId: parentEventId,
      outcome,
      reachedIncrement,
      totalIncrements,
      ...(outcome === 'completed' && finalArtifactTxId
        ? { finalArtifact: { arweaveTxId: finalArtifactTxId } }
        : {}),
    });
    const resultReceipt = await publisher.publishEvent(
      resultEvent,
      relayUrls
    );
    return {
      outcome,
      reachedIncrement,
      totalIncrements,
      resultEventId: resultReceipt.eventId,
    };
  };

  for (const spec of schedule) {
    let work: FactoryJobWork;
    try {
      work = await workFor(spec, tickets, planArtifact, hooks);
    } catch {
      // Provider-side failure mid-job: stop where we are, no renegotiation.
      return haltWith('abandoned-provider');
    }

    const encrypted = await delivery.encryptArtifact(work.artifact);
    const uploadReceipt = await uploadBlob({
      body: Buffer.from(encrypted.ciphertext),
      contentType: 'application/octet-stream',
      ...(job.repo ? { repoId: job.repo } : {}),
    });

    const offerEvent = buildIncrementOfferEvent({
      job,
      parentEventId,
      increment: spec,
      artifact: {
        arweaveTxId: uploadReceipt.txId,
        ciphertextSha256: encrypted.ciphertextSha256,
        conditionHex: encrypted.conditionHex,
      },
      ...(work.gate ? { gate: work.gate } : {}),
    });
    const offerReceipt = await publisher.publishEvent(offerEvent, relayUrls);

    const paid = await delivery.waitForPayment({
      offerEventId: offerReceipt.eventId,
      conditionHex: encrypted.conditionHex,
      priceUsdc: spec.priceUsdc,
    });
    if (!paid) {
      parentEventId = offerReceipt.eventId;
      return haltWith('abandoned-buyer');
    }

    reachedIncrement = spec.n;
    parentEventId = offerReceipt.eventId;
    if (spec.milestone === 'review') finalArtifactTxId = uploadReceipt.txId;
  }

  return haltWith('completed');
}
