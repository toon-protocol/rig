/**
 * NIP-C1 trust levels (rig#125): how a run's results relate to the repo's
 * maintainers, derived ONLY from Service Requests / Stops and the repo's
 * declared maintainers — never from anything the coordinator asserts about
 * itself. The relay is permissionless, so a stranger's coordinator can
 * publish a green 9842 for anyone's commit; this is the consumer-side filter
 * (the same posture as #287's authorized status authors) that lets
 * `rig ci status --require-ci-trust` and rig-web tell whose CI they are
 * looking at.
 *
 *   maintainer-directed      the run's frozen provenance quote names a
 *                            maintainer: a manual trigger they signed, or a
 *                            Service Request they signed that we have SEEN
 *                            and that targets this run's publisher;
 *   operationally-associated no qualifying quote, but at run time an
 *                            accepted, unstopped maintainer Request stood for
 *                            this publisher (it was authorized, just silent);
 *   seen-in-network          the publisher is itself a maintainer, or SOME
 *                            pubkey (not a maintainer) requested its service
 *                            for this repo — e.g. a contributor running their
 *                            own coordinator against a repo they don't own;
 *   no-known-context         nothing ties the publisher to the repo.
 */

import {
  selectServiceRequests,
  type CiProvenance,
  type ServiceControl,
} from './nip-c1-events.js';

export type CiTrustLevel =
  | 'maintainer-directed'
  | 'operationally-associated'
  | 'seen-in-network'
  | 'no-known-context';

/** Strongest first. */
export const CI_TRUST_ORDER: readonly CiTrustLevel[] = [
  'maintainer-directed',
  'operationally-associated',
  'seen-in-network',
  'no-known-context',
];

export function isCiTrustLevel(value: string): value is CiTrustLevel {
  return (CI_TRUST_ORDER as readonly string[]).includes(value);
}

export interface DeriveTrustLevelArgs {
  /** The run's 9842/39842 signer — the coordinator. */
  publisherPubkey: string;
  /** The run's frozen `q … service-request|manual-trigger` quote, if any. */
  provenance?: CiProvenance;
  /** Owner ∪ maintainers of the repo (hex, any case). */
  authorized: Set<string>;
  /** Every 9843/9844 seen for this repo address (any coordinator). */
  controls: ServiceControl[];
  /** The run's `created_at` — requests are evaluated as of this instant. */
  runCreatedAt: number;
}

export function deriveTrustLevel(args: DeriveTrustLevelArgs): CiTrustLevel {
  const publisher = args.publisherPubkey.toLowerCase();
  const authorized = new Set([...args.authorized].map((p) => p.toLowerCase()));
  const forPublisher = args.controls.filter(
    (c) => c.coordinatorPubkey.toLowerCase() === publisher
  );

  const prov = args.provenance;
  if (prov && authorized.has(prov.pubkey.toLowerCase())) {
    if (prov.kind === 'manual-trigger') return 'maintainer-directed';
    const quoted = prov.eventId.toLowerCase();
    if (
      forPublisher.some(
        (c) =>
          c.kind === 'request' &&
          c.eventId.toLowerCase() === quoted &&
          c.pubkey.toLowerCase() === prov.pubkey.toLowerCase()
      )
    ) {
      return 'maintainer-directed';
    }
  }

  const standing = selectServiceRequests(
    forPublisher.filter((c) => c.createdAt <= args.runCreatedAt),
    { coordinatorPubkey: publisher, authorized }
  );
  if (standing.active) return 'operationally-associated';

  if (authorized.has(publisher)) return 'seen-in-network';
  if (forPublisher.some((c) => c.kind === 'request')) return 'seen-in-network';

  return 'no-known-context';
}

/** True when `level` is at least as strong as `required`. */
export function trustAtLeast(
  level: CiTrustLevel,
  required: CiTrustLevel
): boolean {
  return CI_TRUST_ORDER.indexOf(level) <= CI_TRUST_ORDER.indexOf(required);
}
