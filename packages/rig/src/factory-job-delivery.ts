/**
 * JobDeliveryPort — the paid-increment seam for `executeFactoryJob` (#52).
 * The upload and event-publish legs reuse the EXISTING `Publisher`
 * (publisher.ts — `uploadBlob` for the ciphertext, `publishEvent` for the
 * quote/offer/result events); this port covers only what `Publisher` can't:
 * the job-specific crypto (encrypt-under-a-fresh-key → condition) and
 * waiting for the increment's payment to settle.
 *
 * Per decision 5 of toon-meta#262 and §4.2 of `docs/factory-job-protocol.md`,
 * delivering an increment is: encrypt the artifact with a fresh key, upload
 * the ciphertext, publish `condition = sha256(key)`, then wait for an ILP
 * PREPARE whose `executionCondition` matches — releasing `key` as the
 * FULFILL preimage is simultaneously payment settling and key handoff.
 * `@toon-protocol/client` 0.25.1 (the latest published version as of this
 * ticket) does not yet export the earning-API/hashlock helpers merged to
 * its `main` branch today (toon-client#496, toon-client#498) — this
 * interface is the injection point a follow-up ticket wires a real
 * implementation into once a release carries them. Do not re-derive the
 * encrypt/condition logic locally in an implementation of this port — use
 * `@toon-protocol/client`'s `encryptArtifact`/`fulfillIncrement` once
 * available, per the issue's explicit instruction not to hand-roll it.
 */

/** A freshly-encrypted increment artifact, ready to upload. */
export interface EncryptedArtifact {
  /** The encrypted bytes — upload this, never the plaintext. */
  ciphertext: Uint8Array;
  /** sha256 of `ciphertext`, hex — lets the buyer detect a bad fetch. */
  ciphertextSha256: string;
  /** `sha256(key)` hex, where `key` decrypts the artifact (§4.2 — the join). */
  conditionHex: string;
}

/** One increment offered for payment — what {@link JobDeliveryPort.waitForPayment} waits on. */
export interface OfferedIncrement {
  /** The kind:7000 status:"partial" event id this offer was published as. */
  offerEventId: string;
  /** Must equal the offer's `condition` tag, byte for byte (§4.2). */
  conditionHex: string;
  priceUsdc: string;
}

/**
 * Injected transport for `executeFactoryJob` — implemented against
 * `@toon-protocol/client`'s earning API in a follow-up ticket. Must be safe
 * to call sequentially (increments are delivered and paid for one at a
 * time, never in parallel) and should throw on a provider-side failure —
 * `executeFactoryJob` does not retry an increment.
 */
export interface JobDeliveryPort {
  /**
   * Encrypt `bytes` under a fresh, single-use key and return the
   * ciphertext plus `condition = sha256(key)`. Per the issue's gotchas:
   * NEVER reuse a key across increments — paying for the plan must not
   * unlock the implementation.
   */
  encryptArtifact(bytes: Uint8Array): Promise<EncryptedArtifact>;
  /**
   * Wait for the buyer's ILP PREPARE against `offer.conditionHex` to
   * settle. Resolves `true` once the FULFILL is released (the increment is
   * paid); resolves `false` if the buyer never pays (implementation-defined
   * timeout/backoff) — `executeFactoryJob` treats `false` as the signal to
   * halt (decision 6: one unpaid increment and work stops).
   */
  waitForPayment(offer: OfferedIncrement): Promise<boolean>;
}
