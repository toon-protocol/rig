/**
 * Repository Secret Update payloads (rig#125): the NIP-44 v2 ciphertext a
 * kind:29846 carries, its plaintext rules, and the per-name ordering that
 * turns a stream of updates into the coordinator's secret inventory.
 * docs/specs/nip-c1.md "Repository Secret Update" is the contract.
 *
 * The maintainer signs the OUTER event with their identity but encrypts
 * with a FRESH per-submission sender key to the coordinator's advertised
 * `secrets-key` (a short-lived transport key, never the coordinator's
 * signing key). The plaintext repeats only two bindings — `author` and
 * `created_at` — so captured ciphertext cannot be re-signed into another
 * maintainer's authority or moved to a newer ordering position; the rest is
 * authenticated by the outer signature and not duplicated.
 *
 * The inventory keeps a value-or-tombstone per name with the update's
 * `(created_at, event id)` so that out-of-order or duplicate relay delivery
 * can never resurrect an older value (a remove is an ordering tombstone).
 * rig persists this inventory under the coordinator's state dir (slice 4);
 * the bunker-sealed storage mode NIP-C1 defines is out of scope.
 */

import { v2 as nip44 } from 'nostr-tools/nip44';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { controlOrder } from './nip-c1-events.js';

export const SECRET_NAME_RE = /^[A-Z_][A-Z0-9_]*$/;
/** Names a coordinator never injects into jobs (NIP-C1 reserved). */
export const RESERVED_SECRET_NAMES: readonly string[] = [
  'WORKFLOW_SECRETS_DECRYPTION_BUNKER',
];

export const MAX_SECRET_NAMES = 100;
export const MAX_SECRET_VALUE_BYTES = 16_384;
export const MAX_SECRET_PLAINTEXT_BYTES = 65_535;
export const MAX_SECRET_CIPHERTEXT_BYTES = 100 * 1024;

export interface SecretUpdatePlaintext {
  author: string;
  created_at: number;
  set: Record<string, string>;
  remove: string[];
}

const HEX64 = /^[0-9a-f]{64}$/i;

function utf8Bytes(s: string): number {
  return Buffer.byteLength(s, 'utf-8');
}

function assertName(name: string): void {
  if (!SECRET_NAME_RE.test(name)) {
    throw new Error(`invalid secret name ${JSON.stringify(name)}`);
  }
  if (RESERVED_SECRET_NAMES.includes(name)) {
    throw new Error(`secret name ${name} is reserved`);
  }
}

/**
 * Validate the plaintext SHAPE + limits (not the outer bindings — see
 * {@link validateSecretUpdate}). Throws on any violation; returns the
 * narrowed value.
 */
export function assertSecretUpdateShape(value: unknown): SecretUpdatePlaintext {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('secret update plaintext must be a JSON object');
  }
  const keys = Object.keys(value).sort();
  if (keys.join(',') !== 'author,created_at,remove,set') {
    throw new Error(
      'secret update plaintext must contain exactly author, created_at, set, and remove'
    );
  }
  const { author, created_at, set, remove } = value as Record<string, unknown>;
  if (typeof author !== 'string' || !HEX64.test(author)) {
    throw new Error('secret update author must be a 64-hex pubkey');
  }
  if (typeof created_at !== 'number' || !Number.isInteger(created_at)) {
    throw new Error('secret update created_at must be an integer');
  }
  if (set === null || typeof set !== 'object' || Array.isArray(set)) {
    throw new Error('secret update set must be an object');
  }
  if (!Array.isArray(remove) || !remove.every((n) => typeof n === 'string')) {
    throw new Error('secret update remove must be an array of names');
  }
  const setNames = Object.keys(set as Record<string, unknown>);
  const removeNames = remove as string[];
  if (setNames.length === 0 && removeNames.length === 0) {
    throw new Error('secret update needs a non-empty set or remove');
  }
  if (setNames.length + removeNames.length > MAX_SECRET_NAMES) {
    throw new Error(
      `secret update may name at most ${MAX_SECRET_NAMES} secrets`
    );
  }
  for (const name of [...setNames, ...removeNames]) assertName(name);
  const removeSet = new Set(removeNames);
  if (removeSet.size !== removeNames.length) {
    throw new Error('secret update remove lists a name twice');
  }
  for (const name of setNames) {
    if (removeSet.has(name)) {
      throw new Error(`secret ${name} appears in both set and remove`);
    }
    const v = (set as Record<string, unknown>)[name];
    if (typeof v !== 'string' || v === '') {
      throw new Error(`secret ${name} value must be a non-empty string`);
    }
    if (utf8Bytes(v) > MAX_SECRET_VALUE_BYTES) {
      throw new Error(
        `secret ${name} value exceeds ${MAX_SECRET_VALUE_BYTES} bytes`
      );
    }
  }
  return {
    author: author.toLowerCase(),
    created_at,
    set: set as Record<string, string>,
    remove: removeNames,
  };
}

