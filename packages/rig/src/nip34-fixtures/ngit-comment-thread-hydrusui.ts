/**
 * Real wire capture from wss://relay.ngit.dev (2026-09-17T16:00:01Z).
 *
 * A kind:1621 issue on the `HydrusUI` repo (author
 * 43d7f07d10b9e662745e10b2fc201a74dc178a308c31409350d06b04477816e1) and its
 * full kind:1111 NIP-22 comment thread: five comments, including one
 * NESTED reply. Four of the five comments (`e`/`k`/`p`) point straight at
 * the root issue; `NGIT_COMMENT_THREAD_NESTED_REPLY` instead points its
 * lowercase `e`/`k`/`p` at another comment
 * (`NGIT_COMMENT_THREAD_NESTED_REPLY_PARENT_ID`), while its uppercase
 * `E`/`K`/`P` still name the root issue — the shape rig#153's comment
 * builder and readers must produce and accept. Committed byte-for-byte as
 * received — no edited tags, no re-serialization, tag order preserved — so
 * every event's id and signature verify (see `ngit-fixtures.test.ts`).
 *
 * Captured with `scripts/capture-ngit-fixtures.mjs` (repo root); see that
 * file for the exact filter and how to re-run the capture.
 */

import type { NostrEvent } from '../remote-state.js';

export const NGIT_COMMENT_THREAD_RELAY = 'wss://relay.ngit.dev';
export const NGIT_COMMENT_THREAD_CAPTURED_AT = '2026-09-17T16:00:01Z';
export const NGIT_COMMENT_THREAD_ROOT_EVENT_ID =
  '3bb49002757fe697f328a2825fdd00f48a8c376238db65b18906d52864692e2a';
export const NGIT_COMMENT_THREAD_COMMENT_EVENT_IDS = [
  'c7a156e8ced575251d7c6b3b20504d0d8b24b6e88da94a2072680aff9b12fbba',
  '1301e2e3bd9426e1d6919b544f700f43a508bd585acae38ef706cc510c336102',
  '6f815f058c6f627eab6f5324f06cda29163e0232f410abf8eff22de250e188c1',
  '952c1fe0a2e88c3c716b56aa2f695349a77220a211779de30e97b115ba94e084',
  'fdf52ad9ccd8038ca8d0a1ee73e508d3351edd3b80e703953646ee2c83366a1a',
];
/** The one comment in the thread whose parent is another comment, not the root issue. */
export const NGIT_COMMENT_THREAD_NESTED_REPLY_ID =
  '952c1fe0a2e88c3c716b56aa2f695349a77220a211779de30e97b115ba94e084';
export const NGIT_COMMENT_THREAD_NESTED_REPLY_PARENT_ID =
  '6f815f058c6f627eab6f5324f06cda29163e0232f410abf8eff22de250e188c1';

/** kind:1621 issue "Bug: Thumbnail Healing / Transfer" on HydrusUI. */
export const NGIT_COMMENT_THREAD_ROOT: NostrEvent = {
  id: '3bb49002757fe697f328a2825fdd00f48a8c376238db65b18906d52864692e2a',
  pubkey: '43d7f07d10b9e662745e10b2fc201a74dc178a308c31409350d06b04477816e1',
  created_at: 1789629752,
  kind: 1621,
  tags: [
    [
      'a',
      '30617:43d7f07d10b9e662745e10b2fc201a74dc178a308c31409350d06b04477816e1:HydrusUI',
      'wss://relay.yiff.tech/',
    ],
    [
      'p',
      '43d7f07d10b9e662745e10b2fc201a74dc178a308c31409350d06b04477816e1',
      'wss://relay.yiff.tech/',
    ],
    ['subject', 'Bug: Thumbnail Healing / Transfer'],
    ['alt', 'Git issue: Bug: Thumbnail Healing / Transfer'],
    [
      'imeta',
      'url https://blossom.ditto.pub/56d1b8449bb4691af1373df9ce9d13c00cb31827ed7c47775e448e7df96ae981.png',
      'x 56d1b8449bb4691af1373df9ce9d13c00cb31827ed7c47775e448e7df96ae981',
      'ox 56d1b8449bb4691af1373df9ce9d13c00cb31827ed7c47775e448e7df96ae981',
      'size 93750',
      'm image/png',
      'dim 978x596',
      'blurhash L35#^r%jI8x^pMoNW9kDt9R%oLj]',
    ],
  ],
  content:
    "In the case where you have plaintext SHAs on a private blossom server already, there are many times where you couldn't 'heal' or get thumbnails to get moved onto it from within the UI.\n\nWorking on an automated tool that can do it if it ever occurs. For now, the most effective method is to use the multi selector and right click menu, and run 'Regen Previews' \n\nhttps://blossom.ditto.pub/56d1b8449bb4691af1373df9ce9d13c00cb31827ed7c47775e448e7df96ae981.png",
  sig: 'efff5623455271d9866bd2384b1e59476c4e277cbccff4c59b9d73c5e927410379e25a600da9f82447e2a5b78440cdc5d314b64ebdacc3fb5ae80a4c86782e2b',
};

