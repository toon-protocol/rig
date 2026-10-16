---
'@toon-protocol/rig': minor
---

`rig pr create --revises <patch-id>` publishes a patch as a NIP-34 revision of an existing one (works with `--range` and `--patch-file`; warns when readers will ignore it). `rig pr show` shows the latest revision by the root's author or an authorized author and lists the earlier ones; `rig pr list` shows a revised patch once. Exports `selectRevision`.
