/**
 * Which store gateway rig-web FETCHES object bytes from (rig#177).
 *
 * `@toon-protocol/arweave` owns the three public gateways rig-web reads by
 * default. A self-hosted store — the TOON sandbox, a private mirror — is not
 * on that list and cannot be, so `VITE_ARWEAVE_GATEWAY` names one at build
 * time and it is tried FIRST, with the public list kept behind it as a
 * fallback. It is the read-side twin of `VITE_DEFAULT_RELAY`.
 *
 * Two things have to agree for a browser fetch to land, which is why the CSP
 * helper lives here next to the URL builders rather than in the HTML:
 *
 *   1. the request has to be ADDRESSED to the gateway ({@link objectFetchUrls}),
 *   2. and `connect-src` has to ALLOW its origin ({@link withGatewayCsp}).
 *
 * With only the first, the browser blocks the request; with only the second,
 * nothing is ever sent there. Against the sandbox that combination rendered
 * relay data (refs, announcement, issues) while every tree read failed with
 * "Could not resolve commit tree", which reads like a data problem and is not.
 *
 * Everything here is PURE and free of `import.meta.env` on purpose: the Vite
 * config imports {@link withGatewayCsp} to stamp the policy at dev/build time,
 * and a module that touched `import.meta.env` at load would blow up there.
 * `arweave-client.ts` owns the one read of the env var.
 *
 * The override is addressed at `<gateway>/raw/<txId>`, the route that serves
 * bytes verbatim — the same one a coordinator publishes in a Job Result's
 * `logs`/`artifact` tags. The public list keeps its historical `<gateway>/<txId>`.
 */

import { ARWEAVE_GATEWAYS } from '@toon-protocol/arweave';

/** Directives that name a host rig-web fetches or renders store bytes from. */
const GATEWAY_DIRECTIVES = ['connect-src', 'img-src'] as const;

/**
 * A configured gateway as a usable base URL, or null when there is no usable
 * override. Reduced to origin + path with trailing slashes stripped, so a
 * gateway mounted under a sub-path works while a stray query string or
 * fragment cannot end up in the middle of the object path. Anything that is
 * not an http(s) URL is no override at all rather than a hard failure: a typo
 * in an env var should degrade to the public gateways, not blank the app.
 */
export function normalizeGateway(raw: string | undefined | null): string | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`;
}

/**
 * The URLs to try, in order, for one object's raw bytes: the configured
 * gateway first, then every public gateway. The public list always stays in
 * the tail so a stopped sandbox falls back to mainnet instead of going dark.
 */
export function objectFetchUrls(
  txId: string,
  gateway: string | undefined | null
): string[] {
  const configured = normalizeGateway(gateway);
  const publicUrls = ARWEAVE_GATEWAYS.map((base) => `${base}/${txId}`);
  return configured ? [`${configured}/raw/${txId}`, ...publicUrls] : publicUrls;
}

/**
 * The single URL to RENDER for an object (an `<img src>` resolved out of the
 * git tree). A rendered URL cannot fail over, so it points at the configured
 * gateway when there is one and at the first public gateway otherwise.
 */
export function objectImageUrl(
  txId: string,
  gateway: string | undefined | null
): string {
  const configured = normalizeGateway(gateway);
  return configured
    ? `${configured}/raw/${txId}`
    : `${ARWEAVE_GATEWAYS[0]}/${txId}`;
}

/** Matches the `content="…"` of the CSP meta tag in `index.html`. */
const CSP_META =
  /(<meta\s+http-equiv="Content-Security-Policy"\s+content=")([^"]*)(")/i;

/** Append `source` to `directive` unless the policy already allows it. */
function allowSource(policy: string, directive: string, source: string): string {
  return policy
    .split(';')
    .map((part) => {
      const tokens = part.trim().split(/\s+/);
      if (tokens[0] !== directive) return part;
      if (tokens.includes(source)) return part;
      return `${part} ${source}`;
    })
    .join(';');
}

/**
 * The document with the configured gateway's ORIGIN added to the CSP
 * directives that govern store reads. Returned unchanged when there is no
 * override, when the value is unusable, or when the document carries no CSP
 * meta tag — the three public gateways are never removed.
 *
 * Called from `vite.config.ts` via `transformIndexHtml`, so dev and build
 * derive the policy from the same env var that addresses the fetch, and the
 * static `index.html` never has to repeat the host list.
 */
export function withGatewayCsp(
  html: string,
  gateway: string | undefined | null
): string {
  const configured = normalizeGateway(gateway);
  if (!configured) return html;
  const { origin } = new URL(configured);
  return html.replace(
    CSP_META,
    (_match, open: string, policy: string, close: string) => {
      const widened = GATEWAY_DIRECTIVES.reduce(
        (acc, directive) => allowSource(acc, directive, origin),
        policy
      );
      return `${open}${widened}${close}`;
    }
  );
}
