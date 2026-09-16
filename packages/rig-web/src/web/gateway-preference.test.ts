import { describe, it, expect } from 'vitest';
import { ARWEAVE_GATEWAYS } from '@toon-protocol/arweave';
import {
  PREFERRED_GATEWAY,
  isMainnetGateway,
  storeLinkHref,
} from './gateway-preference.js';

describe('gateway preference (rig#132: store links never point at the testnet gateway)', () => {
  it('PREFERRED_GATEWAY is a mainnet member of the shared list', () => {
    expect(ARWEAVE_GATEWAYS).toContain(PREFERRED_GATEWAY);
    expect(isMainnetGateway(PREFERRED_GATEWAY)).toBe(true);
    expect(PREFERRED_GATEWAY).not.toMatch(/ar-io\.dev/);
  });

  it('isMainnetGateway rejects ar-io.dev (and its subdomains) and malformed URLs', () => {
    expect(isMainnetGateway('https://arweave.net')).toBe(true);
    expect(isMainnetGateway('https://permagate.io/')).toBe(true);
    expect(isMainnetGateway('http://localhost:3000')).toBe(true);
    expect(isMainnetGateway('https://ar-io.dev')).toBe(false);
    expect(isMainnetGateway('https://AR-IO.dev/raw/x')).toBe(false);
    expect(isMainnetGateway('https://abc.ar-io.dev/raw/x')).toBe(false);
    expect(isMainnetGateway('not a url')).toBe(false);
    expect(isMainnetGateway('')).toBe(false);
  });

  it('storeLinkHref re-points a testnet-gateway link to the preferred gateway, keeping the path', () => {
    expect(storeLinkHref('https://ar-io.dev/raw/tx-log')).toBe(
      `${PREFERRED_GATEWAY}/raw/tx-log`
    );
    expect(storeLinkHref('https://x.ar-io.dev/raw/tx?x=1#top')).toBe(
      `${PREFERRED_GATEWAY}/raw/tx?x=1#top`
    );
  });

  it('storeLinkHref leaves every other link verbatim (a sandbox store, a mainnet gateway, garbage)', () => {
    for (const url of [
      'http://localhost:3000/raw/tx-log',
      'https://arweave.net/raw/tx-log',
      'https://permagate.io/raw/tx-log',
      'https://store.example/raw/tx-log',
      'not a url',
      '',
    ]) {
      expect(storeLinkHref(url)).toBe(url);
    }
  });
});
