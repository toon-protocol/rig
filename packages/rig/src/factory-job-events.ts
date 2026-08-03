/**
 * Factory job protocol — pure NIP-90 event builders/parser (#52).
 *
 * Wire format per toon-meta's `docs/factory-job-protocol.md`
 * (toon-meta#263), fixed 2026-08-03: kind:5097 job request, kind:6097 job
 * result, kind:7000 job feedback (quote / increment offer / narration,
 * disambiguated by the `status` tag). Mirrors nip34-events.ts: every builder
 * returns an UnsignedEvent — the caller signs and publishes (e.g. through a
 * Publisher, publisher.ts) elsewhere. No crypto, no network, no payment.
 */

import type { UnsignedEvent } from './nip34-events.js';
import type { IncrementSpec } from './factory-job-plan.js';
import { gatePassed, type GateResult } from './factory-job-gate.js';

// ---------------------------------------------------------------------------
// Kinds
// ---------------------------------------------------------------------------

/** Factory job request (the brief). */
export const FACTORY_JOB_REQUEST_KIND = 5097;
/** Factory job result — terminal state (completed/abandoned-*). */
export const FACTORY_JOB_RESULT_KIND = 6097;
/** Factory job feedback — quote, increment offer, or free narration. */
export const FACTORY_JOB_FEEDBACK_KIND = 7000;

/** The three §5.2 terminal outcomes — decision 8 has no fourth. */
export type FactoryJobOutcome =
  | 'completed'
  | 'abandoned-provider'
  | 'abandoned-buyer';

// ---------------------------------------------------------------------------
// kind:5097 — job request
// ---------------------------------------------------------------------------

/** A parsed kind:5097 job request (§2). */
export interface FactoryJobRequest {
  /** The requesting kind:5097 event's id. */
  requestEventId: string;
  /** The requesting kind:5097 event's pubkey (who to reply/bill). */
  buyerPubkey: string;
  /** The brief — free text or a chained milestone reference (§2.3). */
  brief: string;
  /** Maximum the buyer will pay across the whole job (micro-USDC, §2.1). */
  bidMicroUsdc: string;
  /** `param repo` — target repo, e.g. `toon-protocol/buzz`. */
  repo?: string;
  /** `param target` — the ticket/issue this job resolves. */
  target?: string;
  /** `param constraints` — gate requirements / scope limits. */
  constraints?: string;
  /** `output` — expected deliverable MIME type. */
  outputMime?: string;
}

/** Minimal shape of a relay event this module reads/builds — no signing. */
export interface RelayEvent {
  id: string;
  pubkey: string;
  tags: string[][];
  content: string;
}

/**
 * Parse a kind:5097 job request event's tags into a {@link FactoryJobRequest}.
 * Throws if the required `i` (brief) or `bid` tag is missing — both are
 * REQUIRED per §2.1.
 */
export function parseFactoryJobRequest(event: RelayEvent): FactoryJobRequest {
  const briefTag = event.tags.find((t) => t[0] === 'i' && t[2] === 'text');
  if (!briefTag?.[1]) {
    throw new Error(
      `kind:${FACTORY_JOB_REQUEST_KIND} event ${event.id} is missing its required brief ("i", "<brief>", "text") tag`
    );
  }
  const bidTag = event.tags.find((t) => t[0] === 'bid');
  if (!bidTag?.[1]) {
    throw new Error(
      `kind:${FACTORY_JOB_REQUEST_KIND} event ${event.id} is missing its required "bid" tag`
    );
  }

  const params = event.tags.filter((t) => t[0] === 'param');
  const paramValue = (name: string): string | undefined =>
    params.find((t) => t[1] === name)?.[2];

  const repo = paramValue('repo');
  const target = paramValue('target');
  const constraints = paramValue('constraints');
  const outputMime = event.tags.find((t) => t[0] === 'output')?.[1];

  return {
    requestEventId: event.id,
    buyerPubkey: event.pubkey,
    brief: briefTag[1],
    bidMicroUsdc: bidTag[1],
    ...(repo !== undefined ? { repo } : {}),
    ...(target !== undefined ? { target } : {}),
    ...(constraints !== undefined ? { constraints } : {}),
    ...(outputMime !== undefined ? { outputMime } : {}),
  };
}

// ---------------------------------------------------------------------------
// kind:7000 status:"quote" — the RFQ reply (§3)
// ---------------------------------------------------------------------------

/**
 * Build the `kind:7000 status:"quote"` reply: the proposed increment
 * schedule, committing nothing (§3.3 — there is no accept message; payment
 * of increment 1 is acceptance).
 */
export function buildQuoteEvent(
  job: FactoryJobRequest,
  schedule: IncrementSpec[]
): UnsignedEvent {
  return {
    kind: FACTORY_JOB_FEEDBACK_KIND,
    content: JSON.stringify({
      increments: schedule.map((s) => ({
        n: s.n,
        of: s.of,
        milestone: s.milestone,
        priceUsdc: s.priceUsdc,
      })),
    }),
    tags: [
      ['e', job.requestEventId, '', 'root'],
      ['p', job.buyerPubkey],
      ['status', 'quote'],
    ],
    created_at: Math.floor(Date.now() / 1000),
  };
}

// ---------------------------------------------------------------------------
// kind:7000 status:"partial" — the increment offer (§4)
// ---------------------------------------------------------------------------