/** Bind a decrypted plaintext to its outer event: author + created_at MUST match. */
export function validateSecretUpdate(
  plain: SecretUpdatePlaintext,
  outer: { pubkey: string; created_at: number }
): void {
  if (plain.author.toLowerCase() !== outer.pubkey.toLowerCase()) {
    throw new Error('secret update author does not match the signing pubkey');
  }
  if (plain.created_at !== outer.created_at) {
    throw new Error(
      'secret update created_at does not match the event timestamp'
    );
  }
}

/** Encrypt one update (NIP-44 v2) from a fresh sender key to the advertised recipient. */
export function encryptSecretUpdate(
  plain: SecretUpdatePlaintext,
  senderSecretKey: Uint8Array,
  recipientPubkey: string
): string {
  const checked = assertSecretUpdateShape(plain);
  const json = JSON.stringify(checked);
  if (utf8Bytes(json) > MAX_SECRET_PLAINTEXT_BYTES) {
    throw new Error(
      `secret update plaintext exceeds ${MAX_SECRET_PLAINTEXT_BYTES} bytes`
    );
  }
  const key = nip44.utils.getConversationKey(senderSecretKey, recipientPubkey);
  return nip44.encrypt(json, key);
}

/**
 * Decrypt + validate one update with the recipient (secrets-key) secret key
 * and the event's `sender` pubkey. Bounds the ciphertext BEFORE decrypting
 * (nostr-tools asks callers to) and the plaintext after.
 */
export function decryptSecretUpdate(
  ciphertext: string,
  recipientSecretKey: Uint8Array,
  senderPubkey: string
): SecretUpdatePlaintext {
  if (utf8Bytes(ciphertext) > MAX_SECRET_CIPHERTEXT_BYTES) {
    throw new Error('secret update ciphertext exceeds 100 KiB');
  }
  const key = nip44.utils.getConversationKey(recipientSecretKey, senderPubkey);
  const json = nip44.decrypt(ciphertext, key);
  if (utf8Bytes(json) > MAX_SECRET_PLAINTEXT_BYTES) {
    throw new Error(
      `secret update plaintext exceeds ${MAX_SECRET_PLAINTEXT_BYTES} bytes`
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('secret update plaintext is not JSON');
  }
  return assertSecretUpdateShape(parsed);
}

// ---------------------------------------------------------------------------
// Inventory
// ---------------------------------------------------------------------------

export interface SecretInventoryEntry {
  /** The value, or `null` for a remove tombstone. */
  value: string | null;
  /** Ordering position of the update that last touched this name. */
  createdAt: number;
  eventId: string;
  /** The maintainer whose update supplied this entry. */
  origin: string;
}

export type SecretInventory = Record<string, SecretInventoryEntry>;

/**
 * Apply one accepted update to an inventory (immutably). Per name, the
 * NIP-C1 total order decides: an update only replaces an entry it is LATER
 * than, so replaying an old event — or a remove that arrived before the set
 * it tombstones — never resurrects a stale value.
 */
export function applySecretUpdate(
  inventory: SecretInventory,
  plain: SecretUpdatePlaintext,
  eventId: string
): SecretInventory {
  const next: SecretInventory = { ...inventory };
  const position = { createdAt: plain.created_at, eventId };
  const isLater = (name: string): boolean => {
    const existing = next[name];
    return existing === undefined || controlOrder(position, existing) > 0;
  };
  for (const [name, value] of Object.entries(plain.set)) {
    if (isLater(name)) {
      next[name] = { value, ...position, origin: plain.author };
    }
  }
  for (const name of plain.remove) {
    if (isLater(name)) {
      next[name] = { value: null, ...position, origin: plain.author };
    }
  }
  return next;
}

/** The injectable name → value map (tombstones dropped). */
export function effectiveSecrets(
  inventory: SecretInventory
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, entry] of Object.entries(inventory)) {
    if (entry.value !== null) out[name] = entry.value;
  }
  return out;
}

/**
 * Replace every occurrence of every secret value in `text` with `***`,
 * longest value first so a value that contains another is never left half
 * visible. The coordinator runs job logs through this before they reach the
 * store or the relay: act masks secrets in its own output, but no Runner is
 * trusted to, and the 9841 log tail is a public event.
 */
export function redactSecretValues(
  text: string,
  values: Iterable<string>
): string {
  const ordered = [...new Set(values)]
    .filter((v) => v !== '')
    .sort((a, b) => b.length - a.length);
  let out = text;
  for (const value of ordered) out = out.split(value).join('***');
  return out;
}

/** A fresh NIP-44 recipient (secrets-key) or sender keypair. */
export function generateSecretsKey(): {
  secretKey: Uint8Array;
  pubkey: string;
} {
  const secretKey = generateSecretKey();
  return { secretKey, pubkey: getPublicKey(secretKey) };
}
