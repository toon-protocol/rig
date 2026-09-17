---
'@toon-protocol/rig': minor
---

NIP-22 comments: rig writes kind:1111, and reads kind:1111 and legacy kind:1622 as one thread (#159).

NIP-34's "Replies" clause mandates NIP-22, which is kind:1111. rig wrote kind:1622 — a private dialect no other NIP-34 client queries — so no comment thread crossed the boundary in either direction. From this release:

- **Write.** `rig comment <target-event-id>` publishes a NIP-22 kind:1111. The root is the issue or patch being discussed, never the repository: root scope is uppercase (`E` root event id, `K` root kind, `P` root author), the parent lowercase (`e`, `k`, `p`). A top-level comment's parent equals its root; passing an existing kind:1111 comment as the target publishes a reply, whose lowercase parent is that comment with `k` = `1111` while the uppercase root stays the issue/patch. The repo coordinate rides along as an ordinary `a` tag for subscription filtering. The target is read off the relay first (a free read) so the root's kind and author come from the wire rather than being guessed — a target the relay does not have is an error and nothing is paid.
- **Read.** `rig issue show` and `rig pr show` query both kinds and merge them by `created_at`, so a thread mixing old and new comments reads as one conversation. For kind:1111, thread membership is decided by the uppercase `E` tag matched case-sensitively (the rule rig already applies to kind:1619): a kind:1111 whose only match is a lowercase `e` is a reply to something else and is not in the thread. A nested reply is now labelled with the comment it replies to.
- **kind:1622 is never written again.** It stays exported as `LEGACY_COMMENT_KIND`, a read-only legacy constant, so threads published before this release keep rendering.

**Visible behaviour change: new comments are invisible to rig versions older than this release.** Older rig and rig-web installs query only kind:1622 and will not show comments published by this version. Comments already published as kind:1622 are unaffected and still render everywhere. Upgrade collaborators before relying on new comment threads.

**Source-compatibility note for library and daemon callers.** Released as a minor per the spec, but callers of these exports must update: `buildComment(repoOwnerPubkey, repoId, root, body, parent?)` now takes the root event (`{ eventId, kind, authorPubkey }`) plus an optional parent comment, replacing the old `issueOrPrEventId` / `authorPubkey` / `root|reply` marker arguments; `COMMENT_KIND` is now `1111`; the `POST /git/comment` request carries `rootKind` and `rootAuthorPubkey` (and an optional `parentComment`) in place of `parentAuthorPubkey`/`marker`; and the retired `rig comment --marker` / `--parent-author` flags now exit 2 with a message pointing at the new form.

`@toon-protocol/rig-web` changes alongside (it is excluded from changesets): its relay client queries both kinds, its parser accepts kind:1111 and exposes each comment's root, parent and wire kind, and issue/PR conversations merge the two kinds in time order.