/** Where the encrypted increment artifact lives, and its hashlock condition. */
export interface EncryptedArtifactRef {
  /** Arweave tx id the ciphertext was uploaded to. */
  arweaveTxId: string;
  /** sha256 of the ciphertext, hex — lets the buyer detect a bad fetch. */
  ciphertextSha256: string;
  /** `sha256(key)` hex, where `key` decrypts the artifact (§4.2 — the join). */
  conditionHex: string;
}

export interface BuildIncrementOfferOptions {
  job: FactoryJobRequest;
  /** The quote event's id for increment 1, else the previous offer's id. */
  parentEventId: string;
  increment: IncrementSpec;
  artifact: EncryptedArtifactRef;
  /**
   * The reproducible gate result for this increment's work (#53 — the
   * objective floor), when one ran. Omitted for milestones with nothing to
   * gate (e.g. `plan` — there is no code to lint against a brief).
   */
  gate?: GateResult;
}

/** A gate result missing its commit or check list cannot be reproduced by the buyer — reject it here rather than publish an unverifiable claim. */
function assertReproducible(gate: GateResult): void {
  if (gate.checks.length === 0) {
    throw new Error(
      'gate result must record at least one check for the offer to be reproducible'
    );
  }
  if (!gate.commit) {
    throw new Error(
      'gate result must record the commit it ran against for the offer to be reproducible'
    );
  }
}

/**
 * Build the `kind:7000 status:"partial"` increment offer — published once
 * the provider has done that increment's work and uploaded the encrypted
 * artifact. This is the join between the relay plane and the connector
 * plane (§4.2): `condition` here MUST equal the paying PREPARE's
 * `executionCondition`, byte for byte.
 *
 * When `gate` is supplied, the offer also carries a `["gate", "pass"|"fail"]`
 * tag (cheap to scan for a gate-pass rate, decision 8) and the full
 * reproducible result in `content` — visible to the buyer before they pay,
 * per the issue: a gate-failing increment is still offered, never hidden.
 */
export function buildIncrementOfferEvent(
  options: BuildIncrementOfferOptions
): UnsignedEvent {
  const { job, parentEventId, increment, artifact, gate } = options;
  if (gate) assertReproducible(gate);

  const tags: string[][] = [
    ['e', job.requestEventId, '', 'root'],
    ['e', parentEventId, '', 'reply'],
    ['p', job.buyerPubkey],
    ['status', 'partial'],
    ['increment', String(increment.n), String(increment.of)],
    ['i', artifact.arweaveTxId, 'url'],
    ['i', artifact.ciphertextSha256, 'text', '', 'hash'],
    ['amount', increment.priceUsdc, 'usdc'],
    ['condition', artifact.conditionHex],
  ];
  if (gate) tags.push(['gate', gatePassed(gate) ? 'pass' : 'fail']);

  return {
    kind: FACTORY_JOB_FEEDBACK_KIND,
    content: gate ? JSON.stringify({ gate }) : '',
    tags,
    created_at: Math.floor(Date.now() / 1000),
  };
}

// ---------------------------------------------------------------------------
// kind:7000 status:"processing" — free narration (§6)
// ---------------------------------------------------------------------------

export interface BuildNarrationOptions {
  job: FactoryJobRequest;
  /** The prior event in the thread (quote, offer, or narration). */
  parentEventId: string;
  message: string;
}

/**
 * Build a free narration event — no artifact, no `amount`/`condition`, MUST
 * NOT be paid against (§6). This is what makes a provider look alive between
 * increments.
 */
export function buildNarrationEvent(
  options: BuildNarrationOptions
): UnsignedEvent {
  const { job, parentEventId, message } = options;
  return {
    kind: FACTORY_JOB_FEEDBACK_KIND,
    content: message,
    tags: [
      ['e', job.requestEventId, '', 'root'],
      ['e', parentEventId, '', 'reply'],
      ['p', job.buyerPubkey],
      ['status', 'processing'],
    ],
    created_at: Math.floor(Date.now() / 1000),
  };
}

// ---------------------------------------------------------------------------
// kind:6097 — job result (§5)
// ---------------------------------------------------------------------------

export interface BuildResultEventOptions {
  job: FactoryJobRequest;
  /** The original kind:5097 request event, verbatim (the `request` tag). */
  requestEvent: RelayEvent;
  /** The last kind:7000 event in the thread (offer or narration). */
  lastEventId: string;
  outcome: FactoryJobOutcome;
  /** How far the job got — `n-reached == of` only when outcome is completed. */
  reachedIncrement: number;
  totalIncrements: number;
  /** Required (and only meaningful) when outcome is `"completed"` (§5.2). */
  finalArtifact?: { arweaveTxId: string };
}

/**
 * Build the terminal `kind:6097` job result. Reputation (decision 8) is
 * computed from exactly this event and nothing else.
 */
export function buildResultEvent(
  options: BuildResultEventOptions
): UnsignedEvent {
  const {
    job,
    requestEvent,
    lastEventId,
    outcome,
    reachedIncrement,
    totalIncrements,
    finalArtifact,
  } = options;

  const tags: string[][] = [
    ['e', job.requestEventId, '', 'root'],
    ['e', lastEventId, '', 'reply'],
    ['p', job.buyerPubkey],
    ['request', JSON.stringify(requestEvent)],
    ['outcome', outcome],
    ['increment', String(reachedIncrement), String(totalIncrements)],
  ];
  if (outcome === 'completed' && finalArtifact) {
    tags.push(['i', finalArtifact.arweaveTxId, 'url']);
  }

  return {
    kind: FACTORY_JOB_RESULT_KIND,
    content: '',
    tags,
    created_at: Math.floor(Date.now() / 1000),
  };
}
