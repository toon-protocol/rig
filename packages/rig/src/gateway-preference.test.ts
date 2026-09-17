/**
 * Tests for gateway selection: which gateway rig prints, and — #176 — the
 * read-path override that puts a configured gateway's raw-bytes route ahead
 * of the shared public list.
 */

import { describe, it, expect } from 'vitest';
import { ARWEAVE_GATEWAYS } from '@toon-protocol/arweave';
import {
  ARWEAVE_GATEWAY_ENV,
  PREFERRED_GATEWAY,
  configuredGateway,
  isMainnetGateway,
  mirrorGatewaysFor,
  normalizeGatewayUrl,
  readGateways,
  readGatewaysFor,
} from './gateway-preference.js';

describe('printed-gateway preference', () => {
  it('never prints ar.io testnet as the primary', () => {
    expect(isMainnetGateway('https://ar-io.dev')).toBe(false);
    expect(isMainnetGateway('https://arweave.net')).toBe(true);
    expect(isMainnetGateway('not a url')).toBe(false);
    expect(isMainnetGateway(PREFERRED_GATEWAY)).toBe(true);
  });

  it('mirrors are the shared list minus the primary', () => {
    expect(mirrorGatewaysFor('https://arweave.net/')).not.toContain(
      'https://arweave.net'
    );
    expect(mirrorGatewaysFor('https://arweave.net')).toHaveLength(
      ARWEAVE_GATEWAYS.length - 1
    );
  });
});

describe('configuredGateway (#176)', () => {
  it('prefers the flag over the environment', () => {
    expect(
      configuredGateway('https://flag.test', {
        [ARWEAVE_GATEWAY_ENV]: 'https://env.test',
      })
    ).toBe('https://flag.test');
  });

  it('falls back to RIG_ARWEAVE_GATEWAY — the variable the write path honours', () => {
    expect(
      configuredGateway(undefined, {
        [ARWEAVE_GATEWAY_ENV]: 'http://localhost:3000',
      })
    ).toBe('http://localhost:3000');
  });

  it('is null when nothing is configured, blank included', () => {
    expect(configuredGateway(undefined, {})).toBeNull();
    expect(configuredGateway(undefined, { [ARWEAVE_GATEWAY_ENV]: '  ' })).toBe(
      null
    );
    expect(configuredGateway('', {})).toBeNull();
  });

  it('normalizes trailing slashes so a route never doubles up', () => {
    expect(configuredGateway('https://gw.test///', {})).toBe(
      'https://gw.test'
    );
    expect(normalizeGatewayUrl('https://gw.test/')).toBe('https://gw.test');
  });
});

describe('readGateways (#176)', () => {
  it('puts the configured gateway FIRST, on the raw-bytes route', () => {
    const gateways = readGateways('https://gw.test/', {});
    expect(gateways[0]).toBe('https://gw.test/raw');
  });

  it('keeps the shared public list as the fallback', () => {
    const gateways = readGateways('https://gw.test', {});
    expect([...gateways].slice(1)).toEqual([...ARWEAVE_GATEWAYS]);
  });

  it('reads through the environment gateway when no flag is given', () => {
    const gateways = readGateways(undefined, {
      [ARWEAVE_GATEWAY_ENV]: 'http://localhost:3000',
    });
    expect(gateways[0]).toBe('http://localhost:3000/raw');
  });

  it('is exactly the shared list when nothing is configured', () => {
    expect([...readGateways(undefined, {})]).toEqual([...ARWEAVE_GATEWAYS]);
  });

  it('readGatewaysFor is the same list for an already-resolved gateway', () => {
    expect(readGatewaysFor('https://gw.test/')).toEqual([
      'https://gw.test/raw',
      ...ARWEAVE_GATEWAYS,
    ]);
  });
});
