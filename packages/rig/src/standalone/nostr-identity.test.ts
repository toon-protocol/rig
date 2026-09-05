import { describe, expect, it } from 'vitest';
import {
  MAX_ACCOUNT_INDEX,
  deriveNostrKeyFromMnemonic,
  nostrDerivationPath,
} from './nostr-identity.js';

// NIP-06's published vector: this phrase at m/44'/1237'/0'/0/0 — the same
// path rig has always used for account 0 — yields this pubkey. Pinning it
// pins every existing repo owner across the client 0.x → 2.x move.
const NIP06_PHRASE =
  'leader monkey parrot ring guide accident before fence cannon height naive bean';
const NIP06_PUBKEY =
  '17162c921dc4d2518f9a101db33695df1afb56ab82f5ff3e5da6eec3ca5cd917';

describe('deriveNostrKeyFromMnemonic', () => {
  it('derives the NIP-06 vector at account 0', () => {
    const key = deriveNostrKeyFromMnemonic(NIP06_PHRASE);
    expect(key.pubkey).toBe(NIP06_PUBKEY);
    expect(key.secretKey).toHaveLength(32);
  });

  it('trims the phrase and treats account 0 as the default', () => {
    expect(deriveNostrKeyFromMnemonic(`  ${NIP06_PHRASE}\n`, 0).pubkey).toBe(
      NIP06_PUBKEY
    );
  });

  it('a different account index is a different key on the legacy path', () => {
    expect(nostrDerivationPath(7)).toBe("m/44'/1237'/0'/0/7");
    expect(deriveNostrKeyFromMnemonic(NIP06_PHRASE, 1).pubkey).not.toBe(
      NIP06_PUBKEY
    );
  });

  it('refuses an index outside the non-hardened range', () => {
    expect(() => deriveNostrKeyFromMnemonic(NIP06_PHRASE, -1)).toThrow(
      /account index/
    );
    expect(() =>
      deriveNostrKeyFromMnemonic(NIP06_PHRASE, MAX_ACCOUNT_INDEX + 1)
    ).toThrow(/account index/);
    expect(() => deriveNostrKeyFromMnemonic(NIP06_PHRASE, 1.5)).toThrow(
      /account index/
    );
  });
});
