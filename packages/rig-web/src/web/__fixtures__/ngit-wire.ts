/**
 * Real wire capture from wss://relay.ngit.dev (2026-09-17T16:00:01Z),
 * rig#155 (spec rig#153).
 *
 * Self-contained copy of `packages/rig/src/nip34-fixtures/*.ts` — the SAME
 * captured events, byte-for-byte. This follows the "copy rather than
 * depend" pattern this package already uses for other rig-side logic (see
 * the header of `nip34-parsers.ts`, and `gateway-preference.ts`,
 * `nip-c1-parsers.ts`): `@toon-protocol/rig` is only a DEVELOPMENT
 * dependency of rig-web, resolved through its built `dist/`, which does not
 * exist until `@toon-protocol/rig` has been built. The repo's typecheck gate
 * (`.sandcastle/gate/correctness.ts`, run by CI before `pnpm -r build`) type
 * checks rig-web BEFORE that build happens, so a `import … from
 * '@toon-protocol/rig'` inside anything on rig-web's typechecked surface
 * (i.e. not `tests/e2e/seed/**`, which this repo's `tsconfig.json` already
 * excludes for exactly this reason) fails there even though `pnpm test`
 * alone can look fine locally with a stale `dist/`. Keep this file in step
 * with the rig package's copy; both are produced by the same
 * `scripts/capture-ngit-fixtures.mjs` (repo root) capture, so re-running it
 * and updating both copies is how a re-capture propagates.
 *
 * Captured events:
 *  - kind:30617 announcement (`wyrd` repo): `clone` + role tags `M`/`m`
 *  - kind:30618 repository state (ngit's own `ngit` repo): peeled `^{}` refs
 *  - kind:1621 issue + its five kind:1111 NIP-22 comments (`HydrusUI` repo),
 *    including one NESTED reply
 *  - kind:1631 status (ngit's own repo) in NIP-10 marker form, + its
 *    kind:1618 target
 */

import type { NostrEvent } from '../nip34-parsers.js';

// ---------------------------------------------------------------------------
// kind:30617 — repository announcement (`wyrd`)
// ---------------------------------------------------------------------------

export const NGIT_ANNOUNCEMENT_WYRD_RELAY = 'wss://relay.ngit.dev';
export const NGIT_ANNOUNCEMENT_WYRD_CAPTURED_AT = '2026-09-17T16:00:01Z';
export const NGIT_ANNOUNCEMENT_WYRD_EVENT_ID =
  '5df470edc9067955e707def26b57dbf3c61920ede9c6792ab592d435729192b0';

/**
 * No live event combining `M`, `m` AND `o` together with `clone` was found
 * on relay.ngit.dev at capture time (a relay-wide scan of 597 kind:30617
 * events found exactly one `o`-tagged announcement, and it carried no `M`).
 * This fixture is the richest real combination available: `M` + `m` + `clone`.
 */
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

// ---------------------------------------------------------------------------
// kind:30618 — repository state (ngit's own `ngit` repo)
// ---------------------------------------------------------------------------

export const NGIT_STATE_NGIT_RELAY = 'wss://relay.ngit.dev';
export const NGIT_STATE_NGIT_CAPTURED_AT = '2026-09-17T16:00:01Z';
export const NGIT_STATE_NGIT_EVENT_ID =
  '17fdde63cbc0289e933e6ed232e354cce6713d89e10a793f6d6f9d8ad274ee14';

