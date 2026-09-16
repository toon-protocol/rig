# @toon-protocol/rig

**Git, with a TOON remote.** `rig` is a drop-in `git` wrapper that publishes your
repository to the TOON network — a decentralized control plane where repo state
lives in NIP-34 Nostr events and the objects live on Arweave.

- **Reads are free** — clone, fetch, and browse issues/PRs need no identity, no
  wallet, nothing configured.
- **Writes are paid** — pushing objects and publishing events spends from a
  payment channel funded by your wallet. Writes are permanent and non-refundable.
- **One node URL is the whole network configuration** — `rig` embeds its own
  payment client (`@toon-protocol/client` 3.x) built from your seed phrase and
  pays the TOON connector you name with `rig entry <url>`. The node describes
  itself on `GET /ilp`; there is nothing to discover (see
  [Pointing at a node](#pointing-at-a-node)).

`rig` owns a handful of TOON verbs (`init`, `remote`, `clone`, `fetch`, `push`,
`issue`, `pr`, `comment`, `identity`, `fund`, `balance`, `channel`, `ci`). **Every other
command passes through to system `git` verbatim** — `rig status`, `rig add -p`,
`rig commit`, `rig rebase -i` all behave exactly like git.

---

## Install

```sh
npm install -g @toon-protocol/rig
rig --version
```

Requires Node.js and a system `git` on your `PATH` (rig shells out to it for all
passthrough commands and object plumbing).

---

## From your code to a published repo

This is the full happy path: an idea on your disk → a repository anyone can clone
from TOON. It uses the shared **devnet** (free faucet money) so you can complete
it end to end without spending anything real.

### 1. Start with your code

Already have a git repo? `cd` into it. Starting fresh? An empty directory is fine —
`rig init` will offer to `git init` for you in the next step.

```sh
mkdir hello-toon && cd hello-toon
echo "# hello-toon" > README.md
```

### 2. Create an identity

Your identity is a BIP-39 seed phrase; its derived Nostr pubkey is who *owns* the
repo, and its wallet is what *pays* for writes. Mint one on the spot — the phrase is
shown **once**, so write it down. It's stored in an encrypted keystore under
`~/.toon-client`.

```sh
rig identity create
rig identity show        # your active pubkey + npub (never the phrase)
```

Already have a phrase? Bring it instead: `export RIG_MNEMONIC="abandon abandon … about"`
(or `rig identity import`, which reads the phrase from stdin). See
[Identity](#identity) for the full resolution order.

### 3. Set up the repo

One free command wires everything together: it writes `toon.repoid` / `toon.owner`
into the repo's **local** git config, and sets the repo-local git commit author to
your Nostr identity so `rig commit` works out of the box.

```sh
rig init                      # repo id defaults to the directory name
# rig init --repo-id hello-toon        # …or name it explicitly
# rig init --git-init --generate-identity   # fully non-interactive fresh setup
```

Not a git repo yet? `rig init` offers to `git init` (or pass `--git-init`). No
identity yet? It offers to generate one (or pass `--generate-identity`).

### 4. Point at a node, and at its relay

Two addresses, one node. The **connector** is where paid writes go: it is an
`https://` URL, and its `GET /ilp` describes everything rig needs (the routes it
prices, the chains it settles on, the key packets are sealed to). The **relay**
is where free reads come from, configured as a **real git remote** — `origin` is
your default publish target, and it also tells `rig fund` (next step) which
faucet to use.

```sh
rig entry https://proxy.relay.devnet.toonprotocol.dev   # the shared devnet relay node
rig remote add origin wss://relay-ws.devnet.toonprotocol.dev
rig remote list
```

`rig entry` shows what is in effect; `TOON_CONNECTOR` overrides it per shell.
Any node works the same way — its operator hands you these two URLs.

### 5. Fund your wallet

Pushing is paid, so your wallet needs a balance. On devnet, `rig fund` drips test
**USDC** (the settlement token) to both supported chains — it's free and needs no
faucet URL because it infers devnet from your `origin` remote. The drip assumes
your wallet already holds enough native gas (the EVM leg still best-effort tops
up Base Sepolia gas; hold a little SOL for Solana).

```sh
rig fund                 # devnet USDC drip, both chains
rig fund sol             # or fund a single chain: evm | sol
rig balance              # confirm the funds landed
```

Prefer a browser? The same faucet has a web UI at
**<https://faucet.devnet.toonprotocol.dev>** — pick a chain, paste an address,
get USDC. (See [Devnet](#devnet) for the API routes; contract addresses are
read from the node's `GET /ilp`, never configured.)

> On any non-devnet network there is no faucet: `rig fund` prints your wallet
> address(es) so you can fund them externally, then `rig push` draws from there.

### 6. Commit your work

This is just git — unowned commands pass straight through, and step 3 already set
your commit author.

```sh
rig add -A
rig commit -m "initial commit"
```

### 7. Push — the paid publish

`rig push` uploads your objects to Arweave and publishes the NIP-34 refs event
(plus the repo announcement on the first push). It prints a **fee table** — refs,
object count, bytes, itemized and total fee — and asks you to confirm before
spending. On this first paid write it **opens a payment channel from your funded
wallet automatically** (recorded and reused on later pushes; no manual
`rig channel open` needed).

```sh
rig push                 # plan + price the current branch, confirm, then publish
# rig push main --yes    # a specific ref, skipping the confirm prompt
```

That's it — your repository is live on TOON. 🎉

### 8. Verify it's live

Clone it back from a clean directory (a free read) to prove the round-trip. Use
your own pubkey as the owner — `rig identity show` prints it as an `npub1…`.

```sh
cd /tmp
rig clone wss://relay-ws.devnet.toonprotocol.dev npub1youriden…/hello-toon
cd hello-toon && rig log --oneline
```

You can also browse the repo (code, commits, issues, PRs) in the **Rig web UI**,
which reads the same relay + Arweave data your CLI just wrote.

> **Propagation note:** freshly pushed objects can take **10–20 minutes** to become
> fetchable from Arweave gateways. A `rig clone` / `rig fetch` right after a push
> reports any not-yet-propagated SHAs honestly — just retry after a few minutes. A
> failed clone never leaves a partial repo behind.

### Keep working

Iterate exactly like git; re-pushing only pays for **new** objects (uploads are
content-addressed, so known objects are skipped for free).

```sh
rig add -p && rig commit -m "add a feature"
rig push
```

### Collaborate

Issues, comments, and patches are paid writes against the same repo config; reading
them is free.

```sh
# reads (free)
rig issue list
rig pr list --state open
rig pr show <event-id> --json | jq -r .pr.content | git am   # apply a patch locally

# writes (paid)
rig issue create --title "Fix the flux" --body "It broke."
rig comment <root-event-id> --body "Nice catch."
rig pr create --title "Add feature" --range main..feature
rig pr status <event-id> applied
```

---

## Command reference

| command | cost | what it does |
| --- | --- | --- |
| `rig identity create` | free | mint a fresh BIP-39 identity into the encrypted keystore — the phrase is shown ONCE |
| `rig identity show` | free | the active identity's source + derived pubkey (never the phrase) |
| `rig identity import` | free | write an existing phrase (read from stdin, never argv) to the keystore |
| `rig init` | free | one-shot repo setup: git repo + identity + `toon.*` config + repo-local git commit-author from your Nostr identity |
| `rig remote add/remove/list` | free | relays as REAL git remotes (`origin` = default publish target) |
| `rig fund [chain]` | free | devnet USDC drip (gas assumed) to the active identity's wallet; `chain` = evm \| sol \| all; prints addresses to fund externally off-devnet |
| `rig balance` | free | the active wallet's multi-chain balances |
| `rig clone <relay-url> <owner>/<repo-id> [dir]` | free | bootstrap a repo from TOON: relay state + SHA-verified Arweave objects → a real git repo. Shadows `git clone` |
| `rig fetch [remote]` | free | download the missing object delta + update `refs/remotes/<remote>/*`. Shadows `git fetch` |
| `rig push [remote] [refspecs...]` | **paid** | the TOON push: Arweave upload + NIP-34 refs publish. Shadows `git push` |
| `rig issue list` / `rig issue show <id>` | free | the repo's issues + comments from the terminal |
| `rig pr list` / `rig pr show <id>` | free | the repo's patches/PRs; `show` prints the full patch text (pipe to `git am`) |
| `rig issue create` | **paid** | file an issue (kind:1621) |
| `rig comment <root-event-id>` | **paid** | comment (kind:1622) on an issue/patch |
| `rig pr create` | **paid** | publish a patch (kind:1617) from real `git format-patch` |
| `rig pr status <event-id> <state>` | **paid** | set issue/patch status (kind:1630–1633) |
| `rig site publish [ref]` | **paid** | deploy a pushed repo as a permaweb site: build the ar.io path manifest (repo paths → Arweave txids) and upload it as one paid store write; prints the gateway URL |
| `rig site url [ref]` | free | print the last-published site URL for a ref |
| `rig name status <name>` | free | an ArNS name's registry record, ANT process, and current target txId |
| `rig name buy <name>` / `rig name set <name> <txId>` | **paid¹** | buy an ArNS name / point it at an Arweave txId. On the devnet, buy/set default to brokering through the deployed store DVM (`--direct` opts out). ¹Paid in mARIO on Solana via the ar.io registry — **not** ILP; needs the optional `@ar.io/sdk` dep |
| `rig ci request <coordinator>` / `rig ci stop <coordinator>` | **paid** | authorize / revoke a CI coordinator for this repo (kind:9843 / 9844) |
| `rig ci trigger <coordinator> --workflow <path>` | **paid** | run one exact workflow (path + SHA-256) on one commit (kind:9840) |
| `rig ci secret set\|remove <coordinator> NAME[=value]` | **paid** | CI secrets, NIP-44 encrypted to the coordinator (kind:29846); values never echoed |
| `rig ci status <commit>` | free | every run + job for a commit with trust levels; `--json` is one document; exits non-zero unless all green |
| `rig ci serve --relay <url> --repo <owner>/<id>` | **paid** (its own wallet) | run a coordinator: watch the relay, run workflows with act on Docker, publish NIP-C1 results |
| `rig channel list/open/close/settle` | free / **paid** | inspect or manage the payment channels paid commands hold (`rig channels` = `rig channel list`) |
| `rig chain [set <c>\|unset]` | free | pin which chain/USDC settles paid writes: evm \| sol (default: the first chain the node settles on that your identity holds a key for) |
| `rig entry [<connector-url>\|clear]` | free | name the TOON connector paid writes go to (`--relay <wss-url>` records its free-read relay too); bare `rig entry` shows what is in effect |
| `rig help` / `rig --version` | free | usage / version |
| everything else | — | executed as `git <args...>` with rig's stdio and git's exit code |

Every paid command supports `--yes` (skip the confirm prompt; **required** when
stdin is not a TTY) and `--json` (a `--json` run *without* `--yes` is a free
estimate — nothing is executed or paid).

---

## Money: fund, balance, channels

Paid commands spend from a **payment channel** — an on-chain-collateralized channel
between your wallet and a payment peer, from which each write draws an off-chain
claim. You rarely touch this directly:

- **`rig fund`** tops up your wallet (devnet faucet, or prints addresses to fund
  externally). Both the native coin (gas) and USDC (collateral) are needed.
- **`rig balance`** shows what your wallet holds across chains.
- **Channels open lazily.** The first paid write opens a channel from your funded
  wallet and records it under `~/.toon-client` (`rig-channels.json`); later writes
  resume the same channel instead of opening a new one.
- **`rig channel list`** (free) shows current holdings and nonce watermarks.
  **`rig channel open`** pre-opens one (or `--deposit`s more collateral) using the
  exact lazy-open path; **`rig channel close`** starts the settlement challenge
  window; **`rig channel settle`** releases collateral once the window elapses.

The `open`/`close`/`settle` lifecycle commands are on-chain wallet operations (gas +
collateral movement), so they follow the same confirm idiom as `push`: they print
what will happen, then require `--yes` or an interactive confirm.

---

## Permaweb sites & ArNS names (Arweave)

Every `rig push` already stores your repo's file bytes on Arweave. Two more verbs
turn a pushed repo into a permanent, human-named website — *GitHub Pages, but
permanent and named.*

### `rig site` — a pushed repo as a website

`rig site publish [ref]` builds an
[ar.io path manifest](https://specs.ar.io/#/en/manifests/1.0.0) (`index.html`
routing) from the ref's tree joined with the objects already on Arweave, uploads it
as **one paid store write**, and prints a servable URL:

```sh
rig site publish                      # publish the current branch as a site
# rig site publish main --spa         # SPA routing: serve index.html for unknown paths
# rig site publish --force-reupload   # re-pay to re-upload blobs stored without a Content-Type
rig site url                          # (free) print the last-published site URL for a ref
```

```
https://<gateway>/<manifestTxId>/
```

`rig push` now tags each uploaded blob with a `Content-Type` derived from its path,
so files render in a browser instead of downloading as `application/octet-stream`.
Blobs pushed **before** this change serve as octet-stream until re-uploaded with
`--force-reupload` (a fresh paid write). Site assets are bounded by rig's per-object
size cap — fine for typical static sites.

The manifest txId **changes on every push**, so the stable pointer is an ArNS name.

### `rig name` — a human name for a txId (ArNS)

[ArNS](https://ar.io) (the ar.io Name System) is Arweave's naming layer: a registered
name resolves at every ar.io gateway as `https://<name>.<gateway>/`, serving whatever
txId its record points at. Names are owned and paid by **this identity's own Solana
key** — derived from the same mnemonic as everything else, so no new key material:

```sh
rig name status <name>                # (free) registry record, ANT process, current target
rig name buy <name> --years 1         # buy a name (estimate → confirm → execute)
rig name set <name> <manifestTxId>    # point the name at your published site's manifest
```

Put together — one mnemonic, end to end:

```sh
rig push && rig site publish && rig name set my-app <manifestTxId>
# → https://my-app.<gateway>/
```

> **Real funds, a different rail from ILP.** `rig name buy`/`set` spend **mARIO on
> Solana via the ar.io registry program** — *not* through TOON's ILP payment channels
> (the rail behind `rig push` / `rig site publish` fees). `rig name` needs the
> optional [`@ar.io/sdk`](https://docs.ar.io) dependency (>= 4.0.3, the
> Solana-native release); install it if the command reports it missing.
> `rig name status` is a free, signerless read. As with every paid verb, these are estimate → confirm →
> execute, and a `--json` run *without* `--yes` is a free estimate — nothing is spent.

#### Network program ids (`--network` / `RIG_ARIO_NETWORK`)

`--network` selects which cluster's **ar.io registry programs** every `rig name`
verb targets. The ids come from the installed `@ar.io/sdk` (>= 4.0.3) at runtime
(`ARIO_*_PROGRAM_ID` for mainnet, `DEVNET_PROGRAM_IDS` off it) — this table is
the human-readable snapshot (verified live 2026-07-17), useful when auditing
`--process-id` overrides or block-explorer output:

| Program | `--network mainnet` (default) | `--network devnet` |
|---|---|---|
| ario-core | `73YoECm6NKXpVRoe5f1Q9BcP5DJGPFUjnFy6AxBE5Nvh` | `8Njx9wPkXiNzDCgjwVsJFRjpAEV34gGW3n8DzX3V23m1` |
| ario-gar | `89fNiiwgpFSPHKuqfNUkgYTYjtAJAhyqHjXmgXeppGpf` | `7WsDTrtZBsfKtnP33XkjuqXCY69JE7n4QVYpynqJCFxz` |
| ario-arns (name registry) | `2yCUx5edFvUrkibYaUa2ZXWyx9kuJkS8CwyzsgHPWdZZ` | `6EZNezcg4rc5hnh8HG34vGquT3WpW5xXypzPb24uyEpp` |
| ario-ant (ANT state) | `2MWexMHfMhGJwMHv9Qm9YAVCqjUFUJwDJAysW4oCUGk5` | `DbHbRwUD1oAn1mrDSqtWtvwGcNrmhWdD2g8L4xmeQ7NX` |

- **There is no `--network testnet`**: ar.io deploys nothing on Solana's testnet
  cluster (#376/#381) — the flag rejects it up front.
- Every spawned ANT is an **MPL Core** asset (`CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d`,
  same id on every cluster); the asset pubkey is the SDK's `processId`.
- Free devnet test loop (#381): ARIO faucet `https://faucet.services.ar-io.dev/` →
  `rig name buy --network devnet` → `rig name set` → resolves at the
  devnet-connected gateway `https://<name>.ar-io.dev/`. ⚠️ That gateway is
  ar.io's **testnet** and resolves devnet names ONLY; a **mainnet** name never
  appears there (nor on `arweave.net`, which runs a forked ArNS). Check mainnet
  names on a mainnet gateway, e.g. `https://<name>.permagate.io/` or
  `https://<name>.ardrive.net/`.
- `--process-id <id>` overrides the arns registry program outright (wins over
  `--network`) — for pointing at a fresh/staging registry deployment.

---

## Continuous integration: `rig ci`

A repo published with `rig` gets CI without leaving TOON. The **relay is the
only control plane**: every command that changes a coordinator's behaviour is a
signed, paid relay event, every observation is a free relay read, and there is no
HTTP between a maintainer and a coordinator. The wire contract is
[NIP-C1 (Nostr CI)](../../docs/specs/nip-c1.md), adopted verbatim so ngit tooling
can read rig's events.

**Roles** (the words are `CONTEXT.md`'s):

- A **Coordinator** is an ordinary rig identity — its own BIP-39 phrase, wallet and
  payment channel — that runs `rig ci serve`. It watches the repos it serves on the
  relay, materializes each triggering commit from the relay + Arweave with the
  free read path (no GitHub, no git server), runs the matching
  GitHub-Actions-syntax **Workflows** from `.github/workflows/` (and
  `.ngit/act/workflows/`) with [`act`](https://github.com/nektos/act) on Docker,
  uploads logs and artifacts to the TOON store, and publishes NIP-C1 progress
  (kind:39842), **Job** results (9841) and **Run** results (9842) as paid writes
  from its own channel. Its budget is its wallet balance; the maintainer's phrase
  is never on the coordinator host.
- A **maintainer** authorizes a coordinator with a **Service Request** (9843) and
  revokes it with a Service Stop (9844). rig's coordinator is *request-required*:
  it never runs a repo nobody asked it to, and it only honours Requests signed by
  the repo owner or a declared maintainer (`rig maintainers`).
- **Triggers**: a push (a new kind:30618 whose refs moved), a pull request or PR
  update (kinds 1617/1618/1619 — rig's own `rig pr create` patches included),
  or a Manual Trigger (9840) from a maintainer. A pull request runs the
  workflows with `on: pull_request`; its events carry NIP-22 tags back to the PR
  (`E`/`K`/`P` root, `e`/`k`/`p` for the update that supplied the commit) and
  no git ref. A PR update supersedes the previous tip: the earlier run for that
  PR, queued or in progress, concludes `cancelled` before the new one starts.
  `rig ci status` shows a PR run's PR event id and whether its author is the
  repo owner or a declared maintainer (`pr.authorIsMaintainer` in `--json`).
- The **Runner** is behind one interface. The first implementation is act on the
  host's Docker; a TOON-lease runner is a later class behind the same seam.

### Maintainer side

```sh
rig ci request <coordinator>            # authorize <coordinator> (npub or hex) for this repo — paid (9843)
rig ci stop <coordinator>               # revoke it — paid (9844)
rig ci trigger <coordinator> --workflow .github/workflows/ci.yml [--commit <sha>] [--ref refs/heads/main]
                                        # re-run / run one exact workflow on one commit — paid (9840)
rig ci secret set <coordinator> DEPLOY_TOKEN=…   # CI secrets, encrypted to the coordinator — paid (29846)
rig ci secret set <coordinator> NPM_TOKEN        # bare NAME reads the value from stdin
rig ci secret remove <coordinator> OLD_TOKEN
rig ci status <sha> [--json] [--require-ci-trust maintainer-directed] [--workflow <path>]   # free
```

The paid verbs take the same flags as `rig issue`/`rig pr` (`--repo-id`,
`--owner`, `--remote`, `--relay`, `--yes`, `--json`): they quote the fee, ask for
confirmation (`--yes` skips; `--json` without `--yes` is a free estimate), and
publish exactly one event to the repo's `origin` relay. `rig ci trigger` reads
the workflow file at `<commit>` from the local repository and puts its path
**and SHA-256** in the event, so the coordinator can prove which file ran.

Secrets are NIP-44 v2 encrypted to the `secrets-key` the coordinator advertises
(kind:19843) with a **fresh sender key per update**: the relay sees who sent an
update and which repo/coordinator it addresses, never the names or values. The
coordinator injects secrets only into runs a maintainer caused (pushes, manual
triggers) and gives a third-party pull request an **empty** secret set, so a
contributor cannot exfiltrate them. Values are never echoed by rig, in any mode.

`rig ci status <commit>` is the merge gate: one line per run (conclusion,
workflow, trigger reason, coordinator, trust level, wall-clock time once
concluded), one indented line per job (conclusion, exit code, duration) and a
summary; with `--json` exactly one document (`ok`, `runs[]` with each run's and
job's event id, conclusion, timings — `queuedAt`/`startedAt`/`concludedAt` —
log and artifact URLs, `summary`). It exits **0** only when at least one run
counted and every counted run concluded green (`success`/`neutral`/`skipped`);
**1** when a run is red, still queued/in progress, or nothing was found.
`--require-ci-trust <level>` drops runs below that level before counting, so a
passing run from an unknown coordinator does not count as green.

**Trust levels** are derived client-side from Service Requests and the repo's
declared maintainers, strongest first:

| level | meaning |
| --- | --- |
| `maintainer-directed` | the run quotes a Service Request (or Manual Trigger) signed by the owner or a declared maintainer |
| `operationally-associated` | no quote on the run, but a maintainer's Request for that coordinator was in force when it ran |
| `seen-in-network` | the coordinator is itself a maintainer, or someone (not a maintainer) requested it for this repo |
| `no-known-context` | nothing links the coordinator to the repo — e.g. a contributor's own coordinator checking their branch |

### Running a coordinator

```sh
# on the coordinator host, with Docker available
export TOON_CLIENT_HOME=~/.rig-ci             # keep the coordinator's identity + state apart from yours
rig identity create                            # a SEPARATE phrase — never the maintainer's
rig entry https://<connector> --relay wss://<relay>
rig fund                                       # devnet; elsewhere fund the printed address — its balance IS the CI budget
rig ci serve --relay wss://<relay> --repo <owner-npub>/<repo-id> [--repo …]
```

`rig ci serve` flags:

| flag | default | what it does |
| --- | --- | --- |
| `--relay <url>` | (required) | the ONE relay to subscribe to and publish on |
| `--repo <owner>/<repo-id>` | (required, repeatable) | repos to watch; each is served only while a maintainer's Service Request is in force |
| `--requester <pubkey>` | (none) | also accept Service Requests from this pubkey (repeatable) — a contributor's own coordinator for a repo they do not maintain; its runs show as lower trust |
| `--concurrency <n>` | `1` | bounded run slots — more pushes queue (`queue` rounds are published on the progress event) |
| `--requester <npub\|hex>` | (none) | also accept Service Requests from this pubkey (NIP-C1 operator policy; repeatable) — for running your own coordinator against a repo you do not maintain; such runs show as `seen-in-network` |
| `--timeout <secs>` | `1800` | wall clock per run; a hung run concludes `timed_out` |
| `--gateway <url>` | rig's preferred Arweave gateway | prefix for log/artifact URLs (`<gateway>/raw/<txId>`) |
| `--act-bin <path>` | `act` on PATH (or `RIG_ACT_BIN`) | the act binary |
| `--platform <label>=<image>` | `ubuntu-latest=catthehacker/ubuntu:act-latest` | `runs-on` label → Docker image (repeatable) |
| `--workdir <dir>` | `<state-dir>/work` | where commits are materialized |
| `--once` | | stop after the first run concludes (its 9842 and final 39842 are on the relay) — one `rig ci trigger` answered by one bounded serve; ignored or refused triggers do not count |
| `--json` | | one JSON document with the coordinator, relay, repos and state dir on start |

On start the coordinator publishes an **Advertisement** (19843: runner family
`act`, its selectors, admission `maintainer-request`, execution
`request-required`, billing `out-of-band`, and a fresh `secrets-key`) and renews
it before it expires. State — the per-repo cursor of the last processed event and
the decrypted secret inventory — lives under
`$TOON_CLIENT_HOME/rig-ci/<coordinator-pubkey>/`, so a restart resumes where it
left off and a relay blip loses no runs. The secrets key itself is never
persisted and rotates every start (NIP-C1), so re-send secrets after a restart.
Every value injected into a run — each line of a multi-line value, and its
URL-encoded and JSON-escaped forms — is redacted (`***`) from that run's job
logs before they are uploaded to the store and before the log tail goes into
the Job Result (9841); an artifact whose bytes contain a value is not uploaded
at all. Values shorter than 4 bytes are not redacted.
When the wallet cannot pay for the writes a run needs, the coordinator says so on
stderr and starts no run rather than half-publishing one.

Each run publishes, in order: `39842 queued` → `39842 in_progress` (with the
frozen Service Request quote) → one `9841` per job (log tail in the content, full
log and artifacts as store URLs) → `9842` → `39842 concluded`. Every event carries
the repo address, the commit, the workflow path + SHA-256 (`w`), and the
normalized trigger reason (`o`), so a consumer can verify what ran.

**Departures from ngit's reference coordinator**, all deliberate: logs and
artifacts go to the **TOON store** and are referenced by gateway URL (TOON has no
Blossom); the Advertisement's billing policy is `out-of-band` (the operator funds
the coordinator); kind:1617 patches are accepted as pull-request triggers (the
coordinator applies the patch on its declared parent) because that is what
`rig pr create` publishes; and the coordinator's inbox relay is the repo relay
(`--relay`), so `rig ci secret` publishes to the same place as everything else.
Not in this slice: renting runners from a TOON provider, kinds 19844/39844,
schedule triggers, and encrypting logs.

### Packaging

`packages/rig/Dockerfile` builds an image with rig, act and a Docker client
(`docker build -f packages/rig/Dockerfile -t rig-ci .` from the workspace root).
Run it with the host's Docker socket and a state volume mounted:

```sh
docker run --rm -v /var/run/docker.sock:/var/run/docker.sock -v rig-ci-state:/state \
  -e RIG_MNEMONIC='<coordinator phrase>' -e TOON_CONNECTOR=https://<connector> \
  rig-ci ci serve --relay wss://<relay> --repo <owner>/<repo-id>
```

This is the shape a TOON workload will later spawn.

### Dogfooding: rig's own `ci.yml` on the sandbox

The [TOON sandbox](https://github.com/toon-protocol/infra/tree/main/sandbox)
(full profile — the store and gateway are needed for uploads, so `make up`, not
`make up-payments`) is a complete network on one machine: relay
`ws://localhost:7100`, hub `http://localhost:3200`, store edge
`http://localhost:3210`, gateway `http://localhost:3000`. Two identities, both
settling on Solana:

```sh
# common env for BOTH shells (each identity gets its own TOON_CLIENT_HOME)
export TOON_CONNECTOR=http://localhost:3200 TOON_CLIENT_RELAY_URL=ws://localhost:7100
export TOON_CLIENT_CHAIN=solana TOON_CLIENT_RPC_URL=http://localhost:8899
export TOON_CLIENT_STORE_SEAL_TO=http://localhost:3210 RIG_ARWEAVE_GATEWAY=http://localhost:3000

# maintainer shell
export TOON_CLIENT_HOME=/tmp/rig-maintainer; rig identity create; rig fund   # prints the Solana address: airdrop SOL + mint mock USDC to it (sandbox keys/toon/usdc-authority.json)
cd rig && rig init && rig remote add origin ws://localhost:7100 && rig push --yes

# coordinator shell
export TOON_CLIENT_HOME=/tmp/rig-coordinator; rig identity create; rig fund   # fund this one the same way
rig ci serve --relay ws://localhost:7100 --repo <maintainer-npub>/rig --gateway http://localhost:3000

# maintainer shell again
rig ci request <coordinator-npub> --yes
git commit --allow-empty -m 'ci: dogfood' && rig push --yes
rig ci status HEAD --json | jq .summary
```

The same flow, end to end and asserted, is
`src/__integration__/ci-sandbox.integration.test.ts`; it runs only with
`RIG_CI_SANDBOX=1` and skips itself unless the sandbox's relay, hub, store edge
and gateway all answer. The act-on-Docker runner test (`src/ci/act-runner.test.ts`)
is likewise opt-in: set `RIG_ACT_BIN` to an act binary with Docker reachable.

---

## Pointing at a node

A TOON connector is a paid reverse proxy in front of an ordinary app (a relay, a
store). It describes itself on **`GET /ilp`** (connector ADR 0050): its ILP
addresses, the routes it prices, the settlement chains it accepts and the key a
payload is sealed to. That one document is everything rig reads about the
network — there is no announce to discover (kind:10032 was removed by connector
ADR 0046) and no topology to negotiate.

```sh
curl -s https://proxy.relay.devnet.toonprotocol.dev/ilp | jq '{ilpAddresses, routes, settlements: [.settlements[].chain]}'
```

What rig derives from it, and the knob that overrides each:

| fact | default | override (env / `~/.toon-client/config.json`) |
|---|---|---|
| the connector | — (required) | `TOON_CONNECTOR` / `connectorUrl` (`rig entry <url>` writes it) |
| where events go | the node's first own address it also prices | `TOON_CLIENT_PUBLISH_DESTINATION` / `publishDestination` |
| where git objects go | the node's first priced `*.store` route, else `*.ario` | `TOON_CLIENT_STORE_DESTINATION` / `storeDestination`; `rig name --via` per invocation |
| a store on another node | — | `storeConnectorUrl` (that node holds its own channel: uploads ride a second client and watermark) or `storeSealTo` (same channel, sealed to that node) |
| settlement chain | the first chain in `settlements[]` your identity holds a key for | `TOON_CLIENT_CHAIN` / `chain` — `evm` or `solana` (`evm:8453` is read by its family) |
| chain RPC | the client's devnet preset | `TOON_CLIENT_RPC_URL` / `rpcUrl` / `chainRpcUrls[<chain>]` — **set this for a mainnet node** |
| who pays | the phrase's key on that chain | `RIG_SOLANA_KEY_FILE` / `solanaKeyFile` (a `solana-keygen` JSON), `RIG_EVM_PRIVATE_KEY` / `evmPrivateKey` |
| claim watermark file | `<TOON_CLIENT_HOME>/channels.json` | `TOON_CLIENT_CHANNEL_STORE` / `channelStorePath` — one file per channel writer, or two processes replay each other's nonces |
| first-open collateral | the client default | `TOON_CLIENT_DEPOSIT` / `deposit` (base units) |
| carriage | `auto` (HTTP unless the node requires BTP) | `TOON_CLIENT_TRANSPORT` / `transport` |

**Prices are schedules.** A route publishes a base price and, when it meters by
size, a `pricePerKib` (connector ADR 0065). `rig push`'s fee table prices every
object by its sealed size with the same rule the client puts on the claim, so
the estimate equals what is paid.

**Who pays and who signs are independent.** The repo owner is the phrase's
Nostr key at `m/44'/1237'/0'/0/<account>` — unchanged from every earlier rig.
Its EVM wallet is that same key (the client's `keyDerivation: 'legacy'`, rig's
default, so channels an existing identity funded are still its own); set
`TOON_CLIENT_KEY_DERIVATION=standard` for a fresh identity you want to import
into MetaMask. The payer key may be a different key entirely: the connector
attributes payment from the claim, never from the event.

### Devnet

The shared devnet's nodes and the faucet (authoritative:
[toon-meta `docs/deployment.md`](https://github.com/toon-protocol/toon-meta/blob/main/docs/deployment.md);
the node URLs are also `@toon-protocol/client`'s `DEVNET` preset):

| What | URL |
|---|---|
| Faucet (web UI + API) | `https://faucet.devnet.toonprotocol.dev` |
| Relay node (paid writes: `rig entry`) | `https://proxy.relay.devnet.toonprotocol.dev` |
| Relay (free reads: `rig remote add origin`) | `wss://relay-ws.devnet.toonprotocol.dev` |
| Store route (`--via` for ArNS jobs) | an ILP **destination** the node prices, e.g. `g.toon.relay.store` |

`--via` names an ILP destination rather than an HTTP endpoint. The store sits
behind the connector's payment termination, so it has no public job endpoint to
POST to, and a reachable one would be an unpaid path to a paid handler. The
kind:5095 buy and kind:5096 gas-station jobs therefore travel as paid packets,
exactly as `rig push`'s git-object writes do.

Faucet routes (`POST`, body `{"address": "<wallet>"}`):

| path | drips |
|---|---|
| `/api/base-sepolia/request` | 1000 USDC (ungated on-chain mint) + best-effort Base Sepolia gas |
| `/api/solana/usdc-request` | 1000 USDC (treasury transfer, no SOL leg) |

`rig fund` hits the two USDC-only routes for the identity's derived wallets —
it funds USDC and assumes gas is already present.

Settlement facts (contract and program addresses, token mints) are **read from
the node's `GET /ilp`, never configured** — the table that used to sit here went
stale the first time a contract moved. Base Sepolia's official RPC
(`sepolia.base.org`) is a load-balancer that serves stale reads; channel opens
want a single-backend RPC such as `base-sepolia-rpc.publicnode.com`.

---

## Identity

The CLI is **standalone by default**: it embeds its own payment client built from
your seed phrase (`@toon-protocol/client` is a regular dependency, installed
automatically) — no daemon is ever required.

**No phrase yet? Generate one — `rig identity create`.** It mints a fresh BIP-39
mnemonic, shows it ONCE with a backup warning, and writes it to the encrypted
keystore under `TOON_CLIENT_HOME`. It refuses to overwrite an existing identity
without `--force`. `rig identity show` reports the active source + pubkey (never the
phrase); `rig identity import` writes an existing phrase (read from stdin, never a
CLI argument) to the keystore. `--json` on **`create`** is the ONE sanctioned path
that emits the phrase (in a `mnemonic` field — treat as secret); `show`/`import`
never do.

The mnemonic is resolved along one precedence chain — highest first:

1. `RIG_MNEMONIC` environment variable
2. `TOON_CLIENT_MNEMONIC` environment variable — deprecated alias, warns on stderr;
   rename it to `RIG_MNEMONIC`
3. project-local `.env` — found by walking up from the working directory (through
   the repo root); ONLY the `RIG_MNEMONIC` line is parsed out of it. **Gitignore
   it** — the phrase must never be committed.
4. the shared `~/.toon-client` state dir (`TOON_CLIENT_HOME` override): encrypted
   keystore (`keystorePath` + `TOON_CLIENT_KEYSTORE_PASSWORD`), then the `mnemonic`
   config field

The BIP-44 account index follows the same env-over-config rule: the
`RIG_ACCOUNT_INDEX` environment variable always wins; the shared config's
`mnemonicAccountIndex` applies ONLY when the phrase itself came from the shared
state dir (tier 4); otherwise account 0. An explicit `RIG_MNEMONIC` therefore
derives the same identity no matter which `TOON_CLIENT_HOME` is active — a
per-home config never silently shifts an explicitly provided identity.

Every paid command reports which source is active and the derived pubkey
(`Identity: <pubkey> (from …)`, and an `identity` object in `--json` output) — the
phrase itself is never printed and never written to git config or any repo file.

## What a paid command does first

Every standalone paid command bootstraps the same way: resolve the identity,
read the connector's `GET /ilp`, open or adopt the payment channel with that
node, then sign one claim per packet. Adoption is free — a channel's id derives
from its participants, so a node you have paid before is found again without a
transaction. Money state (the claim watermark, the channel map) lives under
`TOON_CLIENT_HOME` and is never cached away.

Two rig processes on one identity race the claim nonce, so a per-identity lock
refuses the second (`RIG_STANDALONE=1` skips only the check for a same-identity
`toon-clientd`; the lock stays). The `rig` bin exits as soon as a command
finishes and stdio is flushed.

## Pushing

`rig push [remote] [refspecs...]` uploads the object delta to Arweave (paid,
content-addressed — a re-push never re-pays for known objects) and publishes the
NIP-34 refs event (kind:30618; plus the kind:30617 announcement on first push). It
renders the fee table (refs with classification, objects, bytes, itemized + total
fee) and asks for confirmation before spending — writes are permanent and
non-refundable. `--yes` skips the prompt (and is required when stdin is not a TTY);
`--json` without `--yes` is a pure estimate (nothing executed). `--force` allows
non-fast-forward updates; `--repo-id <id>` overrides the configured repo id.

Repo addressing (`30617:<owner>:<repoId>`) comes from the `toon.repoid` / `toon.owner`
git config keys `rig init` writes — an unconfigured repo is a clear "run `rig init`"
error, and pushing never mutates git config. Objects over the storage upstream's
free per-item ceiling (107,520 bytes) are **not** an error — they upload as paid
writes, priced by the store route's per-KiB schedule, and the confirm table shows
the cost before anything is spent.

## Relays are origins

Relays are configured as **real git remotes** (`rig remote add` is `git remote add`
underneath — `git remote -v` shows them, and remotes added with plain git work too,
as long as the URL is `ws://`/`wss://`/`http://`/`https://`):

- `rig remote add origin <relay-url>` / `rig remote remove <name>` / `rig remote list`
  (`--json` supported). Junk URLs are rejected at add time.
- `rig push` publishes via `origin`; `rig push <remote> [refspecs...]` via a named
  remote. Git-like resolution: when the first positional matches a configured remote
  name it is the remote, otherwise it is a refspec and the remote defaults to
  `origin`.
- The event commands take `--remote <name>` (default `origin`).
- `--relay <url>` stays as an **ad-hoc override** on every paid command: it bypasses
  the configured remotes entirely.
- One relay URL per remote: a remote with multiple URLs is refused **before**
  anything is uploaded, published, or paid.

The single-event subcommands follow the same paid-write discipline as push — the
per-event fee is quoted and confirmed before publishing; `--yes` skips, `--json`
without `--yes` is a free estimate:

- `rig issue create --title <t> [--body <b> | --body-file <f> | stdin] [--label <l>]…` — kind:1621.
- `rig comment <root-event-id> --body <b> [--parent-author <pubkey>] [--marker root|reply]` — kind:1622.
- `rig pr create --title <t> (--range <A..B> | --patch-file <f>) [--body <b> | --body-file <f>] [--branch <name>]` —
  kind:1617; `--range` runs real `git format-patch --stdout` locally and derives the
  `commit`/`parent-commit` tags. A multi-commit range publishes ONE event carrying
  the whole series. `--body`/`--body-file` attach the PR description in a dedicated
  `description` tag — the event content stays pure format-patch output, so
  `rig pr show`'s patch text still pipes straight into `git am`.
- `rig pr status <target-event-id> <open|applied|closed|draft>` — kind:1630–1633.

`--repo-id` / `--owner` override the git config address (use `--owner` for repos you
don't own).

## Cloning & fetching (free reads)

`rig clone <relay-url> <owner>/<repo-id> [dir]` reconstructs the repository from
public data alone: the kind:30618 `arweave` sha→txId map drives parallel downloads
across the gateway fallback chain (SHAs the map misses resolve via the Arweave
GraphQL `Git-SHA` tag index), **every body is verified against its SHA-1 before it
is written**, and the repository is materialized through git's own plumbing
(`git hash-object -w`, `git update-ref`, HEAD from the 30618 symref, checked-out
worktree). Everything happens in a temp dir moved into place on success, so a failed
clone never leaves a partial repo. `rig fetch [remote]` is the same pipeline as a
delta: only locally-missing objects are downloaded, and `refs/remotes/<remote>/*`
(tags → `refs/tags/*`) move with a `git fetch`-style report.

`rig issue list|show` and `rig pr list|show` are pure relay reads (kind:1621/1617 by
the repo `#a` tag; state from kind:1630-1633, latest wins; kind:1622 comments under
`show`).

## Library

`rig` is also the git-to-TOON write-path core. No signing or payment code lives in
it — that stays behind the `Publisher` seam:

- `objects.ts` — git object construction with SHA-1 envelope hashing: `createGitBlob`,
  `createGitTree`, `createGitCommit`, `createGitTag`, `hashGitObject`, and the
  `FREE_TIER_MAX_ITEM_BYTES` (107,520) free-tier threshold (`MAX_OBJECT_SIZE` is
  a deprecated alias; it is no longer a cap).
- `nip34-events.ts` — NIP-34 event builders returning `UnsignedEvent`:
  `buildRepoAnnouncement` (30617), `buildRepoRefs` (30618), `buildIssue` (1621),
  `buildComment` (1622), `buildPatch` (1617), `buildStatus` (1630–1633).
- `repo-reader.ts` — `GitRepoReader`, read-only local-repo access via injection-safe
  `execFile` git plumbing.
- `remote-state.ts` — `fetchRemoteState`, the "what does the remote have?" reader.
- `object-fetch.ts` / `read-pipeline.ts` / `materialize.ts` — the read path
  (gateway fallback + concurrency cap + SHA-1 verification, object-graph closure,
  git plumbing writers with hostile-refname gating).
- `npub.ts` — dependency-free bech32 `npubToHex` / `hexToNpub` / `ownerToHex`.
- `publisher.ts` — the `Publisher` interface (paid transport seam), implemented by
  the daemon and the standalone embedded client.
- `push.ts` — `planPush` (ref classification, object delta, fee estimate) and
  `executePush` (crash-resume safe via content-addressed skip).
- `routes.ts` — the JSON wire shapes of the daemon's `/git/*` control routes.
- `cli/` — the `rig` bin.
- `factory-job-{events,plan,delivery,execute}.ts` — the factory job adapter
  (job → sandcastle milestones → paid increments,
  [toon-meta#262](https://github.com/toon-protocol/toon-meta/issues/262) "agents
  earning"): `planFactoryJob`/`executeFactoryJob` mirror `planPush`/`executePush`'s
  split, and `JobDeliveryPort` is the injected seam for the per-increment
  encrypt/pay leg. The concrete port and the buyer-side payment helpers that
  rode the 0.x client's serve-side job API were removed with the move to
  `@toon-protocol/client` 2.x (now 3.x); the protocol pieces stay so a port can be
  written against the current client.

[epic #246](https://github.com/toon-protocol/toon-client/issues/246).
