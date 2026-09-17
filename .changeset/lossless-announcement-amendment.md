---
'@toon-protocol/rig': minor
---

Announcement republish is lossless: `rig maintainers` and `rig payout` no longer destroy tags rig does not model (#154).

A kind:30617 is replaceable, so republishing it replaces the whole event. Until now `rig maintainers add|remove` and `rig payout set|clear` rebuilt the announcement from the five fields rig models, silently deleting everything else — another client's maintainer role tags (`M`/`m`/`o`), `clone`, `blossoms`, `t`, `alt`, or any tag invented later.

A new module, `amendRepoAnnouncement`, now owns "current announcement + field edits → next unsigned announcement". Tags it knows are rewritten from the edits, in the place the current announcement kept them; **every other tag is carried over verbatim, in its original relative order**, and the event's `content` is preserved. Its edit set already has room for the `relays`, `web` and earliest-unique-commit fields that later NIP-34 conformance work will write.

Every kind:30617 rig publishes — first push, `rig maintainers`, `rig payout` — is now built through it. A first push publishes exactly the announcement it did before, and `buildRepoAnnouncement` is unchanged as a public export (it is `amendRepoAnnouncement` with nothing to amend). `amendRepoAnnouncement`, `AnnouncementEdits` and `ExistingAnnouncement` are new exports of `@toon-protocol/rig`.

One small behaviour change beyond preservation: each command now edits only its own field, so a republish no longer re-asserts `name` and `description`. On an announcement that carries neither tag (another client can keep its prose in the event's `content`), `rig maintainers` and `rig payout` used to inject `["name", "<repo-id>"]` and a `description` copied out of `content`; they now leave both alone.
