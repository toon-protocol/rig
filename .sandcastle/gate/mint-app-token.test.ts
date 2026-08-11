// Placed under .sandcastle/gate/ (not .sandcastle/) so it is picked up by
// ci.yml's `.sandcastle/gate/*.test.ts` glob -- a file at
// .sandcastle/mint-app-token.test.ts would be collected by nothing.
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createVerify } from 'node:crypto';
import { appJwt, mintAppToken } from '../mint-app-token.ts';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();

function decodeSegment(segment: string): unknown {
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
}

describe('appJwt', () => {
  it('produces a three-segment RS256 JWT with the App claims', () => {
    const jwt = appJwt('123456', pem);
    const [headerSeg, payloadSeg, signatureSeg] = jwt.split('.');
    assert.ok(headerSeg && payloadSeg && signatureSeg);

    assert.deepEqual(decodeSegment(headerSeg), { alg: 'RS256', typ: 'JWT' });

    const payload = decodeSegment(payloadSeg) as { iss: string; iat: number; exp: number };
    assert.equal(payload.iss, '123456');
    // iat is backdated ~60s for clock skew and exp is 9 minutes ahead of
    // `now`, so the claimed iat..exp span is exactly 10 minutes while the
    // token's remaining life stays under GitHub's 10-minute cap.
    const now = Math.floor(Date.now() / 1000);
    assert.ok(payload.iat <= now - 55 && payload.iat >= now - 65);
    assert.equal(payload.exp - payload.iat, 10 * 60);
    assert.ok(payload.exp - now < 10 * 60);
  });

  it('signs a verifiable RS256 signature over header.payload', () => {
    const jwt = appJwt('123456', pem);
    const [headerSeg, payloadSeg, signatureSeg] = jwt.split('.');
    const verifier = createVerify('RSA-SHA256');
    verifier.update(`${headerSeg}.${payloadSeg}`);
    assert.equal(
      verifier.verify(publicKey, Buffer.from(signatureSeg!, 'base64url')),
      true,
    );
  });

  it('accepts a PEM with literal \\n (a mis-round-tripped secret) same as a real newline PEM', () => {
    const escaped = pem.replace(/\n/g, '\\n');
    const jwt = appJwt('123456', escaped);
    const [headerSeg, payloadSeg, signatureSeg] = jwt.split('.');
    const verifier = createVerify('RSA-SHA256');
    verifier.update(`${headerSeg}.${payloadSeg}`);
    assert.equal(
      verifier.verify(publicKey, Buffer.from(signatureSeg!, 'base64url')),
      true,
    );
  });
});

describe('mintAppToken', () => {
  const savedEnv = {
    APP_ID: process.env.APP_ID,
    APP_PRIVATE_KEY: process.env.APP_PRIVATE_KEY,
    GH_TOKEN: process.env.GH_TOKEN,
  };

  beforeEach(() => {
    delete process.env.APP_ID;
    delete process.env.APP_PRIVATE_KEY;
    delete process.env.GH_TOKEN;
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('falls back to the ambient GH_TOKEN when APP_ID/APP_PRIVATE_KEY are absent', async () => {
    process.env.GH_TOKEN = 'ghs_ambienttoken';
    const result = await mintAppToken();
    assert.deepEqual(result, { token: 'ghs_ambienttoken', source: 'ambient' });
  });

  it('throws when neither the App credentials nor GH_TOKEN are available', async () => {
    await assert.rejects(
      () => mintAppToken(),
      /Cannot obtain a GitHub credential/,
    );
  });
});
