/**
 * Arweave gateway client for Rig-UI.
 *
 * Fetches git objects from Arweave gateways and resolves git SHAs
 * to Arweave transaction IDs via GraphQL.
 *
 * Uses browser-native fetch() with AbortSignal.timeout() for all requests.
 * No Node.js APIs — browser-compatible only.
 */

// Gateway list + fetch timeout are owned by @toon-protocol/arweave (the single
// source of truth shared with views + client-mcp); the Git-SHA → txId GraphQL
// resolver (resolveGitSha / seedShaCache / clearShaCache) moved there too so
// the Node write path (@toon-protocol/rig) shares ONE implementation (#225).
// Everything is re-exported here so existing rig importers keep their
// `../arweave-client.js` path.
export {
  ARWEAVE_GATEWAYS,
  ARWEAVE_FETCH_TIMEOUT_MS,
  clearShaCache,
  resolveGitSha,
  seedShaCache,
} from '@toon-protocol/arweave';
import {
  ARWEAVE_FETCH_TIMEOUT_MS,
  isValidArweaveTxId,
} from '@toon-protocol/arweave';
import {
  normalizeGateway,
  objectFetchUrls,
  objectImageUrl,
} from './arweave-gateway.js';

/**
 * The store gateway this build reads from before the public list, or null.
 *
 * Read per call rather than once at module load: Vite replaces the expression
 * with a literal at build time either way, and a function keeps the value
 * stubbable (`vi.stubEnv`) in tests. See `arweave-gateway.ts` for why an
 * override exists at all.
 */
function configuredGateway(): string | null {
  return normalizeGateway(import.meta.env.VITE_ARWEAVE_GATEWAY);
}

/**
 * The URL to RENDER for an object's bytes (an `<img src>` resolved out of the
 * git tree). Points at `VITE_ARWEAVE_GATEWAY` when one is configured, and at
 * the first public gateway otherwise.
 */
export function arweaveObjectUrl(txId: string): string {
  return objectImageUrl(txId, configuredGateway());
}

/**
 * Fetch a raw object from an Arweave gateway by transaction ID.
 *
 * Tries `VITE_ARWEAVE_GATEWAY` first when one is configured, then each public
 * gateway in turn. Returns null if all of them fail (404, network error,
 * timeout).
 *
 * @param txId - Arweave transaction ID (43-character base64url string)
 * @returns Raw bytes as Uint8Array, or null if unavailable
 */
export async function fetchArweaveObject(
  txId: string
): Promise<Uint8Array | null> {
  if (!isValidArweaveTxId(txId)) {
    return null;
  }

  for (const url of objectFetchUrls(txId, configuredGateway())) {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(ARWEAVE_FETCH_TIMEOUT_MS),
      });

      if (!response.ok) {
        continue;
      }

      const buffer = await response.arrayBuffer();
      return new Uint8Array(buffer);
    } catch {
      // Network error, timeout, or other failure — try next gateway
      continue;
    }
  }

  return null;
}
