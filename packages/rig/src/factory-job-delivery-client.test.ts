import { describe, expect, it } from 'vitest';
import {
  decryptArtifact,
  fulfillmentMatchesCondition,
  type JobRequest,
} from '@toon-protocol/client';
import { ClientJobDeliveryPort } from './factory-job-delivery-client.js';

function jobRequestFor(conditionHex: string): JobRequest {
  return {
    amount: 1_000_000n,
    destination: 'g.toon.provider',
    executionCondition: Buffer.from(conditionHex, 'hex'),
    expiresAt: new Date(Date.now() + 30_000),
    data: new Uint8Array(),
  };
}

describe('ClientJobDeliveryPort', () => {
  it('encrypts an artifact, then reveals a fulfillment that decrypts it once the matching job PREPARE arrives', async () => {
    const port = new ClientJobDeliveryPort();
    const plaintext = new TextEncoder().encode('the plan');

    const encrypted = await port.encryptArtifact(plaintext);
    const paid = port.waitForPayment({
      offerEventId: 'event1',
      conditionHex: encrypted.conditionHex,
      priceUsdc: '500000',
    });

    const answer = port.handleJob(jobRequestFor(encrypted.conditionHex));
    const settled =
      answer instanceof Promise ? await answer : answer;

    expect(await paid).toBe(true);
    expect(
      fulfillmentMatchesCondition(
        settled.fulfillment,
        Buffer.from(encrypted.conditionHex, 'hex')
      )
    ).toBe(true);
    expect(
      decryptArtifact(
        encrypted.ciphertext,
        settled.fulfillment,
        Buffer.from(encrypted.conditionHex, 'hex')
      )
    ).toEqual(plaintext);
  });

  it('never reuses a key/condition across increments', async () => {
    const port = new ClientJobDeliveryPort();
    const a = await port.encryptArtifact(new TextEncoder().encode('increment 1'));
    const b = await port.encryptArtifact(new TextEncoder().encode('increment 2'));
    expect(a.conditionHex).not.toBe(b.conditionHex);
  });

  it('refuses a job PREPARE for a condition no increment is awaiting payment for', async () => {
    const port = new ClientJobDeliveryPort();
    expect(() => port.handleJob(jobRequestFor('ab'.repeat(32)))).toThrow(
      /no factory-job increment is awaiting payment/
    );
  });

  it('refuses a stray job PREPARE that does not match the currently armed increment', async () => {
    const port = new ClientJobDeliveryPort();
    const encrypted = await port.encryptArtifact(new TextEncoder().encode('work'));
    const paid = port.waitForPayment({
      offerEventId: 'event1',
      conditionHex: encrypted.conditionHex,
      priceUsdc: '500000',
    });

    expect(() => port.handleJob(jobRequestFor('cd'.repeat(32)))).toThrow(
      /no factory-job increment is awaiting payment/
    );

    // The mismatched PREPARE must not have resolved (let alone paid) the
    // increment actually awaiting payment.
    const port2 = new ClientJobDeliveryPort({ paymentTimeoutMs: 10 });
    const encrypted2 = await port2.encryptArtifact(
      new TextEncoder().encode('work2')
    );
    const timedOut = await port2.waitForPayment({
      offerEventId: 'event2',
      conditionHex: encrypted2.conditionHex,
      priceUsdc: '500000',
    });
    expect(timedOut).toBe(false);

    // The first port's increment is still armed and can still be paid.
    port.handleJob(jobRequestFor(encrypted.conditionHex));
    expect(await paid).toBe(true);
  });

  it('resolves false if no matching job PREPARE arrives before the payment timeout', async () => {
    const port = new ClientJobDeliveryPort({ paymentTimeoutMs: 10 });
    const encrypted = await port.encryptArtifact(new TextEncoder().encode('work'));
    const paid = await port.waitForPayment({
      offerEventId: 'event1',
      conditionHex: encrypted.conditionHex,
      priceUsdc: '500000',
    });
    expect(paid).toBe(false);
  });

  it('throws when waitForPayment is called for a condition that does not match the last encryptArtifact() call', async () => {
    const port = new ClientJobDeliveryPort();
    await port.encryptArtifact(new TextEncoder().encode('work'));
    await expect(
      port.waitForPayment({
        offerEventId: 'event1',
        conditionHex: 'ef'.repeat(32),
        priceUsdc: '500000',
      })
    ).rejects.toThrow(/does not match the most recent encryptArtifact/);
  });
});
