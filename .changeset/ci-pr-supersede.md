---
'@toon-protocol/rig': minor
---

Pull request triggers: a PR update supersedes the previous tip, and `rig ci status` shows PR runs (#130).

When a kind:1619 Pull Request Update reaches a served repo, the coordinator
now cancels every run it still holds for that pull request before queuing the
update's own runs: a run that is still queued concludes `cancelled` without
reaching the Runner, and one in progress is aborted and its Workflow Result
(9842) and final progress marker (39842) say `cancelled`. Previously the old
tip's run finished alongside the new one.

`rig ci status` reports each `pull_request` run's NIP-22 context — the PR
event id and kind, its author, and the PR or PR Update that supplied the
commit — plus `authorIsMaintainer`, derived on the read side from the repo's
kind:30617 (owner ∪ declared maintainers), never from anything the coordinator
asserts. The human output gains one `pull request …` line under each PR run;
the `--json` envelope's runs gain an optional `pr` object.
