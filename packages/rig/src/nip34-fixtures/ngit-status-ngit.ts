/**
 * Real wire capture from wss://relay.ngit.dev (2026-09-17T16:00:01Z).
 *
 * A kind:1631 ("applied"/merged) status event on ngit's own `ngit` repo, in
 * NIP-10 marker form: `["e", <target-id>, "", "root"]` plus the repo's `a`
 * coordinate tag — exactly the shape rig#153's status builder must produce
 * and its readers must resolve, instead of today's bare `["e", <id>]`. Its
 * target, {@link NGIT_STATUS_NGIT_TARGET}, is the kind:1618 pull request the
 * status applies to (a `branch-name` tag rides along on it, relevant to a
 * neighbouring rig#153 ticket). Committed byte-for-byte as received — no
 * edited tags, no re-serialization, tag order preserved — so both events'
 * ids and signatures verify (see `ngit-fixtures.test.ts`).
 *
 * Captured with `scripts/capture-ngit-fixtures.mjs` (repo root); see that
 * file for the exact filter and how to re-run the capture.
 */

import type { NostrEvent } from '../remote-state.js';

export const NGIT_STATUS_NGIT_RELAY = 'wss://relay.ngit.dev';
export const NGIT_STATUS_NGIT_CAPTURED_AT = '2026-09-17T16:00:01Z';
export const NGIT_STATUS_NGIT_EVENT_ID =
  '7fa92c2970493b77974848db0c225e0c37fb6694eabed67387224a4711093b2f';
export const NGIT_STATUS_NGIT_TARGET_EVENT_ID =
  'fabe42e7c41d4e43e3dcc78db20c3859a7696eb6bc655aed852741e074951c48';

/** kind:1631 status ("applied") in NIP-10 marker form, targeting the PR below. */
export const NGIT_STATUS_NGIT: NostrEvent = {
  id: '7fa92c2970493b77974848db0c225e0c37fb6694eabed67387224a4711093b2f',
  pubkey: 'a008def15796fba9a0d6fab04e8fd57089285d9fd505da5a83fe8aad57a3564d',
  created_at: 1789656887,
  kind: 1631,
  tags: [
    [
      'e',
      'fabe42e7c41d4e43e3dcc78db20c3859a7696eb6bc655aed852741e074951c48',
      '',
      'root',
    ],
    [
      'a',
      '30617:a008def15796fba9a0d6fab04e8fd57089285d9fd505da5a83fe8aad57a3564d:ngit',
      'wss://nos.lol/',
    ],
    ['alt', 'Status change'],
    [
      'p',
      '657c9f566a2627ad76196695361e1d814bdb49e87b90f4db818fb91c59dc142a',
      'wss://relay.damus.io/',
    ],
    ['merge-commit', '715f0fdeca1c7dd68ad144f36112e02cab58a264'],
    ['r', '715f0fdeca1c7dd68ad144f36112e02cab58a264'],
  ],
  content: '',
  sig: 'aea241f5f67ec7851b25a1c3309e922ea858b5f0f4055b5b95e7eddcdd2e46f909fb67d2dc8e94a32a960ffc6e0fa238c80aad7b9b5a915111960a7dd780c57b',
};

/** kind:1618 pull request that {@link NGIT_STATUS_NGIT} targets. */
export const NGIT_STATUS_NGIT_TARGET: NostrEvent = {
  id: 'fabe42e7c41d4e43e3dcc78db20c3859a7696eb6bc655aed852741e074951c48',
  pubkey: '657c9f566a2627ad76196695361e1d814bdb49e87b90f4db818fb91c59dc142a',
  created_at: 1789630888,
  kind: 1618,
  tags: [
    [
      'a',
      '30617:a008def15796fba9a0d6fab04e8fd57089285d9fd505da5a83fe8aad57a3564d:ngit',
      'wss://relay.ngit.dev',
    ],
    [
      'subject',
      'Stabilize release-edit metadata tests without changing release dates',
    ],
    [
      'alt',
      'git Pull Request: Stabilize release-edit metadata tests without changing release dates',
    ],
    ['branch-name', 'release-edit-ordering-fixture'],
    ['r', '26689f97810fc656c7134c76e2a37d33b2e40ce7'],
    ['c', '21e185c74370b43015705e4ff3dd0155e6ba5732'],
    [
      'clone',
      'https://relay.ngit.dev/npub15qydau2hjma6ngxkl2cyar74wzyjshvl65za5k5rl69264ar2exs5cyejr/ngit.git',
    ],
    ['merge-base', '24b90e585a184d14840489ccda008bf0389c6eea'],
    ['p', 'a008def15796fba9a0d6fab04e8fd57089285d9fd505da5a83fe8aad57a3564d'],
  ],
  content:
    'The legacy-release metadata test could fail with replacement_ordering_exhausted after its first edit randomly produced a very low event ID. This caused the unrelated CI failure on the whoami PR.\n\nSplit omission and explicit commit override into independent scenarios. Each starts with a signed predecessor in the upper half of the event-ID space, constructed with a bounded search. Both assert the relay-visible metadata, preserved release date, and lower replacement ID. A separate unit test uses the exact CI predecessor ID to verify the intentional exhaustion error.\n\nThis is a test-only fix. Production keeps its bounded search and date-preservation contract; this does not make arbitrary repeated fixed-date edits always succeed.\n\nValidation: all 22 release integration tests and 17 ordering unit tests pass; all-targets Clippy with warnings denied, formatting, and diff checks pass.\n\nCI failure being addressed: https://blossom.ditto.pub/6ec38c668665ed7201b6aa5eaf0606f226e391ff1aa4c8f614611d7925cb15e6.txt',
  sig: 'cec1e1d7a7e04adec03e5d21078587ea086ea47cd31111721112e58e68b78222a13e2b24edb81a0243b9f069a0c01cfd45f7bdbb12116108eee8880a566a5663',
};
