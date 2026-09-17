/**
 * The Git-SHA GraphQL fallback, pointed at the CONFIGURED gateway (#183).
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
  clearShaCache,
  resolveGitSha,
  seedShaCache,
  shaCacheKey,
} from '@toon-protocol/arweave';
import {
  clearGatewayShaCache,
  gatewayShaResolver,
  graphqlEndpointFor,
  shaResolverFor,
  type GraphqlFetch,
} from './git-sha-resolver.js';

const SHA = 'a1'.repeat(20);
const OTHER_SHA = 'b2'.repeat(20);
const TX = 'T'.repeat(43);
const OTHER_TX = 'U'.repeat(43);
const REPO = 'demo-repo';
const GATEWAY = 'http://localhost:3000';

afterEach(() => {
  clearGatewayShaCache();
  clearShaCache();
});

/** A GraphQL endpoint that answers every query with `txId`. */
function mockGraphql(
  txId: string | null,
  options: { ok?: boolean; throws?: boolean } = {}
): { fetchFn: GraphqlFetch; calls: { url: string; query: string }[] } {
  const calls: { url: string; query: string }[] = [];
  const fetchFn: GraphqlFetch = async (url, init) => {
    const body = JSON.parse(String(init.body)) as { query: string };
    calls.push({ url, query: body.query });
    if (options.throws) throw new Error('network down');
    return {
      ok: options.ok ?? true,
      json: async () => ({
        data: {
          transactions: {
            edges: txId === null ? [] : [{ node: { id: txId } }],
          },
        },
      }),
    };
  };
  return { fetchFn, calls };
}

// ---------------------------------------------------------------------------
// Endpoint
// ---------------------------------------------------------------------------

describe('graphqlEndpointFor', () => {
  it('appends /graphql to the gateway base, trailing slashes normalized', () => {
    expect(graphqlEndpointFor(GATEWAY)).toBe(`${GATEWAY}/graphql`);
    expect(graphqlEndpointFor(`${GATEWAY}//`)).toBe(`${GATEWAY}/graphql`);
  });
});

// ---------------------------------------------------------------------------
// The resolver itself
// ---------------------------------------------------------------------------

