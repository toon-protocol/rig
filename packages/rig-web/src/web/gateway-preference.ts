/**
 * Which store gateway rig-web LINKS to (rig#132).
 *
 * Self-contained copy of `packages/rig/src/gateway-preference.ts`: rig-web
 * does not import `@toon-protocol/rig` (see the header of nip34-parsers.ts),
 * so the rule is duplicated here. Keep the two in step.
 *
 * Fetches try every gateway in `@toon-protocol/arweave`'s shared list, so the
 * order there only matters for redundancy. A rendered link is different: it
 * is the one URL a reader clicks. `ar-io.dev` heads the shared list but is
 * ar.io's TESTNET gateway — its ArNS resolver runs against the Solana devnet
 * contracts and it serves testnet-bundler uploads that never reach Arweave —
 * so a mainnet upload linked there is a guaranteed 404. rig-web prefers the
 * first MAINNET gateway of that list and never links the testnet one.
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

/** The gateway a rendered link defaults to: the shared list's first mainnet one. */
export const PREFERRED_GATEWAY: string =
  ARWEAVE_GATEWAYS.find(isMainnetGateway) ?? 'https://arweave.net';

/**
 * The href to render for a store gateway URL a coordinator published (a Job
 * Result's `logs` and `artifact` tags, `<gateway>/raw/<txId>`). The URL is the
 * coordinator's claim about where the bytes are, so only the host is
 * re-pointed, and only when it is the excluded testnet gateway: the path is
 * kept, and every other host — a sandbox store on localhost, a mainnet
 * gateway, an unknown mirror, a malformed string — comes back verbatim, since
 * rewriting it could only break a link that worked.
 */
export function storeLinkHref(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  if (!TESTNET_GATEWAY.test(parsed.hostname)) return url;
  const base = PREFERRED_GATEWAY.replace(/\/+$/, '');
  return `${base}${parsed.pathname}${parsed.search}${parsed.hash}`;
}
