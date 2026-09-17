---
'@toon-protocol/rig': patch
---

`rig ci serve` takes `--pull` / `--no-pull` (#175).

`ActRunnerOptions.pull` already appended `--pull=false` to act's argv, but
nothing on the `rig ci serve` command line could set it, so every run
force-pulled the image named by `--platform`. A runner image built or loaded on
the coordinator host — the normal way to give jobs a toolchain without paying
for a download on every run — was therefore unusable: each job failed in *Set up
job* with `pull access denied`, and that failure is what got published to the
relay as the Job Result. act's own `.actrc` was no escape hatch either, since
act runs with the freshly materialized checkout as its working directory.

`--no-pull` now runs the image already on the host; `--pull` states act's
default explicitly. Giving both is a usage error, and giving neither leaves
act's default untouched.
