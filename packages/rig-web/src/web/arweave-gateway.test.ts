// Unit tests for the self-hosted store gateway override (rig#177):
// `VITE_ARWEAVE_GATEWAY` is tried ahead of the public gateway list, and its
// origin is spliced into the CSP so the browser is allowed to reach it.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { ARWEAVE_GATEWAYS } from '@toon-protocol/arweave';

import {
  normalizeGateway,
  objectFetchUrls,
  objectImageUrl,
  withGatewayCsp,
} from './arweave-gateway.js';

const TX_ID = 'abcdefghijklmnopqrstuvwxyz01234567890ABCDEF';

// The real document the Vite plugin transforms, so the tag-matching here
// fails loudly if index.html's CSP meta tag is ever reshaped.
const INDEX_CSP = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), 'index.html'),
  'utf-8'
);

describe('normalizeGateway', () => {
  it('[P1] trims surrounding whitespace and trailing slashes', () => {
    expect(normalizeGateway('  http://localhost:3000/  ')).toBe(
      'http://localhost:3000'
    );
    expect(normalizeGateway('https://gw.example///')).toBe('https://gw.example');
  });

  it('[P1] keeps a path prefix, so a gateway mounted under a sub-path works', () => {
    expect(normalizeGateway('https://gw.example/store/')).toBe(
      'https://gw.example/store'
    );
  });

  it('[P2] drops a query string or fragment, which cannot precede the tx id', () => {
    expect(normalizeGateway('https://gw.example/?x=1')).toBe(
      'https://gw.example'
    );
    expect(normalizeGateway('https://gw.example/store#top')).toBe(
      'https://gw.example/store'
    );
  });

  it('[P1] treats an unset, empty or whitespace-only value as no override', () => {
    expect(normalizeGateway(undefined)).toBeNull();
    expect(normalizeGateway(null)).toBeNull();
    expect(normalizeGateway('')).toBeNull();
    expect(normalizeGateway('   ')).toBeNull();
  });

  it('[P1] rejects a malformed URL or a non-HTTP scheme', () => {
    expect(normalizeGateway('not a url')).toBeNull();
    expect(normalizeGateway('ws://localhost:7100')).toBeNull();
    expect(normalizeGateway('javascript:alert(1)')).toBeNull();
  });
});

describe('objectFetchUrls', () => {
  it('[P1] is the public gateway list, unchanged, when no override is set', () => {
    expect(objectFetchUrls(TX_ID, null)).toEqual(
      ARWEAVE_GATEWAYS.map((gateway) => `${gateway}/${TX_ID}`)
    );
  });

  it('[P1] tries the override first, at the /raw/ route, then the public list', () => {
    const urls = objectFetchUrls(TX_ID, 'http://localhost:3000');

    expect(urls[0]).toBe(`http://localhost:3000/raw/${TX_ID}`);
    expect(urls.slice(1)).toEqual(
      ARWEAVE_GATEWAYS.map((gateway) => `${gateway}/${TX_ID}`)
    );
  });

  it('[P1] keeps the public list as a fallback, so a down sandbox still reads mainnet', () => {
    expect(objectFetchUrls(TX_ID, 'http://localhost:3000')).toHaveLength(
      ARWEAVE_GATEWAYS.length + 1
    );
  });

  it('[P2] ignores an override that is not a usable HTTP URL', () => {
    expect(objectFetchUrls(TX_ID, 'nonsense')).toEqual(
      ARWEAVE_GATEWAYS.map((gateway) => `${gateway}/${TX_ID}`)
    );
  });
});

describe('objectImageUrl', () => {
  it('[P1] renders against the first public gateway when no override is set', () => {
    expect(objectImageUrl(TX_ID, null)).toBe(`${ARWEAVE_GATEWAYS[0]}/${TX_ID}`);
  });

  it('[P1] renders against the override, at the /raw/ route, when one is set', () => {
    expect(objectImageUrl(TX_ID, 'http://localhost:3000/')).toBe(
      `http://localhost:3000/raw/${TX_ID}`
    );
  });
});

describe('withGatewayCsp', () => {
  it('[P1] leaves the document untouched when no override is set', () => {
    expect(withGatewayCsp(INDEX_CSP, null)).toBe(INDEX_CSP);
    expect(withGatewayCsp(INDEX_CSP, '')).toBe(INDEX_CSP);
  });

  it('[P1] adds the override origin to connect-src', () => {
    const html = withGatewayCsp(INDEX_CSP, 'http://localhost:3000');

    const connectSrc = /connect-src ([^;"]*)/.exec(html)?.[1] ?? '';
    expect(connectSrc.split(/\s+/)).toContain('http://localhost:3000');
  });

  it('[P1] adds the override origin to img-src, so tree-resolved images render', () => {
    const html = withGatewayCsp(INDEX_CSP, 'http://localhost:3000');

    const imgSrc = /img-src ([^;"]*)/.exec(html)?.[1] ?? '';
    expect(imgSrc.split(/\s+/)).toContain('http://localhost:3000');
  });

  it('[P1] adds the ORIGIN only — a CSP source cannot carry a path', () => {
    const html = withGatewayCsp(INDEX_CSP, 'https://gw.example/store');

    expect(html).toContain('https://gw.example');
    expect(html).not.toContain('https://gw.example/store');
  });

  it('[P1] keeps the three public gateways in connect-src', () => {
    const html = withGatewayCsp(INDEX_CSP, 'http://localhost:3000');

    expect(html).toContain('https://ar-io.dev');
    expect(html).toContain('https://arweave.net');
    expect(html).toContain('https://permagate.io');
  });

  it('[P1] leaves every other directive alone', () => {
    const html = withGatewayCsp(INDEX_CSP, 'http://localhost:3000');

    expect(html).toContain("default-src 'self';");
    expect(html).toContain("script-src 'self' 'wasm-unsafe-eval'");
    expect(html).toContain("style-src 'self' 'unsafe-inline'");
  });

  it('[P2] does not duplicate an origin the policy already allows', () => {
    const html = withGatewayCsp(INDEX_CSP, 'https://arweave.net');

    const connectSrc = /connect-src ([^;"]*)/.exec(html)?.[1] ?? '';
    const occurrences = connectSrc
      .split(/\s+/)
      .filter((source) => source === 'https://arweave.net');
    expect(occurrences).toHaveLength(1);
  });

  it('[P2] ignores an override that is not a usable HTTP URL', () => {
    expect(withGatewayCsp(INDEX_CSP, 'nonsense')).toBe(INDEX_CSP);
  });

  it('[P2] leaves a document with no CSP meta tag alone', () => {
    const html = '<!doctype html><html><head></head><body></body></html>';

    expect(withGatewayCsp(html, 'http://localhost:3000')).toBe(html);
  });
});
