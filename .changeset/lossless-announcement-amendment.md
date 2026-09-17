---
'@toon-protocol/rig': minor
---

Announcement republish is lossless: `rig maintainers` and `rig payout` no longer destroy tags rig does not model (#154).

A kind:30617 is replaceable, so republishing it replaces the whole event. Until now `rig maintainers add|remove` and `rig payout set|clear` rebuilt the announcement from the five fields rig models, silently deleting everything else — another client's maintainer role tags (`M`/`m`/`o`), `clone`, `blossoms`, `t`, `alt`, or any tag invented later.

A new module, `amendRepoAnnouncement`, now owns "current announcement + field edits → next unsigned announcement". Tags it knows are rewritten from the edits, in the place the current announcement kept them; **every other tag is carried over verbatim, in its original relative order**, and the event's `content` is preserved. Its edit set already has room for the `relays`, `web` and earliest-unique-commit fields that later NIP-34 conformance work will write.

Every kind:30617 rig publishes — first push, `rig maintainers`, `rig payout` — is now built through it. `buildRepoAnnouncement` is unchanged as a public export (it is `amendRepoAnnouncement` with nothing to amend) and a first push publishes exactly the announcement it did before. `amendRepoAnnouncement`, `AnnouncementEdits`, `ExistingAnnouncement`, `RELAYS_TAG`, `WEB_TAG` and `EARLIEST_UNIQUE_COMMIT_MARKER` are new exports of `@toon-protocol/rig`.
