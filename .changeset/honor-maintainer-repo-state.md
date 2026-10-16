---
'@toon-protocol/rig': minor
---

CLI readers (`rig clone`, `rig fetch`, `rig ci serve`) now honor repo state (kind:30618) signed by the owner or a maintainer declared in the owner's announcement, newest wins. The rule is exported as `authorizedAuthors` and `honoredRepoState`; `authorizedStatusAuthors` is renamed `authorizedAuthors` (the old name stays as a deprecated alias). `rig maintainers add/remove` note that maintainers can move refs.