/** kind:1111 top-level comment #1 on the issue. */
const COMMENT_1: NostrEvent = {
  id: 'c7a156e8ced575251d7c6b3b20504d0d8b24b6e88da94a2072680aff9b12fbba',
  pubkey: '43d7f07d10b9e662745e10b2fc201a74dc178a308c31409350d06b04477816e1',
  created_at: 1789629841,
  kind: 1111,
  tags: [
    [
      'E',
      '3bb49002757fe697f328a2825fdd00f48a8c376238db65b18906d52864692e2a',
      '',
      '43d7f07d10b9e662745e10b2fc201a74dc178a308c31409350d06b04477816e1',
    ],
    ['K', '1621'],
    ['P', '43d7f07d10b9e662745e10b2fc201a74dc178a308c31409350d06b04477816e1'],
    [
      'e',
      '3bb49002757fe697f328a2825fdd00f48a8c376238db65b18906d52864692e2a',
      '',
      '43d7f07d10b9e662745e10b2fc201a74dc178a308c31409350d06b04477816e1',
    ],
    ['k', '1621'],
    ['p', '43d7f07d10b9e662745e10b2fc201a74dc178a308c31409350d06b04477816e1'],
  ],
  content:
    'Deploying 2eb6450ace79018d4d3f20f7c9952fa113659029 , trying to build in automatic healing.',
  sig: '6004bdb25dd1437851a8ed325743f335f4f298c5faf3db406706cc419c84182dc107ce4d288f73f05f96000de32be2a19835c9bd21d525330b95876d25276c9d',
};

/** kind:1111 top-level comment #2 (an image share, carries `imeta`). */
const COMMENT_2: NostrEvent = {
  id: '1301e2e3bd9426e1d6919b544f700f43a508bd585acae38ef706cc510c336102',
  pubkey: '43d7f07d10b9e662745e10b2fc201a74dc178a308c31409350d06b04477816e1',
  created_at: 1789630511,
  kind: 1111,
  tags: [
    [
      'E',
      '3bb49002757fe697f328a2825fdd00f48a8c376238db65b18906d52864692e2a',
      '',
      '43d7f07d10b9e662745e10b2fc201a74dc178a308c31409350d06b04477816e1',
    ],
    ['K', '1621'],
    ['P', '43d7f07d10b9e662745e10b2fc201a74dc178a308c31409350d06b04477816e1'],
    [
      'e',
      '3bb49002757fe697f328a2825fdd00f48a8c376238db65b18906d52864692e2a',
      '',
      '43d7f07d10b9e662745e10b2fc201a74dc178a308c31409350d06b04477816e1',
    ],
    ['k', '1621'],
    ['p', '43d7f07d10b9e662745e10b2fc201a74dc178a308c31409350d06b04477816e1'],
    [
      'imeta',
      'url https://blossom.ditto.pub/bb1b398f4e1627336b481ee5825d95317fd48458c786ea855eab803e48d0ea95.png',
      'x bb1b398f4e1627336b481ee5825d95317fd48458c786ea855eab803e48d0ea95',
      'ox bb1b398f4e1627336b481ee5825d95317fd48458c786ea855eab803e48d0ea95',
      'size 8963',
      'm image/png',
      'dim 367x106',
      'blurhash L79O[V}Z1bI:BUS#w{ae0x1H}Fxa',
    ],
  ],
  content:
    'https://blossom.ditto.pub/bb1b398f4e1627336b481ee5825d95317fd48458c786ea855eab803e48d0ea95.png',
  sig: '48442690b282b643d50752c0c22102f191c5a2402e075d92550ac1d1644c390841e3f3aad540974b38f9fd853a46f57712b8a88488c2b06ac12e5308864c2cb6',
};

/** kind:1111 top-level comment #3 (parent of the nested reply below). */
const COMMENT_3: NostrEvent = {
  id: '6f815f058c6f627eab6f5324f06cda29163e0232f410abf8eff22de250e188c1',
  pubkey: '43d7f07d10b9e662745e10b2fc201a74dc178a308c31409350d06b04477816e1',
  created_at: 1789631422,
  kind: 1111,
  tags: [
    [
      'E',
      '3bb49002757fe697f328a2825fdd00f48a8c376238db65b18906d52864692e2a',
      '',
      '43d7f07d10b9e662745e10b2fc201a74dc178a308c31409350d06b04477816e1',
    ],
    ['K', '1621'],
    ['P', '43d7f07d10b9e662745e10b2fc201a74dc178a308c31409350d06b04477816e1'],
    [
      'e',
      '3bb49002757fe697f328a2825fdd00f48a8c376238db65b18906d52864692e2a',
      '',
      '43d7f07d10b9e662745e10b2fc201a74dc178a308c31409350d06b04477816e1',
    ],
    ['k', '1621'],
    ['p', '43d7f07d10b9e662745e10b2fc201a74dc178a308c31409350d06b04477816e1'],
  ],
  content:
    'Currently, it does work to heal a private clear-text blossom server now that has existing submission blobs.\n\nThe UI will attempt to load the thumbnails when you press "Show More" if you have more than the initial set of submissions in your query, attempt to load them, then drop them out of the list. \n\nThis notification will pop-up and grow as the full submission files get pulled from the related endpoint to regenerate the thumbnail, then upload it. Deltas get broadcasted onto the network to notify of the update to the submission.',
  sig: '44763a88f67a5c0020d3b503e73b8229854a9445591fb7f57237ea3f92e8dcdf7ab645f631fd841801b77d6ebce0e2b78ce869ccadac604c5282a45518f69476',
};

