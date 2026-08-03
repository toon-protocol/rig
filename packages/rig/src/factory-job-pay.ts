/**
 * Buyer-side payment for one factory-job increment offer (#56) — the other
 * half of the hashlock join `ClientJobDeliveryPort` (the provider side)
 * answers. Built against `@toon-protocol/client`'s real `buildIncrementPrepare`
 * / `decryptArtifact` (toon-client#495): this module does not re-derive the
 * PREPARE fields or the AEAD decrypt itself.
 *
 * Per docs/factory-job-protocol.md §4.2 (toon-meta), paying an offer is:
 * `executionCondition` equal to the offer's `condition` tag byte for byte,
 * and `data` carrying a reference back to the offer's own kind:7000 event id
 * — "the payment names the job." The provider returns the decryption key as
 * the ILP fulfillment; revealing it is the same act as accepting payment.
 */

import {
  buildIncrementPrepare,
  decryptArtifact,
  type IncrementOfferTags,
} from '@toon-protocol/client';

/** What a buyer reads off an advertised kind:7000 `status:"partial"` increment offer. */
export interface PayableIncrementOffer extends IncrementOfferTags {
  /** The offer event's own id — carried in the PREPARE's `data` field (§4.2). */
  offerEventId: string;
}

/** The outcome of paying one increment offer. */
export type PaidIncrementOffer =
  | { paid: true; key: Uint8Array }
  | { paid: false };

/** The narrow slice of `ToonClient` a buyer needs to pay an increment offer. */
export interface SwapPacketSender {
  sendSwapPacket(params: {
    destination: string;
    amount: bigint;
    toonData: Uint8Array;
    executionCondition?: Uint8Array;
    timeout?: number;
  }): Promise<{
    accepted: boolean;
    fulfillment?: string;
    code?: string;
    message?: string;
  }>;
}

/**
 * Buyer: pay one advertised increment offer. Sends an ILP PREPARE addressed
 * to `providerDestination` with `executionCondition` equal to the offer's
 * `condition` tag and `data` referencing the offer's event id, per §4.2.
 * Resolves `{ paid: false }` on a REJECT (expired/no such increment/wrong
 * fulfillment) rather than throwing — a buyer declining or failing to pay is
 * a protocol outcome (`abandoned-buyer`), not an error.
 */
export async function payIncrementOffer(
  client: SwapPacketSender,
  providerDestination: string,
  offer: PayableIncrementOffer
): Promise<PaidIncrementOffer> {
  const { executionCondition, amount } = buildIncrementPrepare(offer);
  const result = await client.sendSwapPacket({
    destination: providerDestination,
    amount,
    toonData: new TextEncoder().encode(offer.offerEventId),
    executionCondition,
  });
  if (!result.accepted || !result.fulfillment) {
    return { paid: false };
  }
  return { paid: true, key: Buffer.from(result.fulfillment, 'base64') };
}

/**
 * Buyer: decrypt an increment's artifact using the key revealed as the ILP
 * fulfillment. `offerConditionHex` MUST be the offer's own `condition` tag
 * as read from the relay before payment — never re-derived from `key` —
 * so a provider who reveals a different key than it advertised is caught
 * here rather than trusted.
 */
export function decryptIncrementArtifact(
  ciphertext: Uint8Array,
  key: Uint8Array,
  offerConditionHex: string
): Uint8Array {
  return decryptArtifact(
    ciphertext,
    key,
    Buffer.from(offerConditionHex, 'hex')
  );
}
