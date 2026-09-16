---
'@toon-protocol/rig': minor
---

Relay-native CI (#125): `rig ci`, a coordinator, and NIP-C1 events.

A repo published with rig can now run its GitHub-Actions-syntax workflows with
the relay as the only control plane. New verbs under `rig ci`:

- `rig ci serve` runs a **Coordinator**: an ordinary rig identity that watches
  served repos on the relay (pushes, pull requests, manual triggers), materializes
  the commit from the relay and Arweave with the free read path, runs the matching
  workflows with `act` on Docker, uploads logs and artifacts to the TOON store, and
  publishes NIP-C1 progress (39842), job results (9841), and workflow results (9842)
  as paid writes from its own channel. It is request-required: it serves a repo
  only while a Service Request from the owner or a declared maintainer is in force.
- `rig ci request` / `rig ci stop` publish the Service Request (9843) and Service
  Stop (9844) that authorize and revoke a coordinator for a repo.
- `rig ci trigger` publishes a Manual Trigger (9840) for one exact workflow file
  (path + content SHA-256) on one commit.
- `rig ci secret set|remove` publish a Repository Secret Update (29846), NIP-44
  encrypted to the coordinator's advertised key with a fresh sender key; secrets
  are injected only into runs a maintainer caused, never into a stranger's PR.
- `rig ci status <commit>` (free) lists every run and job for a commit with its
  trust level, emits one JSON document under `--json`, honours
  `--require-ci-trust <level>`, and exits non-zero unless every run is green, so a
  merge gate is one command.

The runner sits behind one `Runner` interface (`FakeRunner` for tests, `ActRunner`
for act on Docker) so a TOON-lease runner can replace it without touching the
coordinator. `packages/rig/Dockerfile` packages the coordinator with act and a
Docker client. The library exports the NIP-C1 builders and parsers, secret
payload crypto, and trust derivation.

rig-web (not published) gains an Actions tab, a per-run page, and CI status dots
on commits and pull requests, rendered from the same events with live updates.
