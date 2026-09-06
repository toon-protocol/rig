# rig

TOON Protocol's git-to-TOON write path (`@toon-protocol/rig`, CLI) and its decentralized control-plane frontend (`@toon-protocol/rig-web`). A push pays a TOON connector over ILP; objects land on Arweave via the store, and NIP-34 events land on the relay. Protocol truth lives in `toon-protocol/connector` (`docs/protocol/`, `docs/adr/`), not here.

## Agent skills

### Issue tracker

Issues and specs are GitHub issues in `toon-protocol/rig`, driven with the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five triage roles map onto the existing Sandcastle labels: `ready-for-agent` is `agent:implement` (which starts a factory run) and `ready-for-human` is `needs:human`; `needs-triage` and `needs-info` are new. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` at the root plus `docs/adr/`. See `docs/agents/domain.md`.