/** kind:30618 repository state for ngit's own `ngit` repo. */
export const NGIT_STATE_NGIT: NostrEvent = {
  id: '17fdde63cbc0289e933e6ed232e354cce6713d89e10a793f6d6f9d8ad274ee14',
  pubkey: 'a008def15796fba9a0d6fab04e8fd57089285d9fd505da5a83fe8aad57a3564d',
  created_at: 1789656880,
  kind: 30618,
  tags: [
    ['d', 'ngit'],
    ['refs/tags/v1.1.2', 'ada8f00836ec3330047d6a39108b84b7bd234448'],
    ['refs/tags/v3.0.0-rc.7', 'fa86c50cba00596c0de1f1681b6223c71914f78c'],
    ['refs/tags/v3.0.0-rc.6', '23d0d79e63cbfd681d8f95668732ddf727fcf4ab'],
    ['refs/tags/v2.2.0', 'e0213ed04aa5bbec24ed7c8b7de9bdf8057346be'],
    ['refs/tags/v1.0.0^{}', '535be9c1c0a40fdeef9aa3ca84f90b01bc371a22'],
    ['refs/tags/v1.6.1^{}', '3476464013dc2d54030bdec5f9590a3c61dc16c0'],
    ['refs/tags/v2.4.1^{}', '875f4e0a99688c7363cba69c1485af1cd4b34999'],
    ['refs/tags/v3.0.0-rc.6^{}', '3361488d34ad6b80aac68e93207ff8e7d2176b9f'],
    ['refs/tags/v1.6.0^{}', '632af9a091205a0453f0d96a165e1535fd24b2a7'],
    ['refs/tags/v0.1.0', 'ba171a6b14b9d7237a60c4b2089f1fb0b83173cf'],
    ['refs/tags/v2.1.0', '6bc45e30804da0ba1fc2a2727f432ccfc751e1e6'],
    ['refs/tags/v1.0.0', 'ce44cc759858b8dfa9552b01efc8ec00cb7a946a'],
    ['refs/tags/v1.5.1^{}', '51358320c50afece31fc25945a09e3d7aac8f39c'],
    ['refs/tags/v2.0.1', '317fc12b99ee8f5e1df9010b586b31a3f2546372'],
    ['refs/tags/v3.0.0-rc.3^{}', 'd70b3863e89e24a112ebc782fb63c1e05bb3691b'],
    ['refs/tags/v1.3-beta1', 'fc3258fa9dbad5d1fa1c20a0236c1514ea36f97b'],
    ['refs/tags/v1.6.2^{}', '23d0f1232c0b2e7be147f328a55e23aed6641440'],
    ['refs/tags/v1.4.5', 'ea6765741d1aa837318bd1fc6e724383ebef9889'],
    ['refs/tags/v0.0.2', 'e1cf767fde29d696a1ddb3943a5defa68213b6cf'],
    ['refs/tags/v1.5.3', '1b8ff53ed826d1290058e531a7f43c9e3493a9c5'],
    ['refs/tags/v2.6.1', '694642891cbcc23a8173f0fc4a4fcf13eff8acc9'],
    ['refs/tags/v1.4.3^{}', '190b2f622f44c49aa77f8089d9ca9218c0aade81'],
    ['refs/tags/v2.6.0', 'e71a5472652ed8869ec9069ccd388639f8d1234a'],
    ['refs/tags/v1.4.6^{}', 'fce27a10b2161508d35a07ce926e994ae9bb909f'],
    ['refs/tags/v0.1.2', 'adbb992190c29f93e2aa649dac57f1757154af4f'],
    ['refs/tags/v1.1.2^{}', '87ee59ebd91ec4b73b5528446e6d7d87449a9e5d'],
    ['refs/tags/v3.0.0-rc.5', 'f449b229d4ae6a74213e647ab2925e02a28e582f'],
    ['refs/tags/v1.5.0^{}', 'b9ea26bc928c361b092eefde69820c51ebc3a3df'],
    ['refs/tags/v1.7.3^{}', 'bddbcbb97f238760fd346f88bfdd8470f3eddf2a'],
    ['refs/tags/v2.3.0^{}', '45b0f8c6b1dab2d51338d88b2a7caf4b1b571f4d'],
    ['refs/tags/v1.5.2^{}', '12dc5bc06f701308c47589018e932a413ad543ba'],
    ['refs/tags/v1.7.4^{}', '4447aad6378403bba73d738214aa81c50b6d5567'],
    ['refs/tags/v1.4.1', 'bd64e8e8109eb43180c98a25f2d0333f5c7b6af2'],
    ['refs/tags/v1.6.1', 'b3ce4f7a34ec968e8f3eb37ff874cc84b2232861'],
    ['refs/tags/v1.5.1', '1c995b00d0d21597a82627b9157a0f8626c3d858'],
    ['refs/tags/v3.0.0-rc.8', 'cc57418dfbc6d2673f24328ac927a36fdc4a2163'],
    ['refs/tags/v2.5.0^{}', 'd88bce1ab357c74a6cfd153b0cf4a49f25b8dfaa'],
    ['refs/tags/v2.6.0^{}', '7b37d89713e42ea91679d1138d43af1fe9e9341d'],
    ['refs/tags/v2.3.0', '7a7ae1862b1edeaa931e53c0395d8ae392ca557b'],
    ['refs/tags/v1.7.1', 'e70809933fa73016feb45da906e79e511a019a18'],
    ['refs/tags/v3.0.1', '56ddf48e5543ee7d107edbb47253cffb00c90cf8'],
    ['refs/tags/v2.2.3^{}', 'f91a0d00bafe2af1f6b6828c3de3d3e5d65153c3'],
    ['refs/tags/v1.7.2', 'd800a8c43a412f1bc1751f9f86f63ff869bd93b2'],
    ['refs/tags/v0.1.1', '9c1ffe1d084c427c91b581fdb677106b31faeab0'],
    ['refs/heads/tmp', '99b761499e81e79259df521aab9c33a1f11a4c59'],
    ['refs/tags/v1.7.3', 'faf822c49cb0c597595901938dc5ad07c8735d69'],
    ['refs/tags/v2.4.4^{}', '05b0edbff1659689ecc3efbfe36420d64486e2f7'],
    ['refs/tags/v1.4.2', '5635ccf7a664de52f017dcd85f10548fd6ed18f4'],
    ['refs/tags/v1.4.3', '1c6b3ea18ca930067407c9733997af810ccc7188'],
    ['refs/tags/v0.0.2^{}', 'ae6e1f72d9d668783cf27c5f3a88f3cb445f6402'],
    ['refs/tags/v1.5.0', '4a0c01adfb7345ba9feb9a26eb434ea0489c7a81'],
    ['refs/tags/v1.4.0^{}', 'a3073105ae20747fbf76b70cf0ac4ed5c0a9b1b3'],
    ['refs/tags/v2.2.0^{}', '3a17877bcdabc9d6721e3054c2bb07a892f32147'],
    ['refs/tags/v1.4.6', '7335fccd5947bc7f469c9762b45422b5f87985dc'],
    ['refs/tags/v2.4.2^{}', '59e467b423e0ba66c30c7f1b7d41d47d938615de'],
    ['refs/tags/v1.2.0^{}', 'f5c82ee70dc2e881c2b1013f6d352f5da7b08291'],
    ['refs/tags/v2.2.3', 'c6944db92396dcfb7a0e4b8c5ebed475c9435df4'],
    ['refs/tags/v2.4.4', 'b04b58cd1baf4a8db03f72f1162d4950b54489d8'],
    ['refs/tags/v1.5.2', '6cc7ac1aa32a3d54bb091bcf73371d0f6c51e6a3'],
    ['refs/tags/v2.5.0', '02d14a38bb27a279a69ebf3dd34615c95ea49d8b'],
    ['refs/tags/v1.2.1^{}', '1083153ea340b57620870a47ce7653aeae3d1196'],
    ['refs/tags/v1.6.2', 'b76fac50b49aac116b2f1c7965d00b343bedac8f'],
    ['refs/tags/v1.6.3', '423534e17a5d6a2efb412d2b0b5944a270af5f86'],
    ['refs/tags/v3.0.0-rc.5^{}', 'e1d20770b354a39eb8c6ba965ea5d5e822e81610'],
    ['refs/tags/v1.2.0', 'c8728180f959b5e5dca04a926f0e3d0e16e374b5'],
    ['refs/tags/v1.4.4^{}', '76a88f81af435a5c11fa7baf1689c82880fdcd5c'],
    ['refs/tags/v3.0.1^{}', '682b22a34baca24ddd3edde65f7490eb8f91e50c'],
    ['refs/tags/v2.2.1', '6509946b8942f7970d1404310cef8e2f7952b929'],
    ['refs/tags/v1.7.4', '8e54a753cdd2ccba302188d4a398e38cf0d42271'],
    ['refs/tags/v2.1.0^{}', 'd2412565334f48bd31e57d29d7959c24258ccd98'],
    ['refs/tags/v2.0.1^{}', '4a6f51a8245e335cdb276029c4e82c6d6e2798af'],
    ['refs/tags/v3.0.0-rc.8^{}', '7899027ec1715ea5ab0ab2178774c10f39e0a7da'],
    ['refs/tags/v3.0.0-rc.3', '6aeca06ea2933a5a38f73cc29ceda55652cffa16'],
    ['refs/tags/v1.1.1^{}', 'bba5a092b7f07b9a096e2801d51030b186161f80'],
    ['refs/tags/v1.1.0^{}', 'aa36f4e569c9eac7cec101917f87995d6809005e'],
    ['refs/tags/v3.0.0^{}', 'c2cc591dcfae5d46dc178c0ea87e8bc1802f09b3'],
    ['refs/tags/v1.7.1^{}', '6fbbc8ccb8ec330e7963a4333944db69f2e4dc9f'],
    ['refs/tags/v2.4.3', 'c5b0d370b8c980964a77379e33459c2eab642fc2'],
    ['refs/tags/v3.0.0-rc.4^{}', '015dfb79f80dcd07bdf7de6010c00c0754d5d8b4'],
    ['refs/tags/v2.4.3^{}', 'e8c3c49b5bbac43cd1497c2593198d19fe506073'],
    ['refs/tags/v2.2.1^{}', '3017faf6d346fa9328c5979c6e9c6bc471bd3942'],
    ['refs/tags/v0.0.1', '6f33ddda6f4d2a1deb4af72f1ce0fdab365c1cb9'],
    ['refs/tags/v1.3.0', '2c778140d892fd3c8757b078971cb935058b600c'],
    ['refs/tags/v2.0.0', 'f5ad8c320b413b23df80d776217e750765186892'],
    ['refs/tags/v3.0.0-rc.2^{}', '71a8a71313a3a0b029e07bc8a1ed3aa5789255e9'],
    ['refs/tags/v0.1.1^{}', 'fc3f22eac2bb81823f170f61ba9d39baff76b933'],
    ['refs/tags/v1.4.0', 'c280794fa6c70b076e9f121f1f30f9aa0edb0855'],
    ['refs/tags/v0.1.0^{}', '15879248571e2753395ecbeb52e67bd2a9ad9db0'],
    ['refs/tags/v1.7.2^{}', '20f2680394e0b62864b1b192338b3cd7ecdad4ec'],
    ['refs/tags/v1.4.5^{}', '36763dc0d821425e088adefd16dc7c4bf3b30f3b'],
    ['refs/tags/v3.0.0', '695aca4f159938582bc978b257ab78fbf1676612'],
    ['refs/tags/v1.6.0', '10d699134f72a7d4bdad44fb86889a406f9e9acd'],
    ['refs/tags/v1.4.2^{}', 'daaaa3a21277351638eda04739ac3d7b3716f955'],
    ['refs/tags/v1.3.1^{}', '52f9efa50f81142da013c4da5f3cd3091e07916b'],
    ['refs/tags/v2.4.0', 'dc4734acbddb7eba7d55bcbe88a4436b03d89904'],
    ['refs/tags/v2.4.1', 'c0141e567d61c98f9ec92aa004261e821a753104'],
    ['refs/tags/v1.7.0', 'f3609a709a41248337666b7da4db89e7050a4abd'],
    ['refs/heads/stable', '682b22a34baca24ddd3edde65f7490eb8f91e50c'],
    ['refs/tags/v2.4.2', '81d3dd6f90871dbcdf149180dbe43f18d7163f5f'],
    ['refs/tags/v1.3.1', '4172a64be45d1cb038d42011eb9958fab6a30ecd'],
    ['refs/tags/v2.6.2^{}', '4316af88a7ffa2a9d9fe72afbf9b8fd6b1c8568f'],
    ['refs/tags/v1.7.0^{}', '8b182325ad221e06f20b5778fd4963a4b90622c5'],
    ['refs/tags/v0.1.2^{}', '4b66c76a5a3ba878b4603d992353327807b8d8e6'],
    ['refs/tags/v3.0.0-rc.2', '457f018d0d01c6c8607a1b341c573b0668ab4fc5'],
    ['refs/tags/v0.0.1^{}', '7d50d66d21bcaac39ad1d422d1da3167e98f8a40'],
    ['refs/tags/v1.4.1^{}', '09ead86c82f773778b984b5bbbd9798155265cd3'],
    ['refs/tags/v3.0.0-rc.4', '0168bb5fb768e21346e5abbfc04934ed6e824efd'],
    ['refs/tags/v2.4.0^{}', '205ca05897cbc727d9b75e7ab68375b5c93ead39'],
    ['refs/tags/v1.1.1', '16cbf069aea4c0c4ce75bbf6bcea773b8386cd9e'],
    ['refs/tags/v2.6.3^{}', 'a923f6417d236b5472d502cb447c2da5d6b17666'],
    ['refs/tags/v1.6.3^{}', 'd4bc948bfd06a8d61b3deb072db8a70b5ef8a775'],
    ['refs/tags/v2.6.1^{}', '55f3e3a838dffd03f0fdd996103b8dc8c2cddcd6'],
    ['refs/tags/v1.3-beta1^{}', 'ba82a894fad645757c49242c11573b6c5dd8d1e6'],
    ['refs/tags/v2.6.2', 'c49c6410af12b9b53ced477b956a08280fed78bc'],
    ['refs/tags/v1.2.1', '21cabdbd03fa4d2068975db47416c9d7c819c47e'],
    ['refs/tags/v3.0.0-rc.7^{}', '8eb500aded769ad047b07e25c0abe33413f4b500'],
    ['refs/tags/v1.1.0', 'f47d46864b9691e258a83f4e40570e61bd8df9aa'],
    ['refs/tags/v1.4.4', 'bbee90c53e455474d13ba7b0b18670dc0b0ba66f'],
    ['refs/tags/v2.0.0^{}', '9b97fd944f7635cb71b7d5be53369a65a0538ebd'],
    ['refs/tags/v1.3.0^{}', 'd1dab56ad1319b61b5e3f70949780ba98d312ea8'],
    ['refs/tags/v1.5.3^{}', '0089b8fce131c0675539490b67f5a55aab377853'],
    ['refs/tags/v2.6.3', 'ecb8474a1c0d60c4452876920912fc0772c9505d'],
    ['refs/heads/timeout-testing', 'bbdd4387da920ba56065320fdd5a9997bd209e5e'],
    ['refs/heads/main', '715f0fdeca1c7dd68ad144f36112e02cab58a264'],
    ['HEAD', 'ref: refs/heads/main'],
  ],
  content: '',
  sig: '8512128f0ee420a754d1da87771d8fcbb967744e88af6a11f273adfdaa62f517a69ac61774d3841b4db96446700a423c9efda9aa4752cf418220a1dac2e8ba0f',
};

// ---------------------------------------------------------------------------
// kind:1621 issue + kind:1111 comment thread (`HydrusUI` repo)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// kind:1631 status (ngit's own repo) + kind:1618 target
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// All captured events, flattened — for the id/signature verification test.
// ---------------------------------------------------------------------------

export const ALL_NGIT_FIXTURE_EVENTS: NostrEvent[] = [
  NGIT_ANNOUNCEMENT_WYRD,
  NGIT_STATE_NGIT,
  NGIT_COMMENT_THREAD_ROOT,
  ...NGIT_COMMENT_THREAD_COMMENTS,
  NGIT_STATUS_NGIT,
  NGIT_STATUS_NGIT_TARGET,
];
