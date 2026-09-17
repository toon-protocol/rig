---
'@toon-protocol/rig': patch
---

README: the two act behaviours a real CI workflow hits (#178).

The `rig ci` section explained the control plane but not the job container, so
the first workflow that did actual work went red twice. It now says, next to
the `ci serve` flag table: write `actions/checkout@v4` exactly as you would on
GitHub — act copies the materialized tree in *at that step* and short-circuits
it to a local copy, so it needs no network and no node in the image, and a
workflow without the step runs its tools against an empty container (`could
not find Cargo.toml in /…/work/<repo>-<sha>-1`); and `ubuntu-latest` maps to
`catthehacker/ubuntu:act-latest`, which is not GitHub's hosted runner and
carries no language toolchain, so a workflow expecting a preinstalled `cargo`,
`go` or JDK fails at its first step unless `--platform` names an image that has
one (the official `rust` images ship neither rustfmt nor clippy, and a locally
built image is not usable until #175 lands). A worked Rust workflow carries
both. Docs only, no behaviour change.
