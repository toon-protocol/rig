# ngit, NIP-34 and GRASP vs. rig / TOON Protocol

**What this is:** a primary-source account of **ngit** — the Rust CLI and `git-remote-nostr` remote helper that implement git collaboration over nostr — together with the **GRASP** hosting protocol it invented, the **NIP-C1** CI extension it authored, and **gitworkshop.dev**, its browser client. Then a field-level comparison against **rig**, TOON Protocol's git-to-TOON write path.

**Research date:** 2026-09-17. Every live probe is dated inline with its UTC timestamp. Counts move; the numbers here are what the wire returned on that date.

**Why this comparison:** rig and ngit are the two shipping implementations of NIP-34 as a *git transport*. Both put repo state in kind:30617/30618 events on a nostr relay and objects somewhere else. They disagree about where "somewhere else" is (Arweave vs. ordinary git servers), about who pays (ILP micropayments vs. nobody), and — as [§6](#6-field-level-compatibility-would-they-see-each-other) shows in detail — about the literal byte shape of the state event. They also, unexpectedly, share a CI protocol **verbatim**.

**Source discipline.** ngit's source was read from the canonical repository, which is **hosted over nostr, not on GitHub** — cloned at `https://ngit.dev/ngit.git`, which redirects to the GRASP endpoint `https://relay.ngit.dev/npub15qydau2hjma6ngxkl2cyar74wzyjshvl65za5k5rl69264ar2exs5cyejr/ngit.git`. NIP-34 was read from the `nostr-protocol/nips` repository itself, not from any blog or summary. GRASP was read from its own spec repo, likewise cloned over nostr. Relay figures come from raw NIP-01 `REQ` frames I sent myself, paginated to exhaustion where stated. Local citations are repo-relative (`packages/rig/src/push.ts:290`); external repos are `owner/repo:path@sha` or, for nostr-hosted repos, `<repo>:<path>@<sha>` with the clone URL pinned in the reference table. **No secondary source is cited as authority anywhere in this document.** Gaps are marked **UNVERIFIED** in place and collected in [§9](#9-unverified).

**Pinned references**

| Thing | Ref read |
|---|---|
| **ngit** (canonical, nostr-hosted) | `https://ngit.dev/ngit.git` → `relay.ngit.dev/npub15qydau2…/ngit.git`, branch `main`, **HEAD `24b90e585a184d14840489ccda008bf0389c6eea`**, 2026-09-14T15:22:31+0100, author `DanConwayDev <npub15qydau2…@nostr>`. `Cargo.toml` version **3.0.1**, MIT. 113,544 lines of Rust under `src/` |
| **GRASP specs** | `https://ngit.dev/grasp.git`, **HEAD `f35b4f9a4ed2f0aaaf46926e4b1733c79e21b377`**, 2026-08-20. Files `01.md 02.md 03.md 05.md 06.md 08.md` (188 lines total) |
| **ngit-ci** | `https://ngit.dev/ngit-ci.git`, **HEAD `570218745caa734d6f303b8166b0578781d4a1e9`**, 2026-09-12. `Cargo.toml` version 0.1.1 |
| **ngit-docs** | `https://ngit.dev/ngit-docs.git`, **HEAD `3b20d428c199280e2133e70167e7af2f77d9ff61`**, 2026-09-14 |
| **NIP-34** | `nostr-protocol/nips:34.md@master`, fetched raw 2026-09-17, 253 lines |
| NIP-34 maintainer-roles proposal | `nostr-protocol/nips` **PR #2324**, "NIP-34: optional multi-maintainer support", opened 2026-04-25, **still open** on 2026-09-17 |
| NIP-AD (web addresses) | `nostr-protocol/nips` **PR #2406**, opened 2026-07-02, **still open** |
| **NIP-C1** (Nostr CI) | `ngit-ci:NIP.md@5702187` — **md5 `f85123afa184d2b4f259dd318dd507e0`**, byte-identical to `docs/specs/nip-c1.md` in this repo |
| Live GRASP relay NIP-11 | `GET https://relay.ngit.dev/` (`Accept: application/nostr+json`), probed 2026-09-17T14:24Z — `software: ngit-grasp`, `version 3.0.1-31c84730` |
| Live relay corpus | `wss://relay.ngit.dev`, paginated `REQ` by `until`, probed 2026-09-17T14:28Z |
| Live rig corpus | `wss://relay-ws.devnet.toonprotocol.dev`, same method, probed 2026-09-17T14:29Z |
| crates.io `ngit` | `GET https://crates.io/api/v1/crates/ngit`, probed 2026-09-17 — max_version **3.0.0**, 24,869 downloads |
| GitHub mirror | `GET https://api.github.com/repos/DanConwayDev/ngit-cli`, probed 2026-09-17 — 68★, MIT, `pushed_at 2026-09-10T15:19:10Z`, **not archived** |
| **rig** (this repo) | HEAD **`f96ae480d95e29625b1a2d4c279c7222b03e6bcc`**, branch `main`, 2026-09-16; `@toon-protocol/rig` **4.5.0** |

---

## Verdict

- **ngit is not a competitor to rig so much as the incumbent implementation of the protocol rig is a second implementation of — and it is roughly two orders of magnitude larger in live usage.** On 2026-09-17 a full paginated enumeration of `wss://relay.ngit.dev` returned **2,530 distinct kind:30617 repo coordinates from 743 distinct pubkeys**, oldest 2024-11-12, newest that same day at 12:57Z. The same query against rig's devnet relay returned **30 coordinates from 15 pubkeys, newest 2026-08-28**, with names like `rig-c2x-smoke` and `rigtest`. ngit's issue traffic alone (3,118 kind:1621 events from 268 authors) exceeds rig's entire event corpus by two orders of magnitude. Details in [§5](#5-state-of-the-project-2026-09-17).

- **rig and ngit are mutually blind at kind:30618, completely, over a one-word difference.** NIP-34 says the ref tag's *name* is the ref path: `["refs/heads/main", "<sha>"]`. ngit emits exactly that (verified on the wire, `relay.ngit.dev`, 2026-09-17T14:27Z) and its parser accepts only tags whose name starts with `refs/heads/`, `refs/tags` or `HEAD` (`ngit:src/lib/repo_state.rs:30-33`). rig emits `["r", "refs/heads/main", "<sha>"]` (`packages/rig/src/nip34-events.ts:244`) and its parser accepts only tags *named* `r` (`packages/rig/src/remote-state.ts:353-361`). **Each side parses exactly zero refs from the other's state event.** The single compatible field is `HEAD`, which both write and both read as `["HEAD", "ref: refs/heads/main"]`. rig is the side that departs from the NIP here. [§6.1](#61-kind30618--total-mutual-blindness).

- **ngit could discover a rig repo and then be unable to do anything with it, because rig's kind:30617 carries no `clone` tag.** Verified on the wire: a real rig announcement's complete tag set is `d`, `name`, `description` — nothing else (`relay-ws.devnet.toonprotocol.dev`, 2026-09-17T14:29Z). rig never emits `clone`, `relays`, `web`, or the `["r", "<sha>", "euc"]` fork-identity tag; the string `euc` does not occur anywhere in `packages/`. ngit's whole fetch path is "read signed refs, then pull objects from the servers in `clone`" — with no `clone` there is no fetch. rig's objects are on Arweave behind a rig-invented `["arweave", "<sha>", "<txid>"]` tag that no other NIP-34 client knows how to read. [§6.2](#62-kind30617--discoverable-but-not-clonable).

- **But rig and ngit already share a CI protocol verbatim, and that is the strongest interop asset either project has.** rig's vendored `docs/specs/nip-c1.md` is **byte-identical** to `ngit-ci:NIP.md@5702187` (md5 `f85123afa184d2b4f259dd318dd507e0`), as is the companion guidance file. Both implement kinds 9840/9841/9842/9843/9844/19843/29846/39842 with the same meanings, and rig's own source states the intent: *"this module adopts it VERBATIM … so ngit tooling keeps reading rig's events and rig keeps reading ngit-ci's"* (`packages/rig/src/ci/nip-c1-events.ts:1-6`). This is live: 4,158 kind:9842 Workflow Results from 16 coordinator keys exist on `relay.ngit.dev`, with 9 kind:39842 progress markers in flight at probe time. [§6.4](#64-nip-c1--byte-identical-and-the-one-real-bridge).

- **ngit does not put git objects on relays, and never has. Objects ride ordinary git smart-HTTP; nostr carries only signed refs.** ngit's own docs state the split as a two-row table — *"State (refs) → nostr relays, as signed events → **The source of truth**"* / *"Data (objects) → ordinary git servers → **Interchangeable storage**"* — and draw the conclusion explicitly: *"the git server is no longer authoritative, it's a cache"* (`ngit-docs:docs/how-it-works.md`). Live confirmation: of 2,530 announcements, **2,528 carry a `clone` tag and exactly one of those URLs uses `nostr://`**; the rest are plain HTTPS, and **150 repos name `github.com` as a clone host**. ngit can and does use GitHub as dumb object storage. [§3](#3-how-objects-move).

- **GRASP is the genuinely novel piece and has no analogue in rig.** GRASP — *Git Relays Authorized via Signed-Nostr Proofs* — is a six-document spec family for a server that is a NIP-01 relay and a git smart-HTTP server *in the same process*, so the signed state and the objects it names arrive at one endpoint. The load-bearing rule is one sentence in `grasp:01.md`: *"MUST accept pushes via this service that match the latest repo state announcement on the relay, respecting the recursive maintainer set."* That makes the hosting server the authority-enforcement point — permissionless to read, but push-authorized against a maintainer signature. It also defines **purgatory** (`grasp:01.md`): state events are accepted but not served until the matching git data arrives, which is a real two-phase-commit for the state/object race. Capabilities are advertised in NIP-11 as `supported_grasps` (live: `["GRASP-01","GRASP-02","GRASP-03","GRASP-06"]` on `relay.ngit.dev`). [§3.2](#32-grasp).

- **ngit ships an unmerged NIP-34 extension that deprecates the exact tag rig's authority model is built on.** ngit emits indexed role tags `["M", "<lead>"]`, `["m", "<co-maintainer>"]`, `["o", "<moderator>"]` with optional timestamp-pair history and a `defer` sentinel (`ngit:src/lib/repo_ref.rs:243-266`, `:generate_role_tags`). These are `nostr-protocol/nips` **PR #2324, still open**, whose text says *"If an announcement contains `M`, `m`, or `o`, clients MUST ignore `maintainers`."* rig's entire status-authority model is `authorizedStatusAuthors()` reading the `maintainers` tag (`packages/rig/src/nip34-events.ts:83-91`). ngit still emits a `maintainers` compatibility tag deliberately (`repo_ref.rs`, `compatibility_tag`), so rig is not broken today — but it is coded to the deprecated path. Adoption is still early: of 2,530 live announcements only ~20–24 in a 500-event sample carry role tags. [§2.3](#23-the-maintainer-model--ngits-largest-deviation).

- **ngit's trust model is stronger than rig's on maintainer authority and weaker on nothing, except that rig verifies objects itself.** ngit requires an invited maintainer to *publish an acceptance* before their state becomes authoritative — the breaking change that forced ngit v3, ngit-grasp v3 and GitWorkshop v4 to ship together (`ngit-docs:docs/v3/maintainer-model.md`). rig has no invitation handshake: listing a pubkey in `maintainers` grants status authority immediately. Conversely rig re-hashes every fetched object body against its expected SHA-1 *before* writing (`packages/rig/src/object-fetch.ts:108-125`) and again via `git hash-object -w` (`packages/rig/src/materialize.ts:109-142`); ngit delegates that to git's own index-pack. Both are sound — git's content-addressing is the real guarantee in each case — but rig's is explicit and gives a better error. [§4](#4-auth-identity-and-trust).

- **rig is better engineered on payment, object durability, and the read path; ngit is better on everything a user touches.** rig has a real settled payment channel, per-object Arweave permanence, a fast-forward check that runs before money moves (`packages/rig/src/push.ts:285-312`), and SHA verification it owns. ngit has a remote helper so `git clone`/`git push` Just Work, a `nostr://` URL scheme, a PR model with a one-rule convention (`a branch becomes a pull request only if its name starts with pr/`), issues, labels, cover notes, releases, OCI containers, private repos, NIP-46 bunker signing, an OS-keychain credential store, and zero onboarding cost. **rig has no git remote helper and no URL scheme at all** — `packages/rig/package.json` exposes one bin, `rig`, and grepping `packages/` for `git-remote`, `toon://` or `rig://` returns nothing. [§7](#7-what-each-does-better).

- **The thing rig should steal first is the ref tag shape, and it is a two-line change.** Emitting `[refPath, sha]` alongside (or instead of) `['r', refPath, sha]` in `buildRepoRefs` would make every rig repo's state readable by ngit, gitworkshop and every other NIP-34 client, at the cost of nothing. Adding `clone`, `relays` and `["r", "<root-commit>", "euc"]` to `buildRepoAnnouncement` would make rig repos *discoverable and groupable* in the existing ecosystem. Second: rig's 30617 republish is **lossy** — `rig maintainers` and `rig payout` rebuild the announcement from five fields and silently drop any tag `buildRepoAnnouncement` cannot emit (`packages/rig/src/cli/maintainers.ts:321-327`, `cli/payout.ts:328-334`), so even if rig started reading `clone` tags it would destroy them on the next maintainer edit. [§8](#8-what-rig-should-steal-and-what-rig-is-getting-wrong).

- **One latent scaling bug in rig has no counterpart in ngit, because ngit made the opposite architectural choice.** rig's sha→txid map lives entirely in `["arweave", …]` tags on a single replaceable kind:30618, merged cumulatively on every push and **bounded by nothing** — `MAX_REFS_PER_EVENT = 1000` caps `r` tags but there is no equivalent constant for `arweave` tags on either the write or read side. A repo with 50,000 objects wants a 50,000-tag event. ngit's state event carries only refs — its `ngit` repo's own live 30618 (probed 2026-09-17T14:27Z) has ~129 tags covering every branch and every `v*` tag including peeled `^{}` entries, and that number grows with *refs*, not with objects, because object location is a URL rather than a per-object mapping. [§8.2](#82-what-rig-is-getting-wrong-or-missing).

---

## 1. What ngit actually is

### 1.1 The three artifacts and how they relate

| | What it is | Where it lives |
|---|---|---|
| **`ngit`** | The Rust CLI: `init`, `send`, `list`, `pr`, `issue`, `ci`, `release`, `container`, `nsite`, `account`, `sync`, `repo`. 113,544 lines of Rust. | `ngit:src/bin/ngit/` |
| **`git-remote-nostr`** | A **remote helper** git discovers by filename whenever it meets a `nostr://` URL. It is a thin launcher — the README states: *"`git-remote-nostr` is a small compatibility launcher that git discovers by name; the implementation lives in `ngit`, so both need installing together."* | `ngit:src/bin/git_remote_nostr.rs`, implementation in `ngit:src/bin/ngit/git_remote_helper/{list,fetch,push}.rs` |
| **`gitworkshop.dev`** | A browser client, **not a server that owns anything**. ngit's own docs: *"one browser client in the GitNostr ecosystem. It is an interface to open protocols, not a forge that owns your repository"* (`ngit-docs:docs/ecosystem/gitworkshop.md`). Served from Netlify as a client-rendered SPA; `<title>gitworkshop - Decentralized Git</title>` (probed 2026-09-17T14:30Z). | Announced on nostr by the same pubkey as ngit |

The relationship is deliberately non-hierarchical. `ngit-docs:docs/how-it-works.md` states: *"Nothing in ngit depends on [gitworkshop] being up."* Both read the same signed events.

Beyond those three there are sibling repos, all reachable at `https://ngit.dev/<name>.git`: **`ngit-grasp`** (the reference GRASP server, a.k.a. ngit-relay), **`ngit-ci`** (the reference CI coordinator), **`ngit-indexer`**, **`ngit-docs`**, and **`grasp`** (the spec repo).

### 1.2 Maintainer, license, language

- **Maintainer:** one person. `ngit:Cargo.toml` — `authors = ["DanConwayDev <DanConwayDev@protonmail.com>"]`. `ngit:maintainers.yaml` lists exactly one maintainer pubkey, `npub15qydau2hjma6ngxkl2cyar74wzyjshvl65za5k5rl69264ar2exs5cyejr` (hex `a008def15796fba9a0d6fab04e8fd57089285d9fd505da5a83fe8aad57a3564d`), and four relays: `wss://relay.damus.io`, `wss://relay.ngit.dev`, `wss://gitnostr.com`, `wss://ngit.danconwaydev.com`. The same pubkey signs the `gitworkshop` and `grasp` announcements.
- **License:** MIT. `ngit:LICENSE.md` — *"Copyright (c) 2023 DanConwayDev"*. GRASP, ngit-ci and ngit-docs each carry their own `LICENSE`.
- **Language:** Rust, edition 2021. Key deps (`ngit:Cargo.toml`): `nostr 0.45.4`, `nostr-sdk 0.45.2`, `nostr-connect 0.45.1` (NIP-46), `nostr-lmdb 0.45.2` (local event cache), `git2 0.21.0` (libgit2, with `ssh` + `https`), `keyring 4.1.6` (OS credential store), `rustls 0.23.43` with Ring.

### 1.3 Where the canonical source lives — the nostr repo, not GitHub

This is worth stating precisely because ngit is self-hosting and the GitHub copy is a live decoy.

- `ngit:Cargo.toml` declares `repository = "https://ngit.dev/ngit.git"` — and crates.io echoes that field verbatim (probed 2026-09-17).
- Cloning that URL emits `warning: redirecting to https://relay.ngit.dev/npub15qydau2…/ngit.git/` — i.e. the canonical remote **is a GRASP endpoint**, `/<npub>/<identifier>.git` per `grasp:01.md`.
- The nix install path is `nix profile add 'git+https://ngit.dev/ngit.git?ref=stable'`.
- **GitHub `DanConwayDev/ngit-cli` exists, is MIT, has 68★ / 8 forks, and is NOT archived** — but `pushed_at` is `2026-09-10T15:19:10Z` while the nostr repo's HEAD is `2026-09-14T15:22:31+0100`. The mirror was four days stale at probe time. Its open-issue count is **0**, and its README directs collaboration to `gitworkshop.dev/danconwaydev.com/ngit`. There is no explicit "this has moved" notice — the migration is de facto, not declared.
- `DanConwayDev/gitworkshop.dev` **does not exist** (HTTP 404); the GitHub name is `DanConwayDev/gitworkshop`, and DanConwayDev's own canonical announcement for it lists no GitHub clone URL at all.

**Conclusion: the nostr/GRASP repo is canonical; GitHub is a release-artifact mirror.** The `git log` author identity is itself nostr-native — `DanConwayDev <npub15qydau2…@nostr>` — which is how `ngit` writes commit authorship.

---

## 2. The protocol it implements

### 2.1 NIP-34 as written

Read from `nostr-protocol/nips:34.md@master` (253 lines, fetched 2026-09-17). Status line: `` `draft` `optional` ``. The complete kind set:

| Kind | Event | Class | Key tags (verbatim from the NIP) |
|---:|---|---|---|
| **30617** | Repository announcement | addressable | `d` (repo-id, the only required tag), `name`, `description`, `web`, `clone`, `relays`, `["r","<earliest-unique-commit-id>","euc"]`, `maintainers`, `u` (subordinate fork), `t` |
| **30618** | Repository state | addressable | `d`; **`["refs/<heads\|tags>/<name>","<commit-id>"]`** — *the tag name is the ref path*; `["HEAD","ref: refs/heads/<branch>"]` |
| **1617** | Patch | regular | `content` = `git format-patch` output; `a` (`30617:<pubkey>:<id>`), `r` (euc), `p`, `t` = `root` / `root-revision`, plus optional `commit`, `parent-commit`, `commit-pgp-sig`, `committer` for stable commit ids |
| **1618** | Pull request | regular | `content` = markdown; `a`, `r`, `p`, `subject`, `t`, **`c` = tip commit**, **`clone` = at least one URL where the commit can be downloaded**, `branch-name`, `e` (revision-of), `merge-base` |
| **1619** | PR update | regular | NIP-22 `E` (PR event id) + `P` (PR author); `c` = updated tip, `clone`, `merge-base` |
| **1621** | Issue | regular | `content` = markdown; `a`, `p`, `subject`, `t` |
| **1630–1633** | Status: Open / Applied-Merged / Closed / Draft | regular | `["e","<root-id>","","root"]`, `p`×N, optional `a`, `r`, `q`, `merge-commit`, `applied-as-commits` |
| **10317** | User grasp list | replaceable | `g` = grasp service websocket URLs, in preference order |

Two NIP-level rules that matter downstream:

- *"Patches SHOULD be used if each event is under 60kb, otherwise PRs SHOULD be used."*
- *"The most recent Status event (by `created_at` date) from either the issue/patch author or a maintainer is considered valid."*

The `nostr://` scheme is **in the NIP itself** (added by merged PR #2312): `nostr://<naddr>`, `nostr://<npub|nip05>/<identifier>`, `nostr://<npub|nip05>/<relay-hint>/<identifier>`, with relay-hint and identifier percent-encoded per RFC 3986 §2.1. One of the NIP's own examples is literally ngit's repo: `nostr://npub15qydau2hjma6ngxkl2cyar74wzyjshvl65za5k5rl69264ar2exs5cyejr/relay.ngit.dev/ngit`.

**Note that kind:10317 names GRASP inside the NIP.** GRASP is not purely an ngit side-protocol; NIP-34 already assumes it exists.

### 2.2 What ngit implements, and the kinds it adds

ngit implements every kind above. Constants at `ngit:src/lib/git_events.rs:154-166` and `ngit:src/lib/client.rs:3759`:

```rust
pub const KIND_PULL_REQUEST: Kind = Kind::Custom(1618);
pub const KIND_PULL_REQUEST_UPDATE: Kind = Kind::Custom(1619);
pub const KIND_USER_GRASP_LIST: Kind = Kind::Custom(10317);
pub const KIND_PRIVATE_GIT_RELAY_LIST: Kind = Kind::Custom(10318);
pub const KIND_COMMENT: Kind = Kind::Custom(1111);   // NIP-22
pub const KIND_LABEL: Kind = Kind::Custom(1985);     // NIP-32
pub const KIND_COVER_NOTE: Kind = Kind::Custom(1624);
```

Beyond NIP-34 proper, ngit uses:

| Kind | Purpose | Source | In a NIP? |
|---:|---|---|---|
| 1111 | Threaded comments on issues/patches/PRs | `git_events.rs:159` | Yes — NIP-22, and NIP-34 §Replies mandates it |
| 1985 | Labels applied after the fact | `git_events.rs:162` | Yes — NIP-32 |
| **1624** | **Cover note** — a markdown note attached to a PR/patch/issue by its author or a maintainer, latest-authorized-wins | `git_events.rs:166` | **No — ngit invention** |
| **10318** | **Private git relay list** — NIP-51 list whose `g` tags are NIP-44-encrypted in `content` | `git_events.rs:157` | **No — defined in `grasp:08.md`** |
| 27235 | NIP-98 HTTP auth for private GRASP git endpoints | `git_http_auth.rs:17` | Yes — NIP-98, with GRASP-08 relaxations |
| 30624 | OCI container repository (addressable) | `src/lib/oci.rs:3` | Out of scope here |
| 32267 / 35128 | Application coordinate / nsite | `release/write.rs:1423`, `nsite.rs:74` | Out of scope here |
| 9840–9844, 19843, 19844, 29846, 39842, 39844 | **NIP-C1 CI** | `src/lib/ci/kinds.rs` | See [§2.5](#25-nip-c1--the-ci-extension) |

### 2.3 The maintainer model — ngit's largest deviation

NIP-34 as merged has a flat `["maintainers", pk, pk, …]` tag and nothing else. ngit ships a considerably richer model that is **`nostr-protocol/nips` PR #2324, opened 2026-04-25 and still open on 2026-09-17**.

**Role tags.** From the PR text:

```
["M", "<lead-maintainer>"]     // lead from the beginning, still active
["m", "<co-maintainer>"]       // co-maintainer from the beginning, still active
["o", "<moderator>"]           // moderator from the beginning, still active
["maintainers", …]             // deprecated fallback for clients without role support
```

and, critically: *"If an announcement contains `M`, `m`, or `o`, clients MUST ignore `maintainers`."*

**Role history.** Values after the pubkey are alternating start/end unix timestamps, with a `defer` sentinel permitted only as the final end value. ngit's parser is `ngit:src/lib/repo_ref.rs:243-266`:

```rust
/// `defer` is accepted only as the final value in an end position. Any other
/// non-numeric boundary makes the record invalid and therefore unable to
/// grant authority.
fn role_boundaries(slice: &[String]) -> Option<Vec<RoleBoundary>> {
```

PR #2324's examples: `["m","<pk>","0","<end>"]` (founding, then removed), `["m","<pk>","<start>","<end>","<start2>"]` (removed, then re-added), `["m","<pk>","<start>","defer"]` (retained history, not a current assignment).

**Recursive / reciprocal membership.** PR #2324: *"A repository's members form a recursive, reciprocal set of announcements sharing the same `d` tag… A pubkey in an active `M`/`m` entry, or a legacy `maintainers` tag, is **invited** until its announcement acknowledges the role and assigns a role to an existing member."* ngit calls the merged result a **virtual repository** and implements the acceptance handshake as `ngit repo accept` (`ngit:src/lib/accept_maintainership.rs`, `src/bin/ngit/sub_commands/repo/accept.rs`).

**Why this shipped as a breaking change.** `ngit-docs:docs/v3/maintainer-model.md` is unusually candid about the vulnerability it fixes:

> "Before v3, merely inviting a maintainer who already had such a fork could make the fork's state authoritative in the inviting repository before they agreed to join. Their next ordinary push to their fork could replace the refs users saw for the inviting repository… No one had to run `git push --force`."

This forced the coordinated ngit v3 / ngit-grasp v3 / GitWorkshop v4 release. **It is a real attack on the flat `maintainers` model that rig currently implements** — see [§8.2](#82-what-rig-is-getting-wrong-or-missing).

**Backwards compatibility is preserved on purpose.** `ngit:src/lib/repo_ref.rs` (`to_event`) computes a `compatibility_tag`:

```rust
let compatibility_maintainers = active_maintainer_projection(&generated_role_tags);
let compatibility_tag = (!implicit_sole).then(|| Tag::parse([vec!["maintainers"…], …]))
```

so a `maintainers` tag is still emitted, projected from the active `M`/`m` entries — unless the repo is `implicit_sole` (one maintainer, who is the author), in which case no roster tag is emitted at all, exactly as plain NIP-34 prescribes.

**Adoption is early.** In a 500-event sample from `relay.ngit.dev` (2026-09-17T14:27Z), **24 announcements carried `M`/`m`/`o` role tags and 339 carried `maintainers`**; on `gitnostr.com`, 20 and 406.

### 2.4 Other ngit extensions to kind:30617

`ngit:src/lib/repo_ref.rs` (`is_known_tag_name`) enumerates every tag ngit round-trips through a typed field — anything else is preserved verbatim in `extra_tags`:

```rust
"d" | "name" | "description" | "clone" | "web" | "u" | "r" | "relays"
| "t" | "blossoms" | "maintainers" | "private" | "alt" | "M" | "m" | "o"
```

Three of those are not in NIP-34:

- **`["private","true"]`** — defined in `grasp:08.md`: *"A repository is private if any kind 30617 announcement in its recursive maintainer set includes the tag `["private","true"]`."* Clients MUST then publish repo events only to the announcement's `relays`, never to NIP-65 inbox/outbox.
- **`["blossoms", url, url, …]`** — preferred Blossom servers for the repo's binary artifacts (releases, containers). Not a git-object store; see [§3.3](#33-blossom).
- **`["alt", "git repository: <name>"]`** — NIP-31 human-readable fallback.

**The `d` tag default is itself an ngit convention.** `repo_ref.rs` (`to_event`) carries the reasoning in a comment quoting the NIP's author:

```rust
// an identifier based on first commit is better so that users dont
// accidentally create two seperate identifiers for the same repo
// … fiatjaf suggested the first 6 character of the commit id
// here we are using 7 which is the standard for shorthand commit id
self.root_commit.to_string()[..7].to_string()
```

### 2.5 NIP-C1 — the CI extension

ngit authored a CI NIP. `ngit-ci:README.md` calls itself *"The reference coordinator for Nostr CI, the CI extension to NIP-34 published as NIP-C1."* It is **not** in `nostr-protocol/nips`; it is published as a nostr long-form event on nostrhub, with `ngit-ci:NIP.md` as its source. Status line: `` `draft` `optional` ``.

| Event | Kind | NIP-01 class | Publisher | Lifetime |
|---|---:|---|---|---|
| Coordinator Advertisement | 19843 | replaceable `(kind,pubkey)` | coordinator | ≤ 30 min |
| Request-Readiness List | 19844 | replaceable | coordinator | ≤ 24 h |
| Coordinator Repository Status | 39844 | addressable `(kind,pubkey,d)` | coordinator | ≤ 24 h |
| Service Request | 9843 | regular | requester | no expiry |
| Service Stop | 9844 | regular | requester | no expiry |
| Repository Secret Update | 29846 | **ephemeral** | maintainer | not retained |
| Manual Trigger | 9840 | regular | maintainer | no expiry |
| Job Result | 9841 | regular | compute provider | no expiry |
| Workflow Result | 9842 | regular | coordinator | no expiry |
| Workflow Progress | 39842 | addressable | coordinator | ≤ 30 min |

Workflows live in-repo at `.ngit/act/workflows/*.yml` in GitHub Actions syntax, executed by `act` (`ngit-ci:README.md`). PR-triggered CI events carry NIP-22 `E` (PR root) + `e` (source) + `c` (commit); push-triggered events carry `r` instead (`ngit:docs/architecture/ci-trust.md`).

**Trust is explicitly a client-side classification, not a score.** `ngit:docs/architecture/ci-trust.md`: *"Classifications: `MaintainerDirected` > `OperationallyAssociated` > …"*, with *"Evidence, not scores… empty list = `NoKnownContext` (absence of evidence, never 'untrusted')."* rig's `CONTEXT.md` reuses the same four levels verbatim: *"maintainer-directed, operationally-associated, seen-in-network, or no-known-context."*

### 2.6 `.ngit/` is not state — a correction

The `.ngit/` directory is an **in-repo configuration directory checked into git**, not a client state store:

- `.ngit/containers.yaml` — `ngit:src/lib/container_manifest.rs:19`
- `.ngit/release.yaml` — `ngit:src/lib/release_manifest.rs:21`
- `.ngit/act/workflows/*.yml` — `ngit:src/lib/ci/kinds.rs:1127`

ngit's actual client state lives elsewhere: an LMDB event cache (`nostr-lmdb`) at `NGIT_CACHE_DIR` or the platform data dir, plus per-repo caches inside `.git`, plus credentials in the OS keychain or `~/.local/share/ngit/credentials.json` (`ngit:docs/credential-storage.md`).

### 2.7 The `pr/` branch convention

Not in NIP-34 at all; it is a pure ngit UX convention, and it is the single most important thing ngit does for usability. `ngit:README.md`:

> "remote branches beginning with `pr/` are open PRs from contributors… to open a PR, push a branch with the prefix `pr/` or use `ngit send` for advanced options"

Implementation: the remote helper strips `refs/heads/pr/*` from the state it derives from kind:30618 (`ngit:src/bin/ngit/git_remote_helper/list.rs:132`) and synthesizes them from PR events instead — `format!("pr/{}", cover_letter.branch_name_without_id_or_prefix)` (`list.rs:414`) and `refs/pr/<proposal-id>/head` (`list.rs:467`). Since v3 these are **not** auto-fetched: `nostr.auto-pr-branches` defaults to `false`, and `ngit pr checkout <id>` creates a local `pr/<branch-name>(<shorthand-id>)` (`ngit:README.md`).

So: **`git push origin pr/my-feature` opens a pull request.** No web UI, no API token, no fork.

---

## 3. How objects move

### 3.1 The answer: ordinary git servers, always

**ngit pushes git objects to ordinary git servers over ordinary git protocols. Nostr carries refs and collaboration events only.** There is no path in the codebase that puts a git object in a nostr event.

The canonical statement is `ngit-docs:docs/how-it-works.md`:

| | Lives on | Role |
| --- | --- | --- |
| **State (refs)** | nostr relays, as signed events | The source of truth |
| **Data (objects)** | ordinary git servers | Interchangeable storage |

> "When you `git fetch`, `git-remote-nostr` reads the current ref state from the relays, then fetches the matching objects from whichever git servers the repository announcement lists. Because the refs are signed by the maintainer and replicated across relays, **the git server is no longer authoritative, it's a cache.**"

`ngit:src/lib/push.rs` (`push_to_remote`) takes a `git_server_url`, parses it as a `CloneUrl`, and attempts a list of protocols — `ServerProtocol::{Ssh, Https, Http, Git, Ftp, Filesystem}` (`ngit:src/lib/git/nostr_url.rs:16-24`) — via `libgit2` with `auth-git2`. That is a plain `git push`.

**Live evidence, 2026-09-17.** Across the 2,530 enumerated announcements on `relay.ngit.dev`, **2,528 carry a `clone` tag**, and the scheme breakdown of those URLs is `https` 6,148 / `http` 25 / `htree` 2 / **`nostr` 1** / none 1. Top clone hosts: `relay.ngit.dev` (2,516), `git.shakespeare.diy` (1,385), `gitnostr.com` (1,103), `git.nostrhub.io` (256), `ngit.danconwaydev.com` (163), **`github.com` (150)**, `pyramid.fiatjaf.com` (111), `gitlab.com` (27).

So `nostr://` is a *client-side addressing scheme only* — the announcement it resolves to advertises concrete HTTPS git endpoints. And **150 repos use GitHub as their object store while keeping identity, refs, issues and PRs on nostr**, which is exactly the "keep the project, change the provider" thesis of `ngit-docs:docs/why-ngit.md`.

### 3.2 GRASP

**GRASP = Git Relays Authorized via Signed-Nostr Proofs.** `grasp:README.md`:

> "Grasp is a protocol like blossom, but for git. There may be many grasp servers anywhere -- like Blossom servers -- that host repositories from anyone… and your pushes are pre-authorized by publishing a Nostr event beforehand that says what is your repository state."

Six documents; **GRASP-01 is required, everything else optional.**

**GRASP-01 — Core Service Requirements.** A single service that is both:

1. *A NIP-01 relay at `/`* that MUST accept kind:30617 and kind:30618, and MUST reject announcements *"that do not list the service in both `clone` and `relays` tags"* unless implementing GRASP-05.
2. *A git smart-HTTP service at `/<npub>/<percent-encoded-identifier>.git`*, unauthenticated for reads.

The authorization rule is the heart of the protocol:

> "MUST accept pushes via this service that match the latest repo state announcement on the relay, respecting the recursive maintainer set."

Plus: `MUST set repository HEAD per repo state announcement`; `MUST include allow-reachable-sha1-in-want, allow-tip-sha1-in-want, and filter in advertisement`, permitting `blob:none` and `tree:0` (so clients can fetch arbitrary named OIDs and do partial clones); `Access-Control-Allow-Origin: *` on all responses so browsers can be git clients; and NIP-11 MUST advertise `supported_grasps` and `repo_acceptance_criteria`.

**Purgatory** — the two-phase commit that solves the state/object race:

> "Accepted git repository announcements, repo state announcements, PRs and PR Updates SHOULD be accepted with message `purgatory: won't be served until git data arrives` and kept in purgatory (not served) until the related git data arrives and otherwise discarded after 30 minutes."

ngit's client side mirrors this exactly (`ngit:src/bin/ngit/state_transaction.rs:1-27`):

> "First seed purgatory on the GRASP relays we are about to push to, then push git data, and only after at least one git server accepts the data fan out the state to any remaining relays. The extra round-trip prevents us reporting `ok` or broadcasting state for commits that no git server has."

**The rest of the family:**

- **GRASP-02 Proactive Sync** — the server MUST sync events from the other `relays` in the announcement, and MUST pull missing git data from the other `clone` servers *"no less than every 1h"*. This is what makes the servers genuinely interchangeable: they heal each other.
- **GRASP-03 Sync Plus** — additionally sync conversation history via the outbox model.
- **GRASP-05 Archive** — mirror repos that do *not* list you.
- **GRASP-06 Alternative PR Hosting** — an unauthenticated endpoint at `/prs/<npub>/<identifier>.git` accepting pushes to `refs/nostr/<event-id>` **only**, for *any* npub/identifier, so a contributor can open a PR when the target repo's own servers reject them. ngit builds these URLs at `ngit:src/lib/repo_ref.rs:3805` (`format_grasp_server_url_as_grasp06_prs_url`) and falls back to them at `src/lib/push.rs:578`. This is the decentralized answer to "fork to contribute" — **no fork announcement required**.
- **GRASP-08 Private Repositories** — NIP-42 auth on the relay with a service-wide whitelist, plus NIP-98 kind:27235 on every git HTTP request, with five deliberate relaxations of NIP-98 so one credential covers a whole smart-HTTP conversation (same event for GET and POST across `info/refs`, `git-upload-pack`, `git-receive-pack`; no `payload` validation; replay allowed within 60s). Discovery via the encrypted kind:10318 list.

**Live capability check, 2026-09-17T14:24Z.** `GET https://relay.ngit.dev/` with `Accept: application/nostr+json`:

```json
"software": "https://gitworkshop.dev/danconwaydev.com/ngit-grasp",
"version": "3.0.1-31c84730",
"supported_nips": [1,5,9,11,34,62,77],
"supported_grasps": ["GRASP-01","GRASP-02","GRASP-03","GRASP-06"],
"repo_acceptance_criteria": "None",
"limitation": { "max_limit": 500, "restricted_writes": true }
```

`gitnostr.com` returns the same set at `version 3.0.2-671d47a9`. Neither advertises GRASP-05 or GRASP-08 — consistent with GRASP-08 being for private, operator-run instances.

### 3.3 Blossom

**Blossom is used for binary artifacts, never for git objects.** `ngit:src/lib/blossom.rs:1-5` — *"Blossom transport support shared by releases, containers, and nsites."* Consumers are `release/write.rs`, `container.rs`, `nsite.rs`, `apk.rs`, `oci.rs`. The kind:30617 `blossoms` tag names a repo's preferred servers.

The one place a *user* meets it is the installer: `https://ngit.dev/install.sh` pins `VERSION='3.0.1'` and fetches sha256-content-addressed binaries from `blossom.primal.net` and `blossom.ditto.pub`, stating it does not *"discover 'latest' or execute unpinned downloads at runtime."* That is a materially better supply-chain posture than an unpinned `curl | bash`.

### 3.4 `git push nostr://…` end to end

Reconstructed from `ngit:src/bin/ngit/git_remote_helper/push.rs`, `src/lib/push.rs`, `src/bin/ngit/state_transaction.rs`, `src/lib/repo_state.rs`:

1. **Git invokes the helper.** Git meets a `nostr://` URL, execs `git-remote-nostr`, which delegates to `ngit`. Handshake is the standard remote-helper protocol (`capabilities`, `list`, `list for-push`, `push`).
2. **Resolve the repo.** `NostrUrlDecoded::parse_and_resolve` (`src/lib/git/nostr_url.rs`) turns `nostr://<npub|nip05>[/<relay-hint>]/<identifier>` into a NIP-19 coordinate, resolving NIP-05 or NIP-AD web addresses if needed.
3. **Build the virtual repository.** Fetch kind:30617 for the coordinate, then *recursively* fetch announcements from every pubkey holding a role, keeping only confirmed members ([§2.3](#23-the-maintainer-model--ngits-largest-deviation)). Union their `clone` and `relays` tags. Fetch the latest kind:30618 (`RepoState::try_from`, latest by `created_at` with lowest-id tiebreak).
4. **Compute the new state.** Refs the user is pushing are merged over the current map. `refs/heads/pr/*` is excluded — those are PRs, not branches.
5. **Seed purgatory.** Publish the candidate kind:30618 to the GRASP relays about to receive the push, **without writing it to the local cache** (`StateTransactionOps::publish_state_events` — *"an unverified candidate must not become locally authoritative as a publication side effect"*).
6. **Push the objects.** Ordinary git push to each `clone` URL, trying protocols in preference order. For private repos, a NIP-98 credential is installed first (`prepare_private_git_auth`).
7. **Commit.** Only after ≥1 git server accepted the data *and* ≥1 relay accepted the event does `StateTransaction::commit` fan the state out to remaining relays and write it to the local cache.
8. **PRs diverge here.** A `pr/`-prefixed branch instead produces a kind:1618 (or kind:1619 update) whose `c` tag is the tip and whose `clone` tag names where to fetch it — pushed to the repo's GRASP servers, or to a GRASP-06 `/prs/` endpoint as fallback.

**Fetch is the mirror image** (`ngit:src/lib/fetch.rs`, `ensure_commit_local`): if the OID is not local, try each server in order — PR-supplied `clone` URLs first *only if the caller opts in* (*"Callers that don't want to trust submitter-supplied URLs simply pass `&[]`"*) — then `repo_ref.git_server`. Each attempt is a git fetch of a specific OID, permitted by GRASP-01's mandated `allow-tip-sha1-in-want`.

---

## 4. Auth, identity and trust

### 4.1 Signing

ngit supports three signer shapes (`ngit:src/lib/login/mod.rs:94-113`):

```rust
pub enum SignerInfo {
    Nsec { nsec, password, npub, verify_npub },
    Bunker { bunker_uri, bunker_app_key, npub },
    Selection { selector },
}
```

- **Local key** — plaintext `nsec1…` or NIP-49-encrypted `ncryptsec1…`.
- **NIP-46 remote signing (bunker)** — `nostr-connect 0.45.1`, plus an `nbunksec` bech32 TLV format for non-interactive/CI use (`src/lib/login/nbunksec.rs`), explicitly *"the Applesauce/nsyte `nbunksec` TLV representation"* with a 1000-character interoperability limit. Usable as `ngit --nbunksec-file <path> <command>`.
- **Selection** by npub or alias across stored accounts.

**Storage** (`ngit:docs/credential-storage.md`): OS credential store first (macOS Keychain / Windows Credential Manager / D-Bus Secret Service) under keyring service `nostr`; fallback to `~/.local/share/ngit/credentials.json` at 0600 in a 0700 dir, written atomically. The doc names its threat model precisely: *"The file store is plaintext by design. The threat this feature counters is incidental disclosure of git config — which coding agents and other tools read routinely — not filesystem compromise by a targeted attacker."* Git config holds only a selector (`nostr.nsec`, `nostr.bunker-app-key`), never necessarily the secret.

### 4.2 Maintainer authority

Covered in [§2.3](#23-the-maintainer-model--ngits-largest-deviation). The operative runtime notion is `RepoRef::confirmed_members()` / `confirmed_maintainers()` — invited-but-unaccepted pubkeys are deliberately excluded, and `ngit:docs/architecture/ci-trust.md` makes that binding for CI too: *"Trust evidence requiring 'a confirmed repository maintainer' means `RepoRef::confirmed_maintainers()` — never invited maintainers."*

Status resolution (`ngit:src/lib/git_events.rs`, `get_status`) follows the NIP: latest status event from *"the root event's author or an authorized repository member: confirmed moderators count alongside confirmed maintainers."*

### 4.3 How a fetch verifies it got the right objects

The chain is short and rests on git itself:

1. The kind:30618 is **signed** by a confirmed maintainer; nostr event ids are SHA-256 over the serialized event and signatures are schnorr/secp256k1. A relay cannot forge one.
2. That event names an exact 40-hex OID per ref.
3. ngit fetches **that OID specifically** (`ensure_commit_local`) and then asserts `git_repo.does_commit_exist(oid)` — which is true only if git's own `index-pack` accepted the objects, and git recomputes every object's SHA-1 on receive.

So a malicious *git server* cannot substitute content: it would have to produce a SHA-1 preimage. A malicious *relay* can withhold or serve a stale kind:30618, but cannot fabricate one — and ngit's mitigations are (a) publish to and read from multiple relays, (b) GRASP-02's mandatory inter-server sync, (c) the local LMDB event cache, and (d) `ngit:src/lib/event_ordering.rs`, which orders replaceable events deterministically. **Rollback/withholding by a relay is not fully solved** — it is the residual risk of the design, and ngit's answer is redundancy rather than a proof.

**Note a real hardening detail:** `ngit:src/lib/fetch.rs` treats PR-supplied `clone` URLs as untrusted by default, keeping a hostile contributor from steering a maintainer's fetch at an arbitrary host. GRASP-06 exists precisely so contributors get a *neutral* place to put PR objects instead.

---

## 5. State of the project (2026-09-17)

### 5.1 Release and activity

| Fact | Value | Source |
|---|---|---|
| Latest version | **3.0.1** | `ngit:Cargo.toml`; git tags `v3.0.1`, `v3.0.0`, `v3.0.0-rc.8`, `v3.0.0-rc.7`; `install.sh` pins `VERSION='3.0.1'` |
| GitHub release v3.0.1 | published **2026-09-10T15:19:22Z**, 5 assets | GitHub API, probed 2026-09-17 |
| crates.io | **max_version 3.0.0**, updated 2026-09-09T11:23:02Z, **24,869 total downloads**, 323 recent, created 2023-05-21, 40 versions | crates.io API, probed 2026-09-17 |
| Canonical HEAD | `24b90e5`, **2026-09-14** | nostr repo clone |
| Commit cadence | 15 most recent commits are all fixes/tests/docs on clone, install, update, account and relay-deadline paths | `git log` |
| GitHub mirror | 68★, 8 forks, 0 open issues, `pushed_at 2026-09-10` (4 days behind canonical) | GitHub API |
| ngit-ci | `0.1.1`, HEAD 2026-09-12 | `ngit-ci:Cargo.toml` |
| GRASP specs | HEAD 2026-08-20 | `grasp` repo |

crates.io publishing lags the project by one patch release; the `install.sh` / GitHub-release path is the current one.

### 5.2 Live relay corpus

All figures from `wss://relay.ngit.dev`, raw NIP-01 `REQ` frames paginated backwards by `until` until the set stopped growing. Probed **2026-09-17T14:28Z**. (The relay's NIP-11 declares `max_limit: 500`, so a single unpaginated query returns 500 and tells you nothing — hence pagination.) These counts were produced twice by independent scripts and agreed exactly.

| Kind | Events | Distinct authors | Oldest | Newest |
|---:|---:|---:|---|---|
| **30617** repo announcement | **2,530** | **743** | 2024-11-12T07:55Z | **2026-09-17T12:57Z** |
| 1621 issue | 3,118 | 268 | 2024-03-01T09:46Z | 2026-09-17T13:02Z |
| 1618 pull request | 2,169 | 152 | 2025-07-23T14:45Z | **2026-09-17T14:17Z** |
| 1617 patch | 1,120 | 113 | 2024-01-30T14:52Z | 2026-09-15T08:30Z |
| **9842** CI Workflow Result | **4,158** | **16** | 2026-07-02T11:58Z | **2026-09-17T14:28Z** (during the probe) |
| 39842 CI Workflow Progress | 9 *(live, expiring)* | 2 | 2026-09-17T14:23Z | 2026-09-17T14:28Z |

All 2,530 kind:30617 events are distinct `(pubkey, d)` coordinates — one current announcement each, no duplicates — across **2,173 distinct `d` tags**, meaning ~357 identifiers are claimed by more than one pubkey (forks and name reuse).

Tag-shape census over all 2,530:

| Feature | Count | % |
|---|---:|---:|
| ≥1 `clone` tag | 2,528 | 99.9% |
| `clone` containing `nostr://` | **1** | 0.04% |
| `["r","<sha>","euc"]` | 1,362 | 53.8% |
| `web` tag | 1,515 | 59.9% |
| `maintainers` tag | 1,200 | 47.4% |

**129 `euc` values are shared by more than one repo identity** — i.e. fork lineage is genuinely detectable through the earliest-unique-commit tag, which is the whole point of it.

**kind:1617 is visibly the legacy surface.** Its newest event is two days stale while 1618/1621 were minutes old at probe time — consistent with the ecosystem having moved from emailed-patch style to `pr/`-branch pull requests.

**NIP-C1 CI is not a paper protocol:** 4,158 Workflow Results since 2026-07-02 from 16 distinct coordinator keys, with runs in flight during the probe.

### 5.3 The head-to-head number

Same method, same day, `wss://relay-ws.devnet.toonprotocol.dev`, probed **2026-09-17T14:29Z**:

| Kind | rig devnet | ngit (`relay.ngit.dev`) |
|---:|---:|---:|
| 30617 | **30** events, **15** authors, newest **2026-08-28** | 2,530 / 743 / 2026-09-17 |
| 1617 | 6 events, 4 authors, newest 2026-07-03 | 1,120 / 113 |
| 1621 | 26 events, 7 authors, newest 2026-07-30 | 3,118 / 268 |

rig's corpus is ~1.2% of ngit's by repo count and has been static for three weeks. The names visible on the wire (`rig-c2x-smoke`, `rigtest`) are test fixtures. **This is not a like-for-like comparison of adoption** — rig's is a devnet relay, not a production one, and rig is a younger project — but no production rig relay corpus exists to substitute, so it is the honest figure available.

### 5.4 gitworkshop.dev

Reachable (HTTP 200, Netlify), but **every route returns an identical client-rendered SPA shell**; `/repos`, `/about` and `/ngit` contain no server-side content. Its repo listing is built in-browser from the same relay queries above, so **its displayed repo count cannot be read without executing JavaScript — UNVERIFIED**. The relay-derived 2,530 is the better number regardless. Its operator is established from a signed event, not a claim on the page: kind:30617 `d=gitworkshop`, `name=gitworkshop.dev`, `description="nostr web client for code collaboration"`, signed by the ngit pubkey, announced 2026-08-19. Corroborating, `ngit.dev/protocol/grasp/`, `/self-host/grasp/` and `/about` all HTTP-302 to the matching gitworkshop.dev path (`server: Caddy`).

---

## 6. Field-level compatibility: would they see each other?

This is the section that matters. All claims below are verified against both codebases **and** against real events pulled off both relays on 2026-09-17.

### 6.1 kind:30618 — total mutual blindness

**On the wire, `relay.ngit.dev`, 2026-09-17T14:27Z** (ngit's own repo state event, `d=ngit`):

```json
["d", "ngit"]
["refs/heads/main", "<40-hex>"]
["refs/tags/v3.0.1", "ada8f00836ec3330047d6a39108b84b7bd234448"]
["refs/tags/v3.0.1^{}", "<40-hex>"]
["HEAD", "ref: refs/heads/main"]
```

**On the wire, `relay-ws.devnet.toonprotocol.dev`, 2026-09-17T14:29Z** (rig, `d=rig-c2x-smoke`):

```json
["d", "rig-c2x-smoke"]
["r", "refs/heads/main", "0f5cdb2ed94e0c6ce51688a6a23c5b05bf00db0f"]
["HEAD", "ref: refs/heads/main"]
["arweave", "e2400e48381cbd3ff998bbac86db4e14ee10d977", "Muh33_bhSBNL-1yHnaHMe5r-WU5QaH2I5nsDHZC6RO8"]
…
```

The parsers:

**ngit** — `ngit:src/lib/repo_state.rs:30-33`:
```rust
if ["refs/heads/", "refs/tags", "HEAD"]
    .iter()
    .any(|s| name.starts_with(*s))
```
`name` is `tag[0]`. rig's ref tags are named `"r"`. → **ngit parses 0 refs from a rig state event.**

**rig** — `packages/rig/src/remote-state.ts:353-361`:
```ts
const [tagName, v1, v2] = tag;
if (tagName === 'r' && v1 && v2) { … refs.set(v1, v2); }
else if (tagName === 'HEAD' && v1?.startsWith(SYMREF_PREFIX)) { … }
```
ngit's ref tags are named `"refs/heads/main"`. → **rig parses 0 refs from an ngit state event.** (`packages/rig-web/src/web/nip34-parsers.ts:159-162` is identical.)

| Field | NIP-34 | ngit | rig | Compatible? |
|---|---|---|---|---|
| `d` | required | ✅ | ✅ | **yes** |
| ref → sha | `["refs/heads/x","<sha>"]` | ✅ same | `["r","refs/heads/x","<sha>"]` | **no — total** |
| `HEAD` symref | `["HEAD","ref: refs/heads/x"]` | ✅ | ✅ | **yes** |
| peeled tags `^{}` | not in NIP | ✅ (emits, for `git fetch --prune`) | ✗ | n/a |
| object location | not in NIP | ✗ (lives in 30617 `clone`) | `["arweave","<sha>","<txid>"]` | rig-only |

**`HEAD` is the only field that survives the crossing.** rig is the deviating party: the NIP is unambiguous that the ref path is the tag name. (`nostr-protocol/nips` PR #2325, "NIP-34: remove unused refs tag extension", closed 2026-04-25, suggests an older `refs`-style tag once existed and was removed — but rig's `r` spelling matches neither the current NIP nor that removed extension. **UNVERIFIED** where rig's spelling originates.)

### 6.2 kind:30617 — discoverable but not clonable

**Real rig announcement on the wire (2026-09-17T14:29Z), complete tag set:**
```json
["d", "rig-c2x-smoke"] ["name", "rig-c2x-smoke"] ["description", ""]
```

| Tag | NIP-34 | ngit writes | rig writes | rig reads |
|---|---|---|---|---|
| `d` | required | ✅ (default = root commit[..7]) | ✅ | ✅ |
| `name`, `description` | optional | ✅ | ✅ | ✅ |
| **`clone`** | optional | ✅ always (2,528/2,530 live) | **✗ never** | ✅ (`nip34-parsers.ts:184`) |
| **`relays`** | optional | ✅ always | **✗ never** | ✅ (`remote-state.ts:479-487`) |
| **`["r","<sha>","euc"]`** | optional | ✅ (53.8% live) | **✗ never** — string `euc` absent from `packages/` | ✗ |
| `web` | optional | ✅ (59.9% live) | ✗ | ✅ (web pkg only) |
| `maintainers` | optional | ✅ as compatibility projection | ✅ (`nip34-events.ts:211`) | ✅ |
| `M`/`m`/`o` roles | **PR #2324, open** | ✅ primary | ✗ | ✗ |
| `t`, `u`, `alt` | optional / optional / NIP-31 | ✅ | ✗ | `t` only |
| `private`, `blossoms` | GRASP-08 / ngit | ✅ | ✗ | ✗ |
| **`payout`** | — | ✗ | ✅ `["payout","evm","0x…"]` (`nip34-events.ts:106`) | ✅ |

**Could ngit see a rig-announced repo?** It would appear in a `kinds:[30617]` query and render a name and description in `gitworkshop.dev/repos`. Then:
- **Clone: impossible.** No `clone` tag → no git server. ngit's fetch path has nothing to try.
- **Relays: impossible to follow.** No `relays` tag → no idea where the repo's issues and PRs live.
- **Fork grouping: impossible.** No `euc`.
- **Refs: zero**, per [§6.1](#61-kind30618--total-mutual-blindness).

**Could rig see an ngit-announced repo?** rig *parses* `clone`, `relays`, `web` and `maintainers` correctly — it simply cannot act on `clone`, because rig has no git-server fetch path at all; its reader resolves objects from `arweave` tags and an Arweave GraphQL `Git-SHA`/`Repo` query. And it would read **zero refs**. So: metadata yes, content no.

**Net: the two are not interoperable at the git layer in either direction today.** Three of the four blockers are one-line tag-shape fixes on rig's side.

### 6.3 Patches, PRs, issues, statuses

| | ngit | rig |
|---|---|---|
| **1617 patch** | writes + reads; `content` = `git format-patch`; `t`=`root`/`root-revision`; NIP-10 `e` reply chaining | writes + reads. `content` = real format-patch; **PR body in a `description` tag**, explicitly to keep `git am` working (`nip34-events.ts:341-347`). Emits `commit`/`parent-commit` per commit, `subject`, `a`, `p` |
| **1618 PR** | writes + reads; the primary modern surface (2,169 live) | **reads only** — `nip34-parsers.ts:298` accepts 1617 and 1618; **no builder exists** |
| **1619 PR update** | writes + reads | **reads only**; correctly requires the NIP-22 uppercase `E` tag, case-sensitively (`nip34-parsers.ts:346-347`) |
| **1621 issue** | ✅ both | ✅ both (`a`, `p`, `subject`, `t`) |
| **Comments** | **kind 1111** (NIP-22, as NIP-34 §Replies mandates) | **kind 1622** (`nip34-events.ts:27`) |
| **1630–1633 status** | ✅; NIP-10 `e` with `root` marker; authority = confirmed members | ✅; emits bare `["e", id]` with **no marker** and no `a` tag (`nip34-events.ts:413-428`) |

Two concrete cross-reading outcomes:

- **Comments do not cross.** ngit publishes and subscribes to kind:1111; rig publishes kind:1622. Neither queries the other's kind. Every comment thread is invisible across the boundary. rig is the deviating party: NIP-34 §Replies says *"Replies … should follow NIP-22 comment"*, and NIP-22 is kind 1111.
- **Statuses mostly do cross, by luck.** ngit's `get_status` matches any tag whose `[1]` equals the proposal id (`ngit:src/lib/git_events.rs`), so rig's marker-less `["e", id]` **would** be honoured. But ngit's `get_event_root` requires a NIP-10 `root` marker and would fail on a rig status, so ordering/threading degrades. rig should emit `["e", id, "", "root"]`.

**rig's 1617 has a self-inflicted bug worth fixing regardless of ngit:** it writes the branch as `['t', branchTag]` (`nip34-events.ts:383-385`) but both of its own readers look for a tag named `branch` (`packages/rig/src/cli/tracker.ts:412-413`, `nip34-parsers.ts:303`). The branch name is therefore invisible to rig itself and lands in `labels`.

### 6.4 NIP-C1 — byte-identical, and the one real bridge

```
f85123afa184d2b4f259dd318dd507e0  ngit-ci/NIP.md            @ 5702187 (2026-09-12)
f85123afa184d2b4f259dd318dd507e0  rig/docs/specs/nip-c1.md  @ f96ae48
a8871795c94a74191bf3c54dd1c2287e  ngit-ci/NIP-guidance.md
a8871795c94a74191bf3c54dd1c2287e  rig/docs/specs/nip-c1-guidance.md
```

Both spec files are identical byte-for-byte, and rig's vendored copy is **current**, not a stale fork. Kind constants match exactly:

| Kind | `ngit:src/lib/ci/kinds.rs` | `packages/rig/src/ci/nip-c1-events.ts:33-40` |
|---:|---|---|
| 9840 / 9841 / 9842 / 9843 / 9844 | ✅ | ✅ |
| 19843 Advertisement | consumed-set: *out of scope* | ✅ implemented |
| 19844 / 39844 | out of scope | **not implemented** (spec table only) |
| 29846 Secret Update | out of scope | ✅ implemented |
| 39842 Progress, `MAX_PROGRESS_EXPIRATION_SECS = 30*60` | ✅ | ✅ `CI_MAX_PROGRESS_TTL = 30 * 60` |

Even the conclusion vocabulary is identical — `success, failure, neutral, cancelled, skipped, timed_out, startup_failure` — and both reject unknown values rather than normalizing them. rig's documented in-spec departures (`nip-c1-events.ts:17-25`) are all legal: `["software","rig","<version>"]`, `M=maintainer-request`/`X=request-required`/`B=out-of-band`, **logs/artifacts as TOON store gateway URLs rather than Blossom (identical tag shapes, different host)**, and `K`/`k` = 1617 because rig's PRs are patches.

**This is the one place the two projects are genuinely mutually intelligible, and it was built on purpose.** Given rig's own comment — *"so ngit tooling keeps reading rig's events and rig keeps reading ngit-ci's"* — a rig coordinator's Workflow Results should already render in `gitworkshop.dev` and in `ngit ci status`, provided the repo coordinate resolves. **Not empirically tested** (no rig CI events exist on a relay ngit watches) — see [§9](#9-unverified).

---

## 7. What each does better

### 7.1 ngit

- **Onboarding cost is near zero and rig's is not.** ngit: install two binaries, `ngit account create`, `ngit init` — and `ngit init` *provisions the repository on a GRASP server automatically*, no forge account and no pre-created repo. Free. rig requires a BIP-39 mnemonic, a funded ILP payment channel, a connector, and a confirmation prompt before every push (`packages/rig/src/cli/push.ts:860-862`).
- **It is actually git.** A remote helper means `git clone nostr://…`, `git push`, `git fetch --prune` all work unmodified, and `nostr://` URLs are in the NIP. rig has **no remote helper and no URL scheme**: `packages/rig/package.json` declares one bin (`rig`), grep for `git-remote`/`toon://`/`rig://` across `packages/` returns nothing, and clone syntax is positional (`rig clone <relay-url> <owner>/<repo-id> [dir]`). rig instead passes unknown subcommands through to git (`packages/rig/src/cli/git-passthrough.ts`), which is a decent substitute for a human but not for tooling.
- **`git push origin pr/x` opens a PR.** One convention replaces an entire forge workflow.
- **Storage is genuinely swappable, and GRASP servers heal each other.** GRASP-02 mandates hourly cross-sync from every other `clone` server. A repo on four GRASP servers plus GitHub survives any of them. rig's Arweave storage is permanent but single-substrate.
- **Collaboration surface is complete.** Issues, PRs, PR updates, NIP-22 comments, NIP-32 labels, cover notes, statuses, releases, OCI containers, nsites, private repos — all CLI-first, all also in a browser client.
- **The maintainer model is a real security improvement.** The pre-v3 invitation attack ([§2.3](#23-the-maintainer-model--ngits-largest-deviation)) is a live vulnerability in the flat `maintainers` model rig uses.
- **Key handling is better.** NIP-46 bunker + `nbunksec` for CI + OS keychain. rig has one mode: a BIP-39 mnemonic from env/`.env`/keystore, with `DEFAULT_KEYSTORE_PASSWORD = 'toon-client-default'` as at-rest obfuscation only (`packages/rig/src/cli/identity.ts:101`).
- **It exists in the world.** 2,530 repos, 743 pubkeys, ~25k crate downloads, an install script with sha256-pinned Blossom artifacts, and a documentation site.
- **Agent ergonomics are a shipped feature.** `ngit skill install` writes a repo-managed skill into Codex/Claude discovery locations with a pointer appended to existing `AGENTS.md`/`CLAUDE.md`, reporting `changed_files`/`action` as JSON.

### 7.2 rig

- **Object durability is categorically different.** Every git object is an individually paid, permanently stored Arweave data item tagged `Git-SHA` / `Git-Type` / `Repo` (`packages/rig/src/standalone/connector-publisher.ts:336-353`). ngit's objects live on servers that can vanish — GRASP mitigates with replication and hourly sync, but nothing is permanent, and 2,516 of 2,530 repos list `relay.ngit.dev` as a clone host, which is real centralization by adoption.
- **rig verifies objects itself, twice.** `verifyObjectBody` re-hashes the body against all four git object types until one matches the expected SHA (`packages/rig/src/object-fetch.ts:108-125`), failing hard with `ObjectIntegrityError`; then `git hash-object -w` re-derives it and `ObjectWriteMismatchError` fires on any disagreement (`packages/rig/src/materialize.ts:109-142`). Plus hostile-relay hardening on refnames (`isSafeRefname`, `assertFullSha`). ngit relies on git's index-pack — equally sound cryptographically, but rig's is explicit and diagnosable.
- **The fast-forward check is client-side and runs before money moves.** `packages/rig/src/push.ts:285-312` uses `git merge-base --is-ancestor` and throws `NonFastForwardError` in `planPush`, which is network- and payment-free. ngit's FF enforcement is *server*-side (`grasp:01.md`: pushes must match the latest state announcement) — stronger where a GRASP server is present, absent on a vanilla git server, where ngit falls back to `ServerForcePolicy::ForceOnlyOn(...)` to keep vanilla servers fast-forward-only.
- **There is a payment protocol and it is real.** Settled ILP channels with on-chain claims, per-route pricing read from the connector's `GET /ilp`, per-request signed claims, `rig channel open|close|settle`. ngit has no payment layer at all; GRASP-01 merely says a server *MAY* charge, and nobody visible does. That is ngit's best feature today and its ceiling — the whole network runs on volunteered hosting.
- **Reads are free and need no client.** Objects are on public Arweave gateways (`ar-io.dev`, `arweave.net`, `permagate.io`), resolvable by a GraphQL tag query even without the kind:30618 map. An ngit repo needs a reachable git server.
- **rig-web is served from Arweave itself.** A per-repo HTML pointer uploaded on push boots the viewer from permanent storage (`CONTEXT.md`, "Pointer"). gitworkshop.dev is on Netlify — a single, revocable host for the whole ecosystem's browser client.
- **rig's CI implements more of NIP-C1 than the reference does.** rig implements the Coordinator Advertisement (19843) and Repository Secret Update (29846); `ngit:src/lib/ci/kinds.rs` declares both *"out of scope"* for ngit's consumed set. rig is a **producer** of the protocol ngit mainly consumes.

---

## 8. What rig should steal, and what rig is getting wrong

### 8.1 Steal

1. **The ref tag shape — do this first.** In `buildRepoRefs` (`packages/rig/src/nip34-events.ts:244`), emit `[refPath, sha]` in addition to (or instead of) `['r', refPath, sha]`, and accept the NIP form on read. This single change makes every rig repo's state legible to ngit, gitworkshop and every other NIP-34 client. Cost: a few lines and a dual-read window.
2. **`clone`, `relays` and `euc` on kind:30617.** `clone` can carry a rig-web/gateway URL or a GraphQL-backed read endpoint; `relays` should name the relay rig just published to; `["r","<root-commit>","euc"]` costs one `git rev-list --max-parents=0 HEAD` and buys fork grouping across the whole ecosystem. Without `euc`, rig repos can never be grouped with their forks by anyone.
3. **Kind 1111 instead of 1622 for comments.** NIP-34 §Replies mandates NIP-22, which is 1111. rig's 1622 is a private dialect that guarantees comment threads never cross.
4. **NIP-46 bunker signing.** ngit's `nbunksec` TLV blob (`ngit:src/lib/login/nbunksec.rs`) is purpose-built for exactly rig's CI coordinator problem: a long-running unattended signer that must not hold a root key. rig's CI coordinator signs with the same mnemonic that funds its payment channel (`packages/rig/src/standalone/nostr-identity.ts:10`) — one compromise loses both identity and money.
5. **The maintainer acceptance handshake.** Even without the full role-tag model, requiring a counter-signed acceptance before a listed maintainer gains authority closes the invitation attack. This is a consumer-side filter change, not a wire change.
6. **GRASP's purgatory pattern.** rig publishes the kind:30618 *after* object uploads (`push.ts:522-583`), which is the right order, but there is no relay-side hold. If rig ever adds a relay it controls, the purgatory contract — *accept but do not serve until the data lands* — makes a partial push invisible instead of broken.
7. **`ngit skill install`.** A repo-managed agent skill installed into Codex/Claude discovery locations, with JSON reporting of what changed. Directly applicable given this repo's own agent-skill workflow.
8. **Pinned, content-addressed installer artifacts.** `install.sh` pins `VERSION` and sha256 and refuses to resolve "latest" at runtime. Cheap, and a materially better supply chain than the usual `curl | bash`.

### 8.2 What rig is getting wrong or missing

1. **The kind:30618 ref tag is simply non-conformant.** See [§6.1](#61-kind30618--total-mutual-blindness). This is not a judgement call: the NIP's example is `["refs/<heads|tags>/<branch-or-tag-name>","<commit-id>"]`, ngit and the live corpus match it, rig does not.
2. **The `arweave` tag list is unbounded on both write and read.** `MAX_REFS_PER_EVENT = 1000` caps `r` tags (`remote-state.ts:337`, `nip34-parsers.ts:141`) but **no equivalent constant exists for `arweave` tags**. The map is merged cumulatively on every push (`push.ts:500`, `:549`, `:577-581`) and published in one replaceable event. A 50,000-object repo wants a 50,000-tag event; `relay.ngit.dev` caps messages at 5 MiB and other relays are far stricter. The GraphQL `Git-SHA`+`Repo` resolver already makes the map an *optimization* rather than a requirement — so the fix is a cap plus documented fallback, not new machinery. ngit has no analogous risk because it stores a URL, not a per-object mapping.
3. **kind:30617 republish is lossy.** `rig maintainers` and `rig payout` rebuild the announcement from `{repoId, name, description, maintainers, payout}` (`packages/rig/src/cli/maintainers.ts:321-327`, `cli/payout.ts:328-334`). Any tag `buildRepoAnnouncement` cannot emit is destroyed on the next edit. ngit solved exactly this with `extra_tags` + `is_known_tag_name` — unknown tags are carried over verbatim. **Adopt that pattern before adding `clone`/`relays`/`euc`, or the first `rig maintainers` call will delete them.**
4. **Flat `maintainers` authority with no acceptance step.** Listing a pubkey grants immediate status authority (`nip34-events.ts:83-91`). This is the pre-v3 ngit model, and `ngit-docs:docs/v3/maintainer-model.md` documents how it was abused. rig's blast radius is smaller today (status events only, not ref authority) but it will grow.
5. **rig writes no kind:1618/1619.** rig reads both but can only *produce* 1617 patches. In the live ecosystem 1618 is the busy surface (2,169 events, newest minutes old) and 1617 is the stale one. A rig contributor cannot open a PR that the rest of the NIP-34 world treats as a PR.
6. **Status events omit the NIP-10 `root` marker and the `a` tag.** `buildStatus` emits bare `["e", id]` (`nip34-events.ts:413-428`). The NIP specifies `["e","<id>","","root"]` plus an optional `a` for subscription efficiency. ngit's `get_event_root` fails on the bare form.
7. **The 1617 `t` vs `branch` mismatch is a live bug in rig's own code path** — see [§6.3](#63-patches-prs-issues-and-statuses).
8. **No remote helper.** This is the largest UX gap and the most defensible omission (rig's payment step genuinely does not fit inside git's push protocol without a confirmation channel). But it means no rig repo can be consumed by any tool that speaks git and nothing else.

---

## 9. UNVERIFIED

Stated plainly, in the order they appear above.

1. **gitworkshop.dev's own displayed repo, issue and PR counts.** Every route returns an identical client-rendered SPA shell (5,096 bytes) with no server-side content; the listings are built in-browser from relay queries. I did not execute JavaScript. The relay-derived figures in [§5.2](#52-live-relay-corpus) are independent of this and are the numbers I rely on.
2. **Whether rig's NIP-C1 events actually render in ngit/gitworkshop.** The specs are byte-identical and the kind constants match, so it *should* work, but **I did not observe a single rig-produced NIP-C1 event on any relay ngit watches** and did not run the two implementations against each other. The interop claim in [§6.4](#64-nip-c1--byte-identical-and-the-one-real-bridge) is a code-and-spec inference, not an observed round-trip.
3. **The provenance of rig's `['r', refPath, sha]` spelling.** `nostr-protocol/nips` PR #2325 ("remove unused refs tag extension", closed 2026-04-25) implies an older `refs`-style tag existed, but rig's `r` spelling matches neither the current NIP nor, as far as I could check, that removed extension. Where it came from is unknown; I did not read rig's issue history for it.
4. **Total corpus size across all relays.** Only `relay.ngit.dev` was enumerated to exhaustion. `gitnostr.com`, `nos.lol` and `relay.damus.io` were sampled at their limit caps, so their figures are floors. The true global NIP-34 repo count is **≥ 2,530** and unknown.
5. **rig's devnet relay as a fair adoption proxy.** The 30-repo figure in [§5.3](#53-the-head-to-head-number) is from a devnet, not production. No production rig relay corpus was available to query, so the comparison is directionally honest but not like-for-like.
6. **GRASP-04 and GRASP-07.** Absent from `grasp:README.md`'s listing and absent as files in the repo. Whether they are reserved, withdrawn or never written is unknown.
7. **ngit's kinds 30624 / 32267 / 35128 (containers, application coordinates, nsites)** were identified from source comments only. Their full tag shapes and governing NIPs (NIP-82 and "ncontainer" are referenced by `ngit.dev/protocol/`) were not read; they are out of scope for a git-transport comparison.
8. **Whether any GRASP server actually charges for hosting.** `grasp:01.md` permits pre-payment and quotas; both public servers probed report `"repo_acceptance_criteria": "None"`. I found no evidence of a paid GRASP service existing.
9. **ngit's real-world contributor count and whether anyone besides DanConwayDev commits.** `maintainers.yaml` lists one pubkey and `Cargo.toml` one author; I did not enumerate `git shortlog` across the full history (the clone was `--depth 50`).
10. **crates.io `recent_downloads` semantics** (323) — the API field's exact window is not documented in the response and I did not verify it.

---

## Appendix: reproducing the live probes

```bash
# Canonical ngit source (redirects to the GRASP endpoint)
git clone https://ngit.dev/ngit.git
git clone https://ngit.dev/grasp.git        # the six GRASP specs
git clone https://ngit.dev/ngit-ci.git      # NIP-C1 source of truth
git clone https://ngit.dev/ngit-docs.git

# GRASP capability advertisement
curl -H "Accept: application/nostr+json" https://relay.ngit.dev/

# Repo-announcement census (Node 22+ has a built-in WebSocket; no deps)
#   REQ with {kinds:[30617], limit:500, until:<t>}, decrementing `until`
#   past the oldest created_at each round until the set stops growing.
#   relay.ngit.dev declares max_limit 500, so a single REQ is never the answer.
```

Probe scripts used for this note are throwaway and were left in the session scratchpad, not committed.
