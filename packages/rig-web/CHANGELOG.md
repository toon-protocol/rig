# @toon-protocol/rig

## Unreleased

This package is `private` and listed in `ignore` in `.changeset/config.json`, so
`changeset version` never bumps it and never writes to this file. Entries below
this heading are recorded by hand; a changeset file is NOT the way to note a
rig-web change, because an `ignore`d-only changeset is inert and blocks releases
of `@toon-protocol/rig` (see the changeset gate in `.github/workflows/ci.yml`).

- A job page renders the run's live log tail and converges on the record
  (rig#194). While the run is unfinished the page subscribes to the Live Log
  Tail (kind 39841, `docs/specs/nip-c1-live-log-tail.md`) of THAT run — one
  addressable event, addressed by `(39841, coordinator, run-id)` — and renders
  its own job's tail, updating as each replacement arrives with no reload.
  Because the kind is addressable the relay hands back the latest version, so
  a viewer arriving four minutes into a five-minute job sees the current output
  at once. The subscription is scoped to the run being viewed and opened only
  while it is unfinished: browsing the actions list opens none (a test asserts
  no filter the list sends names 39841), and a concluded run asks for nothing —
  it shows the durable job log, so the live view and the record can never
  disagree. The tail is also per-job evidence of execution, so a job of a
  running run that has printed nothing renders as `not started` rather than as
  an empty pane. The runner channel rides in the same event and is shown as the
  runner talking — on the run page and under the job — never as a job, since a
  channel that never concludes would otherwise look like a job that never
  finishes. A run with no live tail at all (an old coordinator, an expired
  event, a run that concluded long ago) renders exactly as it did before:
  absence is never an error. Every live pane says what it is — a rolling view,
  not the record; output that scrolled past between refreshes is in the job log
  a minute later.

- A job of a run has its own page, with its durable job log (rig#190). The run
  page lists every job from the run's first Workflow Progress event — before any
  Job Result exists — and links each to
  `#/<owner>/<repo>/actions/<run-id>/jobs/<job-id>`, so a maintainer can send a
  colleague the job that broke rather than the run and an instruction to scroll.
  A job that has not started, one that is running and one that has concluded are
  three different badges on both pages: the `in-progress` tag names every job
  that has not FINISHED, so `deriveRunJobs` reads a job's state off the run and
  off per-job evidence, never off membership in that tag. The job page reads the
  durable log back from the `logs` URL — the first read of a job log anywhere in
  the repo — through a streaming reader that stops at a 2 MiB client-side
  ceiling (`job-log.ts`), cancels the body there, and says what it did not show
  and by how much, because the coordinator that wrote the blob may not be one
  that bounds its uploads. A job with no `logs` URL renders as a job without a
  log, not as an error.

- `VITE_ARWEAVE_GATEWAY` points rig-web at a self-hosted store gateway (rig#177).
  It is tried ahead of the three public Arweave gateways at
  `<gateway>/raw/<txId>`, with the public list kept behind it as a fallback, and
  `vite.config.ts` splices its origin into the `connect-src`/`img-src` of the CSP
  meta tag in dev and in build. Both halves are needed: with a hardcoded gateway
  list AND a `connect-src` naming only the three public hosts, every repo page
  rendered its relay data and then failed with "Could not resolve commit tree".

- Default the ArNS result URL and the pointer-page asset gateway to mainnet
  ar.io gateways. `ar-io.dev` is ar.io's testnet gateway (its ArNS resolver runs
  against the Solana devnet contracts), so a mainnet name printed as
  `https://<name>.ar-io.dev/` was a guaranteed 404. `RIG_ARNS_GATEWAY` still
  overrides. (Shipped in #104.)

## 0.2.46

### Patch Changes

- @toon-protocol/views@0.20.5

## 0.2.45

### Patch Changes

- @toon-protocol/views@0.20.4

## 0.2.44

### Patch Changes

- @toon-protocol/views@0.20.3

## 0.2.43

### Patch Changes

- @toon-protocol/views@0.20.2

## 0.2.42

### Patch Changes

- @toon-protocol/views@0.20.1

## 0.2.41

### Patch Changes

- @toon-protocol/views@0.20.0

## 0.2.40

### Patch Changes

- @toon-protocol/views@0.19.0

## 0.2.39

### Patch Changes

- @toon-protocol/views@0.18.0

## 0.2.38

### Patch Changes

- Updated dependencies [488cdbf]
  - @toon-protocol/views@0.17.0

## 0.2.37

### Patch Changes

- @toon-protocol/views@0.16.0

## 0.2.36

### Patch Changes

- @toon-protocol/views@0.15.0

## 0.2.35

### Patch Changes

- @toon-protocol/views@0.14.1

## 0.2.34

### Patch Changes

- c116ca8: fix(rig,rig-web)!: honor issue/PR status only from repo owner + declared maintainers (#287)

  Issue/PR status (kind:1630-1633) was resolved naive last-write-wins over ALL
  events regardless of signer, so any funded identity could overwrite another
  owner's issue/PR state. State resolution now honors ONLY status events signed
  by an AUTHORIZED author — the repo OWNER (always) ∪ the MAINTAINERS declared on
  the kind:30617 announcement (a new `["maintainers", <hex>, …]` tag). Unauthorized
  status events are ignored for state (a permissionless relay can still carry them,
  so this is a consumer-side filter).

  - `buildRepoAnnouncement` gains an optional maintainers list; `parseMaintainers` /
    `authorizedStatusAuthors` parse it. `RemoteState.maintainers` and the views
    `RepoMetadata.maintainers` surface it.
  - `deriveStatus` (rig CLI tracker) and `resolvePRStatus` / `resolveIssueStatus`
    (views, used by rig-web) now take an authorized-author set and filter by it.
  - New `rig maintainers list|add|remove <pubkey>` command republishes the 30617
    to manage the set (owner-only, confirm-gated).
  - `rig pr status` / `issue status` warn when the active identity is not a
    maintainer (the write still publishes — permissionless — but the futility is
    made obvious).

  BREAKING: `resolvePRStatus` / `resolveIssueStatus` require a third `authorized`
  argument; `RepoMetadata` / `RemoteState` gain a required `maintainers` field.

- Updated dependencies [c116ca8]
  - @toon-protocol/views@0.14.0

## 0.2.33

### Patch Changes

- Updated dependencies [671c2fc]
  - @toon-protocol/views@0.13.2

## 0.2.32

### Patch Changes

- @toon-protocol/views@0.13.1

## 0.2.31

### Patch Changes

- Updated dependencies [3f30e36]
  - @toon-protocol/arweave@0.2.0
  - @toon-protocol/views@0.13.0

## 0.2.30

### Patch Changes

- @toon-protocol/views@0.12.2

## 0.2.29

### Patch Changes

- Updated dependencies [74a79ca]
- Updated dependencies [4b0d0d2]
- Updated dependencies [d0b5f78]
- Updated dependencies [432eca3]
- Updated dependencies [c0cb407]
- Updated dependencies [5d7f58c]
- Updated dependencies [49a2e31]
  - @toon-protocol/views@0.12.1

## 0.2.28

### Patch Changes

- Updated dependencies [b243c10]
  - @toon-protocol/views@0.12.0

## 0.2.27

### Patch Changes

- Updated dependencies [48205b0]
  - @toon-protocol/views@0.11.0

## 0.2.26

### Patch Changes

- @toon-protocol/views@0.10.9

## 0.2.25

### Patch Changes

- Updated dependencies [0f6fc74]
  - @toon-protocol/views@0.10.8

## 0.2.24

### Patch Changes

- @toon-protocol/views@0.10.7

## 0.2.23

### Patch Changes

- Updated dependencies [139e405]
  - @toon-protocol/views@0.10.6

## 0.2.22

### Patch Changes

- @toon-protocol/views@0.10.5

## 0.2.21

### Patch Changes

- @toon-protocol/views@0.10.4

## 0.2.20

### Patch Changes

- Updated dependencies [9a40ac0]
  - @toon-protocol/views@0.10.3

## 0.2.19

### Patch Changes

- Updated dependencies [686f7a3]
  - @toon-protocol/views@0.10.2

## 0.2.18

### Patch Changes

- Updated dependencies [1afc5c8]
  - @toon-protocol/views@0.10.1

## 0.2.17

### Patch Changes

- Updated dependencies [9073156]
- Updated dependencies [24dad85]
  - @toon-protocol/views@0.10.0

## 0.2.16

### Patch Changes

- Updated dependencies [d93211a]
  - @toon-protocol/views@0.9.1

## 0.2.15

### Patch Changes

- Updated dependencies [0e08607]
  - @toon-protocol/views@0.9.0

## 0.2.14

### Patch Changes

- Updated dependencies [5838b79]
  - @toon-protocol/views@0.8.3

## 0.2.13

### Patch Changes

- @toon-protocol/views@0.8.2

## 0.2.12

### Patch Changes

- Updated dependencies [623bb8e]
  - @toon-protocol/views@0.8.1

## 0.2.11

### Patch Changes

- Updated dependencies [801949d]
- Updated dependencies [98f9e74]
- Updated dependencies [83eb81b]
- Updated dependencies [9a917f5]
- Updated dependencies [6c18a4b]
- Updated dependencies [d0b1055]
  - @toon-protocol/views@0.8.0

## 0.2.10

### Patch Changes

- @toon-protocol/views@0.7.1

## 0.2.9

### Patch Changes

- fec8793: Extract the Arweave gateway preference list into a single shared package `@toon-protocol/arweave` (was hand-duplicated in `views`, `rig`, and `client-mcp`).

  - New private, zero-dep `@toon-protocol/arweave` owns `ARWEAVE_GATEWAYS` + `arweaveTxId` / `arweaveUrls` / `arweaveGatewayCandidates`; `client-mcp` inlines it via tsup `noExternal` so the published bundle keeps zero `@toon-protocol/*` runtime deps.
  - `client-mcp`: upload-side gateway list is now configurable via `TOON_CLIENT_ARWEAVE_GATEWAYS` (comma-separated) > config file > shared default, threaded into `uploadMedia`.
  - `views`: media render imports the shared package (`parsers/arweave.ts` removed); the sandboxed-app CSP `connect`/`resource` domains default to the full gateway list (was `arweave.net` only, which would block ar.io media in the iframe).
  - `rig`: re-exports the shared list/timeout (importers unchanged).

- Updated dependencies [fec8793]
- Updated dependencies [c90d97d]
- Updated dependencies [44da9c9]
- Updated dependencies [2bdb1b5]
  - @toon-protocol/arweave@0.1.1
  - @toon-protocol/views@0.7.0

## 0.2.8

### Patch Changes

- @toon-protocol/views@0.6.1

## 0.2.7

### Patch Changes

- Updated dependencies [9aef6b9]
  - @toon-protocol/views@0.6.0

## 0.2.6

### Patch Changes

- Updated dependencies [f188433]
  - @toon-protocol/views@0.5.0

## 0.2.5

### Patch Changes

- Updated dependencies [1db36cb]
  - @toon-protocol/views@0.4.0

## 0.2.4

### Patch Changes

- Updated dependencies [188ffa0]
  - @toon-protocol/views@0.3.0

## 0.2.3

### Patch Changes

- Updated dependencies [bddc54d]
- Updated dependencies [4f51ba1]
- Updated dependencies [25d0473]
  - @toon-protocol/views@0.2.0

## 0.2.2

### Patch Changes

- Updated dependencies [dcb9c89]
- Updated dependencies [7d9b1db]
  - @toon-protocol/views@0.1.2

## 0.2.1

### Patch Changes

- Updated dependencies [a91f5c5]
  - @toon-protocol/views@0.1.1
