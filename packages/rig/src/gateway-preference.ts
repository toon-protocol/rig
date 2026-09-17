/**
 * Which Arweave gateway rig PRINTS — and which one it READS through (#176).
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

// ---------------------------------------------------------------------------
// The gateway override on the READ path (#176)
// ---------------------------------------------------------------------------

/** Environment variable naming the gateway rig writes through and reads from. */
export const ARWEAVE_GATEWAY_ENV = 'RIG_ARWEAVE_GATEWAY';

/** Trailing slashes off a gateway base URL, so `${g}/raw` never doubles up. */
export function normalizeGatewayUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

/**
 * The gateway this invocation was configured with: `--gateway`, else
 * `RIG_ARWEAVE_GATEWAY`, else null — nothing configured, blank counting as
 * unset. Normalized, so a caller can append a route to it.
 */
export function configuredGateway(
  flag: string | undefined,
  env: NodeJS.ProcessEnv
): string | null {
  const raw = (flag ?? env[ARWEAVE_GATEWAY_ENV] ?? '').trim();
  return raw === '' ? null : normalizeGatewayUrl(raw);
}

/**
 * Where object bytes are read from once a gateway IS configured: its raw-bytes
 * route FIRST, then the shared public list as the fallback.
 *
 * `<gateway>/raw/<txId>`, not `<gateway>/<txId>`: an ar.io node serves raw
 * transaction bytes there whether or not it does sandboxed-subdomain
 * redirects, and the TOON store's own gateway (the dev sandbox's) answers on
 * that route ALONE. A public gateway serves the same bytes on both.
 */
export function readGatewaysFor(gateway: string): string[] {
  return [`${normalizeGatewayUrl(gateway)}/raw`, ...ARWEAVE_GATEWAYS];
}

/**
 * The read path's gateway list for a command that takes `--gateway`: the
 * configured gateway first ({@link readGatewaysFor}), or — nothing configured
 * — the shared public list exactly as it stands today.
 *
 * This is what gives `rig clone` / `rig fetch` the reach `rig push` has: a
 * repository whose objects live only on a private, local or air-gapped
 * gateway becomes readable by naming it, with the public gateways still
 * serving everyone else.
 */
export function readGateways(
  flag: string | undefined,
  env: NodeJS.ProcessEnv
): readonly string[] {
  const gateway = configuredGateway(flag, env);
  return gateway === null ? ARWEAVE_GATEWAYS : readGatewaysFor(gateway);
}
