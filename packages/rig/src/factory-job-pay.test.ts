import { describe, expect, it } from 'vitest';
import { ClientJobDeliveryPort } from './factory-job-delivery-client.js';
import {
  decryptIncrementArtifact,
  payIncrementOffer,
  type SwapPacketSender,
} from './factory-job-pay.js';

/**
 * A fake connector that forwards a paying PREPARE straight to the
 * provider's `JobHandler`, the way a real connector's server-originated
 * BTP MESSAGE (toon-client#493/#494) would.
 */
function connectorRoutingTo(port: ClientJobDeliveryPort): SwapPacketSender {
  return {
    async sendSwapPacket(params) {
      try {
        const answer = await port.handleJob({
          amount: params.amount,
          destination: params.destination,
          executionCondition: params.executionCondition ?? new Uint8Array(32),
          expiresAt: new Date(Date.now() + 30_000),
          data: params.toonData,
        });
        return {
          accepted: true,
          fulfillment: Buffer.from(answer.fulfillment).toString('base64'),
        };
      } catch (err) {
        return {
          accepted: false,
          code: 'F99',
          message: (err as Error).message,
        };
      }
    },
  };
}

describe('payIncrementOffer / decryptIncrementArtifact', () => {
  it('pays a real ClientJobDeliveryPort increment offer and decrypts the artifact with the revealed key', async () => {
    const port = new ClientJobDeliveryPort();
    const plaintext = new TextEncoder().encode('the plan');
    const encrypted = await port.encryptArtifact(plaintext);
    const waitForPayment = port.waitForPayment({
      offerEventId: 'offer1',
      conditionHex: encrypted.conditionHex,
      priceUsdc: '500000',
    });

    const connector = connectorRoutingTo(port);
    const result = await payIncrementOffer(connector, 'g.toon.provider', {
      offerEventId: 'offer1',
      conditionHex: encrypted.conditionHex,
      amountUsdc: '500000',
    });

    expect(await waitForPayment).toBe(true);
    expect(result.paid).toBe(true);
    if (!result.paid) throw new Error('unreachable');
    expect(
      decryptIncrementArtifact(
        encrypted.ciphertext,
        result.key,
        encrypted.conditionHex
      )
    ).toEqual(plaintext);
  });

  it('resolves paid:false when the connector rejects the PREPARE', async () => {
    const rejecting: SwapPacketSender = {
      async sendSwapPacket() {
        return { accepted: false, code: 'F99', message: 'no such increment' };
      },
    };
    const result = await payIncrementOffer(rejecting, 'g.toon.provider', {
      offerEventId: 'offer1',
      conditionHex: 'ab'.repeat(32),
      amountUsdc: '500000',
    });
    expect(result.paid).toBe(false);
  });

  it('sends the offer event id as the PREPARE data, and the offer condition byte for byte as executionCondition (§4.2)', async () => {
    let seen:
      | {
          destination: string;
          amount: bigint;
          toonData: Uint8Array;
          executionCondition?: Uint8Array;
        }
      | undefined;
    const spy: SwapPacketSender = {
      async sendSwapPacket(params) {
        seen = params;
        return { accepted: false };
      },
    };
    await payIncrementOffer(spy, 'g.toon.provider', {
      offerEventId: 'offer-event-id-123',
      conditionHex: 'cd'.repeat(32),
      amountUsdc: '500000',
    });
    expect(seen?.destination).toBe('g.toon.provider');
    expect(new TextDecoder().decode(seen?.toonData)).toBe(
      'offer-event-id-123'
    );
    expect(Buffer.from(seen?.executionCondition ?? []).toString('hex')).toBe(
      'cd'.repeat(32)
    );
    expect(seen?.amount).toBe(500000n);
  });
});