/**
 * kind:1111 NESTED reply — lowercase `e`/`k`/`p` point at {@link COMMENT_3},
 * not the root issue, while uppercase `E`/`K`/`P` still name the root.
 */
const NESTED_REPLY: NostrEvent = {
  id: '952c1fe0a2e88c3c716b56aa2f695349a77220a211779de30e97b115ba94e084',
  pubkey: '43d7f07d10b9e662745e10b2fc201a74dc178a308c31409350d06b04477816e1',
  created_at: 1789633147,
  kind: 1111,
  tags: [
    [
      'E',
      '3bb49002757fe697f328a2825fdd00f48a8c376238db65b18906d52864692e2a',
      '',
      '43d7f07d10b9e662745e10b2fc201a74dc178a308c31409350d06b04477816e1',
    ],
    ['K', '1621'],
    ['P', '43d7f07d10b9e662745e10b2fc201a74dc178a308c31409350d06b04477816e1'],
    [
      'e',
      '6f815f058c6f627eab6f5324f06cda29163e0232f410abf8eff22de250e188c1',
      '',
      '43d7f07d10b9e662745e10b2fc201a74dc178a308c31409350d06b04477816e1',
    ],
    ['k', '1111'],
    ['p', '43d7f07d10b9e662745e10b2fc201a74dc178a308c31409350d06b04477816e1'],
  ],
  content:
    "I do need to handle this exception, so that we don't just reset or drop entire pools of submissions you might be looking at while things are healing",
  sig: '315005f83203dcf83cb6cfe507a270e0400d659e3b8af8d8f42fecddc4fc05f1632d9df429e19550453e6961cffb4707e5093e9ece33521fe2ce8beb358d8332',
};

/** kind:1111 top-level comment #5 (thread closing note). */
const COMMENT_5: NostrEvent = {
  id: 'fdf52ad9ccd8038ca8d0a1ee73e508d3351edd3b80e703953646ee2c83366a1a',
  pubkey: '43d7f07d10b9e662745e10b2fc201a74dc178a308c31409350d06b04477816e1',
  created_at: 1789644897,
  kind: 1111,
  tags: [
    [
      'E',
      '3bb49002757fe697f328a2825fdd00f48a8c376238db65b18906d52864692e2a',
      '',
      '43d7f07d10b9e662745e10b2fc201a74dc178a308c31409350d06b04477816e1',
    ],
    ['K', '1621'],
    ['P', '43d7f07d10b9e662745e10b2fc201a74dc178a308c31409350d06b04477816e1'],
    [
      'e',
      '3bb49002757fe697f328a2825fdd00f48a8c376238db65b18906d52864692e2a',
      '',
      '43d7f07d10b9e662745e10b2fc201a74dc178a308c31409350d06b04477816e1',
    ],
    ['k', '1621'],
    ['p', '43d7f07d10b9e662745e10b2fc201a74dc178a308c31409350d06b04477816e1'],
  ],
  content:
    "Closing for now. got the base in by f55d8a42c9fdff59c1982e1835a81ec9cc805043 , added some additional features & polish by 93a4e2f2c259676c75d8170faa0aea384b8719cb\n\nAll the DOM Reloads as thumbnails regenerate & take over do make the client feel laggy if you've got devtools open, but even with 300 thumbnails being processed with tagging events from the bulk uploader, it's so far been stable in it's tab. \n\nIt's much snappier without devtools.\n\nFairly happy with the memory footprint in this state, even if it's chrome. Granted, initial uploads are much heavier in the browser than this.",
  sig: 'f97b7e8638383903e0245fae076f760d4c942949f782804aac437c06e55a9c05aad7de391b4a0a349bf7bcdc1c58d74a3f4348b0ae827af0625b359cc1fef7b2',
};

/** All five kind:1111 comments on the thread, oldest first. */
export const NGIT_COMMENT_THREAD_COMMENTS: NostrEvent[] = [
  COMMENT_1,
  COMMENT_2,
  COMMENT_3,
  NESTED_REPLY,
  COMMENT_5,
];
