# Rig

Git with a TOON remote: repo state lives in NIP-34 events on a relay, objects live on Arweave, writes are paid, reads are free. Rig is also the first tenant tooling for TOON Network, and it reuses that project's compute vocabulary unchanged.

## Language

### Compute (from TOON Network)

Terms for leases, workloads, providers, listings, and the Provider Directory are defined in TOON Network's `CONTEXT.md` (toon-protocol/TOON_Network) and are used here with exactly those meanings. In particular: Provider, Tenant, Payer, Workload, Lease, Lease Interval, Spawn, Extension, Capability, Listing, Provider Profile, Liveness, Provider Directory, Template.

_Avoid_: deploy (as a synonym for Spawn), pod, node, marketplace (for the Provider Directory)

### Continuous integration

**Coordinator**:
A rig identity that watches served repos on the relay, runs their workflows, and publishes progress and results as Nostr CI events. It pays for its own writes.
_Avoid_: CI server, bot, runner (when the watching party is meant)

**Runner**:
The party that executes one job and produces its conclusion and logs. In the first slice the coordinator is its own runner on local Docker; later a runner may be a leased workload.
_Avoid_: agent, worker, executor

**Workflow**:
A file in the repo, in GitHub Actions syntax, naming the triggers it responds to and the jobs it runs.
_Avoid_: pipeline, action

**Run**:
One execution of one workflow against one commit, with one trigger reason. Has a progress record while it executes and a workflow result when it concludes.
_Avoid_: build, pipeline run

**Job**:
One named unit of a workflow within a run, with its own conclusion, logs, and artifacts.
_Avoid_: step, task

**Job log**:
The complete output of one job, cleared of injected secret values and stored durably. It is the record of what a job printed; the Job Result names it.
_Avoid_: build log, output (when the whole log is meant)

**Live log tail**:
A short-lived view of the most recent output of a run's unfinished jobs, replaced as the run proceeds and expiring soon after it concludes. It is only ever a view — the job log is the record.
_Avoid_: log stream, streaming logs, tail (unqualified)

**Runner channel**:
The runner's own account of executing a run — cleanup notes, backend output belonging to no job — carried alongside the jobs in a live log tail. It is not a job and never concludes.
_Avoid_: runner job, system job

**Trigger**:
The relay event that causes a run: a push (repository state change), a pull request or its update, or a manual trigger from a maintainer.
_Avoid_: hook, webhook

**Service Request**:
A maintainer's signed, standing authorization for one coordinator to run one repo's workflows, in force until a Service Stop.
_Avoid_: subscription, enrolment

**Trust level**:
How a run's results relate to the repo's maintainers, derived from Service Requests: maintainer-directed, operationally-associated, seen-in-network, or no-known-context.
_Avoid_: verified, official

### Publishing

**Site**:
A static rendering of a ref's tree uploaded to Arweave as a path manifest, optionally named with ArNS.
_Avoid_: deployment, hosting

**Pointer**:
The per-repo HTML page uploaded on push that boots rig-web from Arweave for that repo.
_Avoid_: landing page, redirect

### NIP-34 events

**Earliest unique commit**:
In NIP-34's own wording, the commit that identifies a repo "among forks" and groups it "with other repositories hosted elsewhere that may represent essentially the same project" — usually the repo's root commit. Written as `["r", "<sha>", "euc"]` on the kind:30617 announcement; full NIP-34 text and how rig computes it are in `docs/nip34-wire-shapes.md`.
_Avoid_: root commit (as a synonym — most repos' earliest unique commit IS their root commit, but the two are not defined identically)
