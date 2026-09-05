/**
 * The Nostr signing key rig derives from a BIP-39 phrase.
 *
 * `@toon-protocol/client` 2.x is a pure payer and carries no Nostr identity
 * (its own words), so the derivation that lived in the 0.x client moves here,
 * unchanged: `m/44'/1237'/0'/0/<accountIndex>`. Unchanged matters — this is
 * the key every existing rig repo is owned by (`toon.owner`, the kind:30617
 * author), and it is also the secp256k1 key the client reads a phrase's EVM
 * account from under `keyDerivation: 'legacy'`, so one phrase still yields one
 * author AND the wallet its channels were funded at.
 */

import { HDKey } from '@scure/bip32';
import { mnemonicToSeedSync } from '@scure/bip39';
import { getPublicKey } from 'nostr-tools/pure';

/** A BIP-32 non-hardened child index fits in 31 bits. */
export const MAX_ACCOUNT_INDEX = 0x7fffffff;

/** The path rig has always derived its Nostr key at. */
export function nostrDerivationPath(accountIndex = 0): string {
  return `m/44'/1237'/0'/0/${String(accountIndex)}`;
}

export interface NostrKey {
  /** 32-byte secp256k1 secret. */
  secretKey: Uint8Array;
  /** 32-byte x-only public key, hex. */
  pubkey: string;
}

/**
 * Derive the Nostr key of a phrase at an account index.
 *
 * @throws when the index is out of range or the phrase yields no key.
 */
export function deriveNostrKeyFromMnemonic(
  mnemonic: string,
  accountIndex = 0
): NostrKey {
  if (
    !Number.isInteger(accountIndex) ||
    accountIndex < 0 ||
    accountIndex > MAX_ACCOUNT_INDEX
  ) {
    throw new Error(
      `account index must be an integer in [0, ${String(MAX_ACCOUNT_INDEX)}]; got ${String(accountIndex)}`
    );
  }
  const seed = mnemonicToSeedSync(mnemonic.trim());
  try {
    const child = HDKey.fromMasterSeed(seed).derive(
      nostrDerivationPath(accountIndex)
    );
    if (!child.privateKey) {
      throw new Error('failed to derive a Nostr private key from the seed');
    }
    const secretKey = new Uint8Array(child.privateKey);
    return { secretKey, pubkey: getPublicKey(secretKey) };
  } finally {
    seed.fill(0);
  }
}
