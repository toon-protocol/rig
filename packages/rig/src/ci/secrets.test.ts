/**
 * Repository Secret Update payload tests (rig#125): NIP-44 v2 round trip
 * with real keys, the plaintext shape/limit rules from docs/specs/nip-c1.md,
 * the author/created_at bindings, and per-name total ordering when updates
 * arrive out of order.
 */

import { describe, it, expect } from 'vitest';
import { getPublicKey } from 'nostr-tools/pure';
import {
  RESERVED_SECRET_NAMES,
  SECRET_NAME_RE,
  applySecretUpdate,
  decryptSecretUpdate,
  effectiveSecrets,
  encryptSecretUpdate,
  generateSecretsKey,
  validateSecretUpdate,
  type SecretInventory,
  type SecretUpdatePlaintext,
} from './secrets.js';

const MAINTAINER = 'ab'.repeat(32);
const NOW = 1_800_000_000;

const PLAIN: SecretUpdatePlaintext = {
  author: MAINTAINER,
  created_at: NOW,
  set: { DEPLOY_TOKEN: 'value', NPM_TOKEN: 'npm_x' },
  remove: ['OLD_TOKEN'],
};

describe('NIP-44 v2 round trip', () => {
  it('encrypts with a fresh sender key and decrypts with the recipient secret key', () => {
    const recipient = generateSecretsKey();
    expect(recipient.pubkey).toBe(getPublicKey(recipient.secretKey));
    const sender = generateSecretsKey();

    const ciphertext = encryptSecretUpdate(PLAIN, sender.secretKey, recipient.pubkey);
    expect(ciphertext).not.toContain('DEPLOY_TOKEN');
    expect(ciphertext).not.toContain('value');

    expect(decryptSecretUpdate(ciphertext, recipient.secretKey, sender.pubkey)).toEqual(
      PLAIN
    );
  });

  it('fails with a mismatched sender pubkey or the wrong recipient key', () => {
    const recipient = generateSecretsKey();
    const sender = generateSecretsKey();
    const other = generateSecretsKey();
    const ciphertext = encryptSecretUpdate(PLAIN, sender.secretKey, recipient.pubkey);
    expect(() =>
      decryptSecretUpdate(ciphertext, recipient.secretKey, other.pubkey)
    ).toThrow();
    expect(() =>
      decryptSecretUpdate(ciphertext, other.secretKey, sender.pubkey)
    ).toThrow();
  });

  it('refuses ciphertext over 100 KiB before attempting to decrypt', () => {
    const recipient = generateSecretsKey();
    expect(() =>
      decryptSecretUpdate('A'.repeat(100 * 1024 + 1), recipient.secretKey, 'ab'.repeat(32))
    ).toThrow(/100 KiB/);
  });

  it('generates a distinct key every call', () => {
    expect(generateSecretsKey().pubkey).not.toBe(generateSecretsKey().pubkey);
  });
});

