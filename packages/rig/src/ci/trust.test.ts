/**
 * Trust-level derivation tests (rig#125): the four NIP-C1 trust levels a run
 * can carry, derived ONLY from Service Requests / Stops and the repo's
 * maintainers — never from the coordinator's say-so.
 */

import { describe, it, expect } from 'vitest';
import type { ServiceControl } from './nip-c1-events.js';
import { CI_TRUST_ORDER, deriveTrustLevel, trustAtLeast } from './trust.js';

const OWNER = 'ab'.repeat(32);
const MAINTAINER = 'cd'.repeat(32);
const STRANGER = 'ef'.repeat(32);
const COORDINATOR = '12'.repeat(32);
const OTHER_COORDINATOR = '34'.repeat(32);
const ADDR = `30617:${OWNER}:demo`;
const RELAY = 'wss://relay.test.example';
const authorized = new Set([OWNER, MAINTAINER]);

function control(
  kind: 'request' | 'stop',
  pubkey: string,
  createdAt: number,
  id: string,
  coordinatorPubkey = COORDINATOR
): ServiceControl {
  return {
    kind,
    eventId: id.repeat(32),
    pubkey,
    createdAt,
    repoAddr: ADDR,
    coordinatorPubkey,
  };
}

describe('deriveTrustLevel', () => {
  it('maintainer-directed: a service-request quote from a maintainer whose request is known and targets the publisher', () => {
    const req = control('request', MAINTAINER, 100, '01');
    expect(
      deriveTrustLevel({
        publisherPubkey: COORDINATOR,
        provenance: {
          kind: 'service-request',
          eventId: req.eventId,
          relayUrl: RELAY,
          pubkey: MAINTAINER,
        },
        authorized,
        controls: [req],
        runCreatedAt: 200,
      })
    ).toBe('maintainer-directed');
  });

  it('maintainer-directed: a manual-trigger quote from a maintainer', () => {
    expect(
      deriveTrustLevel({
        publisherPubkey: COORDINATOR,
        provenance: {
          kind: 'manual-trigger',
          eventId: '40'.repeat(32),
          relayUrl: RELAY,
          pubkey: OWNER,
        },
        authorized,
        controls: [],
        runCreatedAt: 200,
      })
    ).toBe('maintainer-directed');
  });

  it('a quoted request that is unknown, or targets another coordinator, does not count as maintainer-directed', () => {
    const foreign = control(
      'request',
      MAINTAINER,
      100,
      '01',
      OTHER_COORDINATOR
    );
    const level = deriveTrustLevel({
      publisherPubkey: COORDINATOR,
      provenance: {
        kind: 'service-request',
        eventId: foreign.eventId,
        relayUrl: RELAY,
        pubkey: MAINTAINER,
      },
      authorized,
      controls: [foreign],
      runCreatedAt: 200,
    });
    expect(level).toBe('no-known-context');
    // A quote from a NON-maintainer is not maintainer-directed either.
    const strangerReq = control('request', STRANGER, 100, '02');
    expect(
      deriveTrustLevel({
        publisherPubkey: COORDINATOR,
        provenance: {
          kind: 'service-request',
          eventId: strangerReq.eventId,
          relayUrl: RELAY,
          pubkey: STRANGER,
        },
        authorized,
        controls: [strangerReq],
        runCreatedAt: 200,
      })
    ).toBe('seen-in-network');
  });

  it('operationally-associated: no qualifying quote, but a maintainer request stood at run time', () => {
    const req = control('request', OWNER, 100, '01');
    expect(
      deriveTrustLevel({
        publisherPubkey: COORDINATOR,
        authorized,
        controls: [req],
        runCreatedAt: 200,
      })
    ).toBe('operationally-associated');
  });

  it('a request created AFTER the run, or stopped before it, does not make the run operationally-associated', () => {
    const late = control('request', OWNER, 300, '01');
    expect(
      deriveTrustLevel({
        publisherPubkey: COORDINATOR,
        authorized,
        controls: [late],
        runCreatedAt: 200,
      })
    ).toBe('seen-in-network');
    const req = control('request', OWNER, 100, '01');
    const stop = control('stop', OWNER, 150, '02');
    expect(
      deriveTrustLevel({
        publisherPubkey: COORDINATOR,
        authorized,
        controls: [req, stop],
        runCreatedAt: 200,
      })
    ).toBe('seen-in-network');
  });

  it('seen-in-network: the publisher is itself a maintainer, or a stranger requested its service', () => {
    expect(
      deriveTrustLevel({
        publisherPubkey: MAINTAINER,
        authorized,
        controls: [],
        runCreatedAt: 200,
      })
    ).toBe('seen-in-network');
    expect(
      deriveTrustLevel({
        publisherPubkey: COORDINATOR,
        authorized,
        controls: [control('request', STRANGER, 100, '01')],
        runCreatedAt: 200,
      })
    ).toBe('seen-in-network');
  });

  it('no-known-context: nothing ties the publisher to the repo', () => {
    expect(
      deriveTrustLevel({
        publisherPubkey: COORDINATOR,
        authorized,
        controls: [control('request', OWNER, 100, '01', OTHER_COORDINATOR)],
        runCreatedAt: 200,
      })
    ).toBe('no-known-context');
  });

  it('is case-insensitive on pubkeys', () => {
    const req = control('request', MAINTAINER.toUpperCase(), 100, '01');
    expect(
      deriveTrustLevel({
        publisherPubkey: COORDINATOR.toUpperCase(),
        authorized,
        controls: [req],
        runCreatedAt: 200,
      })
    ).toBe('operationally-associated');
  });
});

describe('trustAtLeast', () => {
  it('orders the four levels strongest first', () => {
    expect(CI_TRUST_ORDER).toEqual([
      'maintainer-directed',
      'operationally-associated',
      'seen-in-network',
      'no-known-context',
    ]);
    expect(trustAtLeast('maintainer-directed', 'seen-in-network')).toBe(true);
    expect(trustAtLeast('seen-in-network', 'seen-in-network')).toBe(true);
    expect(trustAtLeast('seen-in-network', 'maintainer-directed')).toBe(false);
    expect(trustAtLeast('no-known-context', 'operationally-associated')).toBe(
      false
    );
  });
});