describe('gatewayShaResolver', () => {
  it('asks the CONFIGURED gateway, never arweave.net', async () => {
    const { fetchFn, calls } = mockGraphql(TX);
    const resolve = gatewayShaResolver(GATEWAY, fetchFn);

    expect(await resolve(SHA, REPO)).toBe(TX);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`${GATEWAY}/graphql`);
    expect(calls.some((c) => c.url.includes('arweave.net'))).toBe(false);
  });

  it('queries the Git-SHA + Repo tag pair the store stamps on uploads', async () => {
    const { fetchFn, calls } = mockGraphql(TX);
    await gatewayShaResolver(GATEWAY, fetchFn)(SHA, REPO);

    const query = calls[0]?.query ?? '';
    expect(query).toContain(`name: "Git-SHA", values: ["${SHA}"]`);
    expect(query).toContain(`name: "Repo", values: ["${REPO}"]`);
    expect(query).toContain('edges { node { id } }');
  });

  it('strips characters that would break out of the GraphQL string literal', async () => {
    const { fetchFn, calls } = mockGraphql(TX);
    await gatewayShaResolver(GATEWAY, fetchFn)(SHA, 'evil"] } ,{name:"x\nrepo');

    const query = calls[0]?.query ?? '';
    expect(query).not.toContain('"] } ,{name:');
    expect(query.split('\n').filter((line) => line.includes('Repo'))).toEqual([
      '    { name: "Repo", values: ["evil] } ,{name:xrepo"] }',
    ]);
  });

  it('rejects a malformed sha before any request leaves the process', async () => {
    const { fetchFn, calls } = mockGraphql(TX);
    const resolve = gatewayShaResolver(GATEWAY, fetchFn);

    expect(await resolve('not-a-sha', REPO)).toBeNull();
    expect(await resolve(`${SHA}extra`, REPO)).toBeNull();
    expect(calls).toEqual([]);
  });

  it('returns null — never throws — when the gateway cannot answer', async () => {
    const notFound = mockGraphql(null);
    expect(
      await gatewayShaResolver(GATEWAY, notFound.fetchFn)(SHA, REPO)
    ).toBeNull();

    const refused = mockGraphql(TX, { ok: false });
    expect(
      await gatewayShaResolver(GATEWAY, refused.fetchFn)(SHA, REPO)
    ).toBeNull();

    const down = mockGraphql(TX, { throws: true });
    expect(
      await gatewayShaResolver(GATEWAY, down.fetchFn)(SHA, REPO)
    ).toBeNull();
  });

  it('rejects an answer that is not a valid Arweave tx id', async () => {
    const { fetchFn } = mockGraphql('not-a-tx-id');
    expect(await gatewayShaResolver(GATEWAY, fetchFn)(SHA, REPO)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The cache is keyed per endpoint (#183: no cross-network answers)
// ---------------------------------------------------------------------------

describe('the gateway resolver cache', () => {
  it('caches a hit and serves the second call without a request', async () => {
    const { fetchFn, calls } = mockGraphql(TX);
    const resolve = gatewayShaResolver(GATEWAY, fetchFn);

    expect(await resolve(SHA, REPO)).toBe(TX);
    expect(await resolve(SHA, REPO)).toBe(TX);
    expect(calls).toHaveLength(1);
  });

  it('never serves one permaweb answer to a query against another', async () => {
    const sandbox = mockGraphql(TX);
    const mainnet = mockGraphql(OTHER_TX);

    expect(await gatewayShaResolver(GATEWAY, sandbox.fetchFn)(SHA, REPO)).toBe(
      TX
    );
    // Same sha, same repo, DIFFERENT gateway: asked again, answered afresh.
    expect(
      await gatewayShaResolver('https://arweave.net', mainnet.fetchFn)(SHA, REPO)
    ).toBe(OTHER_TX);
    expect(mainnet.calls).toHaveLength(1);
  });

  it('keeps the same sha in two repos apart', async () => {
    const { fetchFn, calls } = mockGraphql(TX);
    const resolve = gatewayShaResolver(GATEWAY, fetchFn);

    await resolve(SHA, REPO);
    await resolve(SHA, 'another-repo');
    expect(calls).toHaveLength(2);
  });

  it('is not the shared package cache: a seeded mainnet hint is not served', async () => {
    seedShaCache([[shaCacheKey(SHA, REPO), OTHER_TX]]);
    const { fetchFn, calls } = mockGraphql(TX);

    expect(await gatewayShaResolver(GATEWAY, fetchFn)(SHA, REPO)).toBe(TX);
    expect(calls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// shaResolverFor — the decision a command makes
// ---------------------------------------------------------------------------

describe('shaResolverFor', () => {
  it('is the shared package resolver, untouched, when nothing is configured', () => {
    expect(shaResolverFor(undefined, {})).toBe(resolveGitSha);
    expect(shaResolverFor(undefined, { RIG_ARWEAVE_GATEWAY: '  ' })).toBe(
      resolveGitSha
    );
    expect(shaResolverFor('', {})).toBe(resolveGitSha);
  });

  it('asks the --gateway endpoint when the flag is given', async () => {
    const { fetchFn, calls } = mockGraphql(TX);
    await shaResolverFor(GATEWAY, {}, fetchFn)(SHA, REPO);
    expect(calls[0]?.url).toBe(`${GATEWAY}/graphql`);
  });

  it('falls back to RIG_ARWEAVE_GATEWAY, and lets the flag beat it', async () => {
    const fromEnv = mockGraphql(TX);
    await shaResolverFor(
      undefined,
      { RIG_ARWEAVE_GATEWAY: `${GATEWAY}/` },
      fromEnv.fetchFn
    )(SHA, REPO);
    expect(fromEnv.calls[0]?.url).toBe(`${GATEWAY}/graphql`);

    const fromFlag = mockGraphql(TX);
    await shaResolverFor(
      'https://gw.example',
      { RIG_ARWEAVE_GATEWAY: GATEWAY },
      fromFlag.fetchFn
    )(OTHER_SHA, REPO);
    expect(fromFlag.calls[0]?.url).toBe('https://gw.example/graphql');
  });
});
