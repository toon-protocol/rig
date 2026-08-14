/**
 * ClientJobDeliveryPort — the concrete `JobDeliveryPort` (#52, #56) backed
 * by the real, published `@toon-protocol/client` (>=0.26.0) hashlock
 * helpers (toon-client#495) and serve-side job handling (toon-client#494).
 *
 * Per the issue's explicit instruction, this never re-derives the
 * encrypt/condition relationship locally: `encryptArtifact` is the only
 * place a key or condition is minted, and `fulfillIncrement` is the only
 * place a key becomes an ILP fulfillment.
 *
 * Wiring: pass `handleJob` as `ToonClientConfig.jobHandler` for the SAME
 * identity that runs `executeFactoryJob` (job serving rides the provider's
 * own BTP session, per that field's doc). The connector delivers the
 * buyer's paying PREPARE as a server-originated BTP MESSAGE addressed to
 * this client's own ILP address; `handleJob` reveals the key minted by the
 * immediately-preceding `encryptArtifact` call as the fulfillment — which
 * is simultaneously the payment settling and the decrypt-key handoff
 * (docs/factory-job-protocol.md §4.2, toon-meta).
 *
 * One increment in flight at a time, matching `JobDeliveryPort`'s own
 * sequential-use contract: `encryptArtifact` stages a key, and only
 * `waitForPayment` for that SAME condition arms `handleJob` to spend it. A
 * job PREPARE for any other condition — stray, replayed, or for an
 * increment this port never staged — is refused rather than fulfilled.
 */

import { createHash } from 'node:crypto';
import {
  encryptArtifact as clientEncryptArtifact,
  fulfillIncrement,
  type JobAnswer,
  type JobHandler,
  type JobRequest,
} from '@toon-protocol/client';
import type {
  EncryptedArtifact,
  JobDeliveryPort,
  OfferedIncrement,
} from './factory-job-delivery.js';

function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

interface ArmedIncrement {
  key: Uint8Array;
  conditionHex: string;
  /** Decimal micro-USDC, the same units as `JobRequest.amount` (#87). */
  priceUsdc: string;
  resolve: (paid: boolean) => void;
}

export interface ClientJobDeliveryPortOptions {
  /** How long to wait for the buyer's paying PREPARE before giving up on an increment. Default 120s. */
  paymentTimeoutMs?: number;
}

const DEFAULT_PAYMENT_TIMEOUT_MS = 120_000;

export class ClientJobDeliveryPort implements JobDeliveryPort {
  private readonly paymentTimeoutMs: number;
  private staged?: { key: Uint8Array; conditionHex: string };
  private armed?: ArmedIncrement;

  constructor(options: ClientJobDeliveryPortOptions = {}) {
    this.paymentTimeoutMs =
      options.paymentTimeoutMs ?? DEFAULT_PAYMENT_TIMEOUT_MS;
  }

  /**
   * The `JobHandler` to register as `ToonClientConfig.jobHandler`. Throws
   * (answered F99 by `createJobMessageHandler`) when no increment is armed
   * for the PREPARE's `executionCondition`, or when the PREPARE's `amount`
   * is below the armed increment's advertised price (#87 — the condition is
   * public, published on the kind:7000 offer, so anyone can send a PREPARE
   * carrying it; only a PREPARE that actually pays the armed price may
   * release the key). An underpaying PREPARE is rejected without consuming
   * the arming, so a correctly-priced PREPARE can still land before the
   * payment timeout. This is the only path that releases a key, and it
   * releases exactly the one the buyer paid for.
   */
  readonly handleJob: JobHandler = (job: JobRequest): JobAnswer => {
    const conditionHex = toHex(job.executionCondition);
    if (!this.armed || conditionHex !== this.armed.conditionHex) {
      throw new Error(
        `no factory-job increment is awaiting payment for condition ${conditionHex}`
      );
    }
    if (job.amount < BigInt(this.armed.priceUsdc)) {
      throw new Error(
        `PREPARE amount ${job.amount} is below the armed price ${this.armed.priceUsdc} for condition ${conditionHex}`
      );
    }
    const { key, resolve } = this.armed;
    this.armed = undefined;
    resolve(true);
    return { fulfillment: fulfillIncrement(key) };
  };

  async encryptArtifact(bytes: Uint8Array): Promise<EncryptedArtifact> {
    const encrypted = clientEncryptArtifact(bytes);
    const conditionHex = toHex(encrypted.condition);
    this.staged = { key: encrypted.key, conditionHex };
    return {
      ciphertext: encrypted.ciphertext,
      ciphertextSha256: createHash('sha256')
        .update(encrypted.ciphertext)
        .digest('hex'),
      conditionHex,
    };
  }

  async waitForPayment(offer: OfferedIncrement): Promise<boolean> {
    if (!this.staged || offer.conditionHex !== this.staged.conditionHex) {
      throw new Error(
        'waitForPayment was called for a condition that does not match the most recent encryptArtifact() call'
      );
    }
    const { key, conditionHex } = this.staged;
    const { priceUsdc } = offer;
    this.staged = undefined;

    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.armed = undefined;
        resolve(false);
      }, this.paymentTimeoutMs);
      this.armed = {
        key,
        conditionHex,
        priceUsdc,
        resolve: (paid) => {
          clearTimeout(timer);
          resolve(paid);
        },
      };
    });
  }
}
