# NIP-34 wire shapes rig writes and reads

This document is the ticket rig#153/#163 asked for: **per event kind, the
tags rig writes, the NIP clause each follows, and any legacy shape rig still
reads, with the end condition for each legacy shape.** It exists so future
drift from NIP-34 is visible in review, not rediscovered by a comparison
against ngit every few years.

**Scope.** Protocol truth lives in `toon-protocol/connector`
(`docs/protocol/`, `docs/adr/`) — see `CLAUDE.md`. This document does not
define NIP-34; it describes what **this package** (`@toon-protocol/rig`,
plus the read-side copy in `@toon-protocol/rig-web`) actually puts on the
wire and accepts off it, checked against the builder/parser source and their
tests. Where rig's behavior and the NIP diverge, that is stated plainly.

**Status of this document.** It was written as part of spec
[rig#153](https://github.com/toon-protocol/rig/issues/153), against the _end
state_ of that spec's ten tickets (#154-#163) — originally assembled by
reading branches that had not yet landed. **All ten have since landed on
`main`, and every claim below was re-verified against that merged state**:
each symbol it names, and the peeled-`^{}`, NIP-shape-wins, ref and
object-map cap, `branch-name` read-order, `E`-tag thread-membership and
status-authority rules. Where this document and the code disagree, the code
is the ground truth and this document is the bug.

The primary source for the comparative analysis behind spec #153 is
`docs/research/ngit-nip34-vs-rig.md` (§6 field-level compatibility, §8
recommendations); this document is the durable, per-kind reference that
research snapshot fed into.

## Kinds covered

[30617](#kind30617--repository-announcement) ·
[30618](#kind30618--repository-state) ·
[1617](#kind1617--patch) ·
[1618/1619](#kind16181619--pull-request--pr-update-read-only) ·
[1621](#kind1621--issue) ·
[1111](#kind1111--comment-nip-22) ·
[1622 (legacy)](#kind1622--legacy-comment-read-only) ·
[1630–1633](#kind16301633--status)

---

## kind:30617 — Repository announcement

Built and amended by `packages/rig/src/repo-announcement.ts`
(`amendRepoAnnouncement`, `buildRepoAnnouncement`), which every publisher of
a kind:30617 — first push (`push.ts`), `rig maintainers`, `rig payout`, and
`rig refresh` — goes through. Addressable/replaceable per NIP-34; a
republish replaces the event wholesale, which is why this module exists (see
[Lossless amendment](#lossless-amendment-repo-announcementts) below).

| Tag rig writes                                                                       | NIP-34 clause                               | Notes                                                                                                                                                                                                                                                                              |
| ------------------------------------------------------------------------------------ | ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `d`                                                                                  | required repo id                            | Always first, always present.                                                                                                                                                                                                                                                      |
| `name`, `description`                                                                | optional                                    | Written when given; omitted fields are left as the current announcement has them on a republish.                                                                                                                                                                                   |
| `maintainers`                                                                        | optional, multi-value                       | One tag, deduped, lowercase 64-hex only. The owner (signer) is an implicit maintainer and need not be listed.                                                                                                                                                                      |
| `payout`                                                                             | **not in NIP-34 — rig extension**           | See [Deliberate extensions](#deliberate-extensions).                                                                                                                                                                                                                               |
| `relays`                                                                             | optional, multi-value                       | The relay URL(s) _this publish_ is going to, written by `rig push`, `rig maintainers`, `rig payout`, `rig refresh`. **Unioned, never substituted**, on every owner-initiated republish: the values already announced lead, in their original order, and rig's are appended if missing — so another client's relay list survives a rig republish, and a republish that adds nothing new changes no tag.                                                      |
| `web`                                                                                | optional, multi-value                       | Rig writes exactly one value: the repo's rig-web viewer URL, built by `repoWebUrl()` (`rig-pointer.ts`) from the same base URL and route shape as the Rig pointer's own fallback link — governed by ADR-0001's URL-permanence rules. Unioned with any viewer URL already announced on every owner-initiated republish; another client's `web` entry is never dropped. |
| `["r", "<sha>", "euc"]`                                                              | optional — the _earliest unique commit_ tag | Computed once by `earliestUniqueCommit()` (`repo-announcement.ts`) and written only when the announcement does not already carry one — see [Earliest unique commit](#earliest-unique-commit).                                                                                      |
| `clone`                                                                              | optional                                    | **Deliberately never written.** See [Deliberate omissions](#deliberate-omissions).                                                                                                                                                                                                 |
| `M` / `m` / `o` role tags                                                            | `nostr-protocol/nips` PR #2324 (unmerged)   | Not interpreted or written; preserved verbatim if present (see below).                                                                                                                                                                                                             |
| everything else (`t`, `u`, `alt`, `blossoms`, `private`, `clone`, unrecognized tags) | —                                           | **Preserved verbatim, in original order**, on every republish. Never interpreted.                                                                                                                                                                                                  |

### Lossless amendment (`repo-announcement.ts`)

Before rig#154, `rig maintainers` and `rig payout` rebuilt the announcement
from five fields and silently dropped every tag they didn't model —
including another client's `clone`, `blossoms`, role tags, or anything
invented after that code was written. `amendRepoAnnouncement` fixes this
with an explicit, small **known-tag set** (`d`, `name`, `description`,
`maintainers`, `payout`, `relays`, `web`, the `euc`-marked `r` tag) plus a
**carry-over default**: any tag not in that set rides through byte-for-byte,
in its original relative position. This is the same pattern ngit uses
(`is_known_tag_name` + `extra_tags`, `ngit:src/lib/repo_ref.rs`).

Every kind:30617 rig publishes — first push, `rig maintainers`,
`rig payout`, `rig refresh` — goes through this one function.

### Earliest unique commit

NIP-34's own wording: _"The `r` tag annotated with the `"euc"` marker should
be the commit ID of the earliest unique commit of this repo, made to
identify it among forks and group it with other repositories hosted
elsewhere that may represent essentially the same project. In most cases it
will be the root commit of a repository. In case of a permanent fork between
two projects, then the first commit after the fork should be used."_

rig's `earliestUniqueCommit()` (`repo-announcement.ts`) computes it
deterministically from local git: one root commit → that root; several
roots → prefer ones reachable from `HEAD`; still ambiguous → the
lexicographically lowest SHA. **Once an announcement carries an `euc`, every
later republish preserves it rather than recomputing** — `announcedEuc()` is
checked first, and a value already there is never touched — so a repo's
fork identity can never drift under its own owner, even across a shallow
clone or a rewritten history that would compute a different root locally.

### Deliberate extensions

- **`arweave`** — lives on kind:30618, not 30617; see
  [kind:30618](#kind30618--repository-state). Not a NIP-34 tag: it is rig's
  sha→txid object-location map, the substitute for NIP-34's `clone`
  (ngit points at a git server; rig has none, so it points at Arweave
  transaction ids instead, capped and with a resolver fallback — see below).
- **`payout`** (`packages/rig/src/nip34-events.ts`, `PAYOUT_TAG`) — a single
  `["payout", "evm", "<address>"]` tag naming where a repo's write-fee split
  accrues (toon-meta#391). No pointer means no split; the serving node keeps
  100% of repo-scoped write fees. `v1` accepts exactly one chain, `evm`. This
  has no NIP-34 analogue and is not expected to be read by any other client.

### Deliberate omissions

- **`clone` is never written.** NIP-34 defines it as "a url to be given to
  `git clone` so anyone can clone it" — a git-clonable endpoint. rig has no
  such endpoint: objects live on Arweave, fetched through the store /
  GraphQL `Git-SHA` resolver, not through git's own transport. Emitting a
  non-git URL in `clone` would send other NIP-34 clients (ngit,
  gitworkshop.dev) to a fetch that cannot succeed — worse than omitting the
  tag. If another client's `clone` tag already exists on a repo's
  announcement (e.g. an ngit-authored one, or one hand-added before rig ever
  touched the repo), rig's lossless amendment path preserves it verbatim —
  rig only ever adds to or edits its own known slots, never `clone`. A
  git-clonable endpoint for rig repos (git smart-HTTP over Arweave behind a
  TOON Network Workload Gateway) is out of scope for spec #153; see that
  spec's Out of Scope section.

---

## kind:30618 — Repository state

Built by `buildRepoRefs` (`packages/rig/src/nip34-events.ts`). Read by one
shared parser, `parseStateRefTags` (`packages/rig/src/nip34-refs.ts`), used
by the CLI's remote-state reader (`remote-state.ts`, behind `rig clone` /
`rig fetch`) and the CI Coordinator's commit materialization
(`ci/coordinator.ts`). `@toon-protocol/rig-web` cannot depend on
`@toon-protocol/rig`'s `dist/`, so it keeps a documented, behavior-identical
copy of the same parsing rules in `packages/rig-web/src/web/nip34-parsers.ts`
(`parseRepoRefs`), tested against the same captured ngit fixtures.

| Tag rig writes                                              | NIP-34 clause                                  | Notes                                                                                                                    |
| ----------------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `d`                                                         | required, matches the 30617 `d`                |                                                                                                                          |
| `[<refPath>, "<sha>"]`, e.g. `["refs/heads/main", "<sha>"]` | **the** shape — "the tag name IS the ref path" | Written for every ref, dual-written alongside the legacy shape (below) during the transition window.                     |
| `["r", "<refPath>", "<sha>"]`                               | **legacy rig shape, not in NIP-34**            | Written for every ref alongside the NIP shape. See [Legacy: dual-written `r` ref tags](#legacy-dual-written-r-ref-tags). |
| `["HEAD", "ref: <refPath>"]`                                | symref                                         | Defaulted to the first ref in the map (typically `refs/heads/main`).                                                     |
| `["arweave", "<sha>", "<txid>"]`                            | **not in NIP-34 — rig extension**              | See [Deliberate extensions](#deliberate-extensions-1). Bounded — see below.                                              |

### Reading: two shapes, one rule set (`nip34-refs.ts` / `parseStateRefTags`)

Both the NIP-34 shape and the legacy `r` shape are read, everywhere, by one
shared function (`parseStateRefTags`) and its documented rig-web copy
(`parseRepoRefs`):

- A tag is a **NIP-shape ref** when its _name_ starts with `refs/heads/` or
  `refs/tags/`. Nothing else in that shape is read as a ref — a hostile
  relay cannot smuggle an option-looking value in as one.
- A NIP-shape name ending in `^{}` is a **peeled annotated-tag entry**
  (ngit emits these for `git fetch --prune`). **It is not treated as a ref
  and is not listed.** rig#153's implementation decisions offered retaining
  it as the peeled _target_ for that tag as an option — the code does not do
  this: peeled entries are dropped entirely, not stored anywhere.
- When both shapes name the same ref with **different** SHAs, **the NIP
  shape wins**, regardless of tag order — so two rig versions reading the
  same event can never silently disagree about which one is authoritative.
- `MAX_REFS_PER_EVENT = 1000` caps **distinct refs across both shapes
  combined**; the NIP shape gets first claim on the cap's slots (each shape
  is staged independently, then merged NIP-first), so which refs survive on
  an over-cap event never depends on how a writer — or a hostile relay —
  happened to interleave the two shapes.
- Refname safety (`isSafeRefname`) and full-SHA validation apply identically
  to refs from either shape, at the git-invoking boundary
  (`materialize.ts`) — the NIP shape is not a validation bypass.

### Legacy: dual-written `r` ref tags

**Why it exists.** Before rig#153, rig wrote and read _only_ the `["r",
refPath, sha]` shape. NIP-34 specifies the ref path as the tag _name_
(`["refs/heads/main", "<sha>"]`); rig's spelling matched neither the current
NIP nor the earlier extension NIP-34 removed (`nostr-protocol/nips` PR
#2325, "NIP-34: remove unused refs tag extension", closed 2026-04-25) — see
[Provenance of the `r` spelling](#provenance-of-the-r-spelling) below. ngit,
gitworkshop.dev and the rest of the live NIP-34 corpus write and read the
NIP shape only, so rig's repos were parsed as empty by every other client.

**What rig#157 does.** `buildRepoRefs` writes **both** shapes for every ref,
with identical SHAs, so a state event is legible to conformant NIP-34
clients _and_ to any rig install still running the `r`-only reader.

**End condition.** The legacy write is removed in a later, separately
ticketed change, once rig versions older than this release (the one that
ships dual-write) are no longer supported. No such ticket exists yet as of
this writing — spec #153 explicitly left "removing the legacy `r` ref write"
out of scope, as a "planned follow-up with a recorded end condition," which
is this paragraph.

### Object map (`arweave` tags) — bounded (#162)

Before rig#162 the sha→txid map was merged cumulatively on every push and
bounded by nothing, while `r`/ref tags were capped at 1000 — a large repo
would eventually produce a state event relays reject.
`MAX_ARWEAVE_TAGS_PER_EVENT = 2000` (`nip34-events.ts`, mirrored in
rig-web's `nip34-parsers.ts`) now bounds it on **both** write and read:

- **Write** (`buildRepoRefs`, and the priority selection in `push.ts`'s
  `boundObjectMap`): under the cap, publishing is unchanged — byte-identical
  to every release before the cap existed. Over the cap, entries are kept in
  priority order: this push's own uploaded objects first, then objects
  reachable from the new ref tips (newest commit first), then whatever
  merge-order hints still fit.
- **Read** (`remote-state.ts`'s `parseRefsEvent`, and rig-web's
  `parseRepoRefs`): ingest stops at 2000 `arweave` tags per event, so a
  hostile relay serving an oversized state event cannot exhaust memory.

**Dropped entries are not lost objects.** Every object is still on Arweave
under its `Git-SHA` / `Repo` tags; a SHA missing from the map resolves
through the existing GraphQL `Git-SHA` resolver
(`RemoteState.resolveMissing`), which was already the documented fallback
before the cap existed. Push planning treats "absent from the map" as "ask
the resolver," never as "needs upload" — a dropped entry never causes a
double-pay on a resumed push.

### Deliberate extensions

- **`arweave`** — `["arweave", "<40-hex git SHA>", "<Arweave txId>"]`. Not a
  NIP-34 tag. rig's substitute for a `clone` URL: instead of naming a git
  server, it names, per object, where on Arweave that object lives. No other
  NIP-34 client reads it. Bounded per [above](#object-map-arweave-tags--bounded-162).

---

## kind:1617 — Patch

Built by `buildPatch` (`nip34-events.ts`). `content` is real
`git format-patch` output — kept free of any prose so `git am` still applies
it; the PR body/cover text travels in a separate `description` tag instead
(#280).

| Tag rig writes                                | NIP-34 clause                                                             | Notes                                                                                                                                       |
| --------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `a`                                           | `30617:<owner>:<repoId>` coordinate                                       |                                                                                                                                             |
| `p`                                           | repo owner                                                                |                                                                                                                                             |
| `subject`                                     | title                                                                     |                                                                                                                                             |
| `description`                                 | **not in NIP-34 — rig extension**                                         | PR/patch body, kept out of `content` so `git am` still works.                                                                               |
| `commit`, `parent-commit` (pairs, per commit) | optional, for stable commit ids                                           |                                                                                                                                             |
| `branch-name`                                 | **NIP-34 defines this tag only under kind:1618 (Pull Request)**, not 1617 | See [Patch branch name](#patch-branch-name) — rig writes it here anyway, deliberately, because it's what ngit and the wider ecosystem read. |

Not written: the NIP's `["r", "<earliest-unique-commit-id-of-repo>"]`
subscription-convenience tag and the `["t", "root"]` / `["t",
"root-revision"]` patch-series tags — out of scope for spec #153, which
touched only the branch-name mismatch on this kind.

### Patch branch name

**The kind mismatch, stated honestly.** NIP-34's `branch-name` tag — _"optional
recommended branch name"_ — is defined **only** in the kind:1618 (Pull
Request) shape. NIP-34 defines **no** branch tag at all for kind:1617
(Patch). rig writes `branch-name` on its kind:1617 patches anyway (rig#161),
because `branch-name` is the tag name ngit and the wider NIP-34 ecosystem
actually read for a patch's branch, and because it is rig's only PR-like
surface (rig reads, but does not write, kind:1618 — see below). This is a
deliberate departure from the letter of the NIP in exchange for
interoperating with what other tools actually do; it is not a NIP-34
requirement being fulfilled.

**The bug this replaced.** Before rig#161, the branch was written to a `t`
tag — but both of rig's own readers (`cli/tracker.ts`, rig-web's
`nip34-parsers.ts`) looked for a tag literally named `branch`. The branch
name was therefore invisible even to rig itself and was misreported as a
label.

**Read order:** `branch-name` first, then a `branch` tag
(`cli/tracker.ts`, rig-web's `parsePR`). **`t` is never read as a branch
name** — no heuristic guesses which `t` value, if any, was meant as one.

The `branch` fallback is defensive, not a documented real-world legacy
shape: nothing in rig's own git history ever wrote a tag literally named
`branch` (pre-rig#161 code wrote `t`, per above), and no captured ngit
fixture (`packages/rig/src/nip34-fixtures/`,
`packages/rig-web/src/web/__fixtures__/`) contains one either. It appears
to have been the readers' original, incorrect guess at the tag name, kept
as a second read attempt in case a `branch`-tagged event exists somewhere
this search did not reach — not a fallback with known real data behind it.

**Legacy shape and end condition.** A patch published before rig#161 that
carries its branch only in a `t` tag keeps rendering exactly as it did
before: unlabeled branch, `t` shown as a label. There is no migration path
and none is planned — see rig#153's Implementation Decisions ("no heuristic
is added to guess which `t` value was a branch"). This is a permanent
legacy read, not a transitional one: **no end condition** — old patches
simply keep whatever rendering they always had.

---

## kind:1618/1619 — Pull Request / PR Update (read-only)

rig has **no builder** for either kind — `rig` cannot itself publish a
pull request or a PR update. Both are parsed, read-only:

- **rig-web** (`packages/rig-web/src/web/nip34-parsers.ts`): `parsePR`
  (shared with kind:1617) reads `c` (tip commit), `clone` (fetch URLs),
  `branch-name`, `merge-base`, `t` (labels) for a 1618; `parsePRUpdate`
  reads a 1619's NIP-22 uppercase `E` tag (the target PR event id), matched
  **case-sensitively** — the same rule kind:1111 comment threading uses (see
  below) — plus `c` and `clone`. It does **not** read a `P` tag: the
  update's author comes from the signed event's own `pubkey` field, not
  from a tag. NIP-34's example 1619 shape lists both `E` and `P`; rig's
  reader only needs the one it actually uses.
- **The CI Coordinator** (`packages/rig/src/ci/coordinator.ts`) also reads
  1617/1618/1619 — not to render them, but to detect and route PR-triggered
  workflow runs (NIP-C1; see `docs/specs/nip-c1.md`), separate from this
  document's NIP-34 scope.
- **rig's own CLI** (`packages/rig/src/cli/tracker.ts`,
  `packages/rig/src/cli/events.ts`) does **not** read or write 1618/1619 at
  all — `rig pr` only knows kind:1617 patches.

Writing kind:1618 is out of scope for spec #153: a 1618 requires a `clone`
URL where the tip commit can be downloaded, which depends on the
git-clonable-endpoint work spec #153 explicitly defers (see
[Deliberate omissions](#deliberate-omissions)).

---

## kind:1621 — Issue

Built by `buildIssue` (`nip34-events.ts`).

| Tag rig writes      | NIP-34 clause                       | Notes |
| ------------------- | ----------------------------------- | ----- |
| `a`                 | `30617:<owner>:<repoId>` coordinate |       |
| `p`                 | repo owner                          |       |
| `subject`           | title                               |       |
| `t` (one per label) | optional labels                     |       |

No legacy shape; no gap from the NIP-34 shape shown in the spec.

---

## kind:1111 — Comment (NIP-22)

Built by `buildComment` (`nip34-events.ts`). This is the kind rig **writes**
for every new comment, as of rig#159. NIP-34's "Replies" clause: _"Replies to
either a `kind:1621` (issue), `kind:1617` (patch) or `kind:1618` (pull
request) event should follow NIP-22 comment"_ — NIP-22 is kind 1111.

| Tag rig writes | NIP-22 clause                       | Notes                                                                                                                                                     |
| -------------- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `E`            | uppercase root event id             | The issue or patch the thread hangs off — **never the repository**.                                                                                       |
| `K`            | uppercase root kind                 | e.g. `"1621"` or `"1617"`, as a string.                                                                                                                   |
| `P`            | uppercase root author               |                                                                                                                                                           |
| `e`            | lowercase parent item               | The root itself (top-level comment) or the comment being replied to.                                                                                      |
| `k`            | lowercase parent kind               | `1111` for a reply; echoes the root kind for a top-level comment.                                                                                         |
| `p`            | lowercase parent author             |                                                                                                                                                           |
| `a`            | `30617:<owner>:<repoId>` coordinate | **Not** the NIP-22 parent pointer (that's `e`) — an ordinary extra tag so a whole repo's comments can be scoped with one `#a` relay filter. Emitted last. |

NIP-22: _"Comments MUST point to the root scope using uppercase tag names…
and MUST point to the parent item with lowercase ones… `P` for the root
scope and `p` for the author of the parent item."_ rig's builder follows
this to the letter — `E`/`K`/`P` always name the issue/patch at the top of
the thread; a top-level comment's `e`/`k`/`p` repeat the root, a reply's
point at the specific comment being answered.

**Thread membership** is decided by the **uppercase `E` tag, matched
case-sensitively** (`commentBelongsToThread` in both `nip34-events.ts` and
rig-web's `nip34-parsers.ts`) — the same rule rig already applied to
kind:1619 PR updates. A 1111 whose only match is a lowercase `e` replies to
something else and is not part of that thread.

---

## kind:1622 — Legacy comment (read-only)

rig's pre-#159 private comment dialect (`LEGACY_COMMENT_KIND` in
`nip34-events.ts` and rig-web's `nip34-parsers.ts`). **Never written again.**
Its shape was a bare `["e", <issueOrPrEventId>, "", marker]` (`marker` =
`'root'` or `'reply'`) plus `["p", <parentAuthorPubkey>]` — no NIP-22
uppercase root scope, so it could not thread against anything but itself.

**Read behavior.** Every reader — `cli/events.ts`/`cli/tracker.ts` on the
CLI side, rig-web's `use-comments.ts` hook and `parseComment` — queries
**both** kind:1111 and kind:1622 and **merges the results by `created_at`**,
so an existing kind:1622 thread keeps rendering as one conversation
alongside any new kind:1111 replies to the same root. For a legacy 1622
event, the lowercase `e` tag **is** the thread root (`rootEventId ===
parentEventId`); there is no separate parent concept, since 1622 never
supported nested replies via a distinct parent id the way 1111 does.

**End condition.** None recorded, and none planned in spec #153 — spec
#153's Implementation Decisions state plainly: _"Kind 1622 is never written
again. It remains exported as a read-only legacy constant."_ Every comment
thread published before rig#159 must keep rendering for as long as rig
reads relays at all; this is a permanent read path, not a transitional one.

---

## kind:1630–1633 — Status

Built by `buildStatus` (`nip34-events.ts`). Kinds: 1630 Open, 1631
Applied/Merged, 1632 Closed, 1633 Draft.

| Tag rig writes                         | NIP-34 clause                                                      | Notes                                                                                                                                                              |
| -------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `["e", "<targetEventId>", "", "root"]` | `["e", "<issue-or-PR-or-original-root-patch-id-hex>", "", "root"]` | The NIP-10 `root` marker, matching NIP-34's own status example verbatim.                                                                                           |
| `a`                                    | `30617:<owner>:<repoId>` coordinate                                | NIP-34 lists this as _optional, for improved subscription filter efficiency_; rig always writes it (without a relay-url hint, which the NIP also allows omitting). |
| `p`                                    | target event's author, when known                                  | NIP-34 allows several `p` tags (owner, root author, revision author); rig writes at most one — the target's author.                                                |

### Legacy: bare `e` tag

**Before rig#160**, `buildStatus` emitted a bare `["e", <id>]` with no
marker and no `a` tag — this made the status invisible to a NIP-10-strict
root resolver (e.g. ngit's `get_event_root`), though ngit's own looser
`get_status` matching (any tag whose `[1]` equals the target id) happened to
still honor it.

**Read behavior.** Every rig reader (`cli/tracker.ts`'s `deriveStatus`, and
rig-web's `resolvePRStatus`/`resolveIssueStatus` in `nip34-parsers.ts`)
matches a status by `tags.find(t => t[0] === 'e')?.[1] === targetEventId`
only — it does not look at, or require, a trailing marker. Both the marker
form (`["e", id, "", "root"]`) and the legacy bare form (`["e", id]`) are
therefore honored identically, and among all matching, authorized events the
latest by `created_at` wins regardless of which form it used.

**End condition.** None recorded and none planned — spec #153's
Implementation Decisions: _"Readers accept both the marker form and the
legacy bare form."_ This is a permanent read path: every status published
before rig#160 must keep moving issue/PR state for as long as rig reads
relays at all.

### Status authority — widened relative to the pre-#160 code

rig#153's Implementation Decisions already name the wider rule verbatim:
_"Authority is unchanged: `authorizedStatusAuthors` over the `maintainers`
tag plus owner plus target author."_ (The word "unchanged" in that sentence
describes the _mechanism_ — a consumer-side authorized-author filter — not
identity with what the code did immediately before rig#160; read on its
own, "unchanged … plus target author" is a little confusing, since a thing
that changed to add a clause is not unchanged by the plain meaning of the
word. This section exists to make the actual before/after unambiguous.)

Before rig#160, `authorizedStatusAuthors()` (`nip34-events.ts`) was owner ∪
declared `maintainers` only, and every call site used that set directly.
rig#160 keeps `authorizedStatusAuthors()` itself unchanged, but every call
site now unions in **the target event's own author** before checking a
status against it — `withTargetAuthor()`, added in both:

- CLI: `cli/tracker.ts`, used by both `fetchItems` and `fetchItem` before
  calling `deriveStatus`.
- rig-web: `nip34-parsers.ts`, used by `use-prs.ts` and `use-issues.ts`
  before calling `resolvePRStatus` / `resolveIssueStatus`.

So the actual rule, as implemented, is: **owner ∪ declared maintainers ∪ the
issue/patch's own author** may set its status — matching the spec's stated
formula exactly, and wider than the owner-∪-maintainers-only rule the code
enforced before rig#160. An issue's or patch's own author closing their own
item is now authoritative even if they are not a declared maintainer; that
was not true before rig#160.

---

## Provenance of the `r` spelling

**Unknown.** rig's `["r", refPath, sha]` kind:30618 ref shape matches
neither the current NIP-34 text nor the extension NIP-34 removed
(`nostr-protocol/nips` PR #2325, "NIP-34: remove unused refs tag extension",
closed 2026-04-25). Searching this repository's own issue and commit history
(`gh search issues`, `gh search prs`, `git log -S` against every historical
path carrying a kind:30618 parser or builder) turns up:

- The earliest commit in `toon-protocol/rig`'s history parsing this shape
  is `7b092d3` ("feat(8-2): Forge-UI file tree and blob view", 2026-03-23),
  whose `parseRepoRefs` reads `["r", "<ref-name>", "<commit-sha>"]` off a
  kind:30618 event. Its commit message gives no rationale and cites no
  issue number; "8-2" is a pre-GitHub-issue ticket numbering scheme (no
  matching issue or design doc was found) that also produced `ea7c261`
  ("feat(10.1): test infrastructure and shared seed library", 2026-03-29,
  six days later), the seed event-_builder_ library that first _writes_
  the shape — likewise without rationale or an issue reference.
- The shape's direction of travel through `@toon-protocol/views` runs the
  **opposite** way from how it might first appear from the current source
  tree's file headers. `packages/rig/src/web/nip34-parsers.ts` carried the
  `r`-shape parser natively from `7b092d3` (March 2026) until commit
  `cac73ee` ("feat(views): agent-composed generative MCP-app UI", 2026-06-19)
  gutted it to a thin re-export of the newly-created `@toon-protocol/views`
  package — i.e. `views` inherited the shape _from rig_, three months after
  rig had it, not the other way around. The later "ported from
  `@toon-protocol/views@0.36.9`" header now on `nip34-parsers.ts` (rig#82,
  closing rig#40) documents porting the parsers _back_ once `views` fell out
  of sync — and picking up kind:1618/1619 support along the way — not the
  `r` shape's origin. `toon-protocol/views` itself is not accessible from
  this repository's `gh` context (it no longer resolves as a repository), so
  its own history could not be searched directly, but the above shows the
  shape did not originate there.

No issue, PR discussion, or design note referencing the `r` spelling's
origin was found anywhere this search could reach. If it turns up later
(e.g. `views`' history becomes reachable again), record it here.

---

## Summary: every legacy/transitional shape and its end condition

| Shape                                            | Where        | End condition                                                                                                                                                      |
| ------------------------------------------------ | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `["r", refPath, sha]` dual-written on kind:30618 | write + read | Removed once rig versions older than this release are no longer supported (no ticket filed yet — spec #153 left this as a recorded, not yet scheduled, follow-up). |
| kind:1622 comment read                           | read only    | None — permanent. Never written again; always merged with kind:1111 by `created_at`.                                                                               |
| Bare `["e", id]` status form                     | read only    | None — permanent. Both forms always accepted, latest wins.                                                                                                         |
| `branch` tag (patch branch, after `branch-name`) | read only    | None — defensive fallback with no known real-world producer (see above); `branch-name` is what new patches write.                                                  |
| Legacy patches carrying the branch in `t`        | read only    | None — no heuristic will ever be added to guess which `t` value was a branch; old patches keep rendering as they always have.                                      |
