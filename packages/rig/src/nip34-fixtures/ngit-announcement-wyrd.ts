/**
 * Real wire capture from wss://relay.ngit.dev (2026-09-17T16:00:01Z).
 *
 * A kind:30617 repository announcement for ngit's `wyrd` repo. It carries a
 * `clone` tag and the unmerged role tags from nips PR #2324 (`M` — lead
 * maintainer, `m` — maintainer), alongside the conformant `relays`, `web`
 * and `["r", <sha>, "euc"]` earliest-unique-commit tags described in
 * rig#153's Implementation Decisions. Committed byte-for-byte as received —
 * no edited tags, no re-serialization — so its id and signature verify (see
 * `ngit-fixtures.test.ts`).
 *
 * No live event combining `M`, `m` AND `o` together with `clone` was found
 * on relay.ngit.dev at capture time (a relay-wide scan of 597 kind:30617
 * events found exactly one `o`-tagged announcement, and it carried no `M`).
 * This fixture is the richest real combination available: `M` + `m` + `clone`.
 *
 * Captured with `scripts/capture-ngit-fixtures.mjs` (repo root); see that
 * file for the exact filter and how to re-run the capture.
 */

import type { NostrEvent } from '../remote-state.js';

export const NGIT_ANNOUNCEMENT_WYRD_RELAY = 'wss://relay.ngit.dev';
export const NGIT_ANNOUNCEMENT_WYRD_CAPTURED_AT = '2026-09-17T16:00:01Z';
export const NGIT_ANNOUNCEMENT_WYRD_EVENT_ID =
  '5df470edc9067955e707def26b57dbf3c61920ede9c6792ab592d435729192b0';

/** kind:30617 announcement for `wyrd`, as served by relay.ngit.dev. */
export const NGIT_ANNOUNCEMENT_WYRD: NostrEvent = {
  id: '5df470edc9067955e707def26b57dbf3c61920ede9c6792ab592d435729192b0',
  pubkey: 'b3c95ce33dfa84326611e8b7a9c10b78df28754c38b106a4bc0196b9be5f4e4a',
  created_at: 1789554867,
  kind: 30617,
  tags: [
    ['d', 'wyrd'],
    ['r', '2e12ddef8cb4f0adf28518ba7322021379c65a02', 'euc'],
    ['name', 'wyrd'],
    [
      'description',
      '**Wyrd** is a decentralized, append-only, content-addressed drive system.',
    ],
    [
      'clone',
      'https://grasp.t5.st/npub1k0y4eceal2zryes3azm6nsgt0r0jsa2v8zcsdf9uqxttn0jlfe9q04c9h8/wyrd.git',
    ],
    [
      'web',
      'https://gitworkshop.dev/npub1k0y4eceal2zryes3azm6nsgt0r0jsa2v8zcsdf9uqxttn0jlfe9q04c9h8/grasp.t5.st/wyrd',
    ],
    ['relays', 'wss://grasp.t5.st'],
    ['alt', 'git repository: wyrd'],
    [
      'maintainers',
      'b3c95ce33dfa84326611e8b7a9c10b78df28754c38b106a4bc0196b9be5f4e4a',
      '86a314a7ef4aa4fb4e00d738a7bec5fc96ac1312246c7c25888ae609046e6965',
    ],
    ['M', 'b3c95ce33dfa84326611e8b7a9c10b78df28754c38b106a4bc0196b9be5f4e4a'],
    [
      'm',
      '86a314a7ef4aa4fb4e00d738a7bec5fc96ac1312246c7c25888ae609046e6965',
      '1789554803',
    ],
  ],
  content: '',
  sig: '546036757fc3d3857d6d3b80b478ad9c726ce6964d7f7e76dbb5551ce04c8e79e2d2efb90a99f402d50724a2b24749a3a5b952d6406cfb25b57d500f3dac2f11',
};