describe('plaintext validation', () => {
  it('pins the name grammar and the reserved bunker name', () => {
    expect(SECRET_NAME_RE.test('DEPLOY_TOKEN')).toBe(true);
    expect(SECRET_NAME_RE.test('_X1')).toBe(true);
    expect(SECRET_NAME_RE.test('1BAD')).toBe(false);
    expect(SECRET_NAME_RE.test('lower')).toBe(false);
    expect(RESERVED_SECRET_NAMES).toContain('WORKFLOW_SECRETS_DECRYPTION_BUNKER');
  });

  function roundTrip(plain: unknown): SecretUpdatePlaintext {
    const recipient = generateSecretsKey();
    const sender = generateSecretsKey();
    const ciphertext = encryptSecretUpdate(
      plain as SecretUpdatePlaintext,
      sender.secretKey,
      recipient.pubkey
    );
    return decryptSecretUpdate(ciphertext, recipient.secretKey, sender.pubkey);
  }

  it('rejects extra or missing keys, both set and remove empty, a name in both, bad names, reserved names', () => {
    expect(() => roundTrip({ ...PLAIN, extra: 1 })).toThrow(/exactly/);
    expect(() => roundTrip({ author: MAINTAINER, created_at: NOW, set: {} })).toThrow(
      /exactly/
    );
    expect(() => roundTrip({ ...PLAIN, set: {}, remove: [] })).toThrow(/non-empty/);
    expect(() =>
      roundTrip({ ...PLAIN, set: { A: '1' }, remove: ['A'] })
    ).toThrow(/both/);
    expect(() => roundTrip({ ...PLAIN, set: { bad: '1' }, remove: [] })).toThrow(
      /name/
    );
    expect(() =>
      roundTrip({ ...PLAIN, set: { WORKFLOW_SECRETS_DECRYPTION_BUNKER: 'x' }, remove: [] })
    ).toThrow(/reserved/);
  });

  it('rejects an empty value, a value over 16384 bytes, more than 100 names, or plaintext over 65535 bytes', () => {
    expect(() => roundTrip({ ...PLAIN, set: { A: '' }, remove: [] })).toThrow(
      /empty/
    );
    expect(() =>
      roundTrip({ ...PLAIN, set: { A: 'x'.repeat(16385) }, remove: [] })
    ).toThrow(/16384/);
    const many: Record<string, string> = {};
    for (let i = 0; i < 101; i++) many[`N${i}`] = 'v';
    expect(() => roundTrip({ ...PLAIN, set: many, remove: [] })).toThrow(/100/);
    const big: Record<string, string> = {};
    for (let i = 0; i < 5; i++) big[`B${i}`] = 'x'.repeat(16000);
    expect(() => roundTrip({ ...PLAIN, set: big, remove: [] })).toThrow(/65535/);
  });

  it('validateSecretUpdate binds author and created_at to the outer event', () => {
    expect(() =>
      validateSecretUpdate(PLAIN, { pubkey: MAINTAINER, created_at: NOW })
    ).not.toThrow();
    expect(() =>
      validateSecretUpdate(PLAIN, { pubkey: MAINTAINER.toUpperCase(), created_at: NOW })
    ).not.toThrow();
    expect(() =>
      validateSecretUpdate(PLAIN, { pubkey: 'cd'.repeat(32), created_at: NOW })
    ).toThrow(/author/);
    expect(() =>
      validateSecretUpdate(PLAIN, { pubkey: MAINTAINER, created_at: NOW + 1 })
    ).toThrow(/created_at/);
  });
});

describe('inventory ordering', () => {
  const ID_A = 'aa'.repeat(32);
  const ID_B = 'bb'.repeat(32);
  const ID_0 = '00'.repeat(32);

  it('applies set and remove, returning a new inventory (input untouched)', () => {
    const inv: SecretInventory = {};
    const next = applySecretUpdate(inv, PLAIN, ID_A);
    expect(inv).toEqual({});
    expect(next).toEqual({
      DEPLOY_TOKEN: { value: 'value', createdAt: NOW, eventId: ID_A, origin: MAINTAINER },
      NPM_TOKEN: { value: 'npm_x', createdAt: NOW, eventId: ID_A, origin: MAINTAINER },
      OLD_TOKEN: { value: null, createdAt: NOW, eventId: ID_A, origin: MAINTAINER },
    });
    expect(effectiveSecrets(next)).toEqual({ DEPLOY_TOKEN: 'value', NPM_TOKEN: 'npm_x' });
  });

  it('an older set cannot resurrect a value removed later (tombstone wins)', () => {
    let inv: SecretInventory = {};
    inv = applySecretUpdate(
      inv,
      { author: MAINTAINER, created_at: NOW + 10, set: {}, remove: ['DEPLOY_TOKEN'] },
      ID_B
    );
    inv = applySecretUpdate(inv, PLAIN, ID_A); // created_at NOW < NOW + 10
    expect(inv['DEPLOY_TOKEN']?.value).toBeNull();
    expect(inv['NPM_TOKEN']?.value).toBe('npm_x'); // untouched name still applies
  });

  it('equal timestamps: the lexicographically lower id is later and wins', () => {
    let inv: SecretInventory = {};
    inv = applySecretUpdate(
      inv,
      { author: MAINTAINER, created_at: NOW, set: { A: 'from-ff' }, remove: [] },
      'ff'.repeat(32)
    );
    inv = applySecretUpdate(
      inv,
      { author: MAINTAINER, created_at: NOW, set: { A: 'from-00' }, remove: [] },
      ID_0
    );
    expect(inv['A']?.value).toBe('from-00');
    // Replaying the ff event again does not clobber the later 00 value.
    inv = applySecretUpdate(
      inv,
      { author: MAINTAINER, created_at: NOW, set: { A: 'from-ff' }, remove: [] },
      'ff'.repeat(32)
    );
    expect(inv['A']?.value).toBe('from-00');
  });
});
