/**
 * Which Arweave gateway rig PRINTS.
 *
 * Fetches try every gateway in `@toon-protocol/arweave`'s shared list, so the
 * order there only matters for redundancy. A printed URL is different: it is
 * the one link a reader clicks. `ar-io.dev` heads the shared list but is
 * ar.io's TESTNET gateway — its ArNS resolver runs against the Solana devnet
 * contracts and it serves testnet-bundler uploads that never reach Arweave —
 * so a mainnet upload printed there is a guaranteed 404 (toon-client#577
 * reorders the shared list). Until then rig prefers the first MAINNET gateway
 * of that list and never prints the testnet one as the primary.
 */

import { ARWEAVE_GATEWAYS } from '@toon-protocol/arweave';

const TESTNET_GATEWAY = /(^|\.)ar-io\.dev$/i;

/** Every gateway that is not ar.io's testnet. Malformed URLs are not gateways. */
export function isMainnetGateway(url: string): boolean {
  try {
    return !TESTNET_GATEWAY.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

/** The gateway a printed URL defaults to: the shared list's first mainnet one. */
export const PREFERRED_GATEWAY: string =
  ARWEAVE_GATEWAYS.find(isMainnetGateway) ?? 'https://arweave.net';

/** The shared list minus one gateway, for "also at" mirrors under a primary. */
export function mirrorGatewaysFor(primary: string): string[] {
  const p = primary.replace(/\/+$/, '');
  return ARWEAVE_GATEWAYS.filter((g) => g.replace(/\/+$/, '') !== p);
}
