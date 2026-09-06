# rig

TOON Protocol's git-to-TOON write path (`@toon-protocol/rig`, CLI) and its decentralized control-plane frontend (`@toon-protocol/rig-web`). A push pays a TOON connector over ILP; objects land on Arweave via the store, and NIP-34 events land on the relay. Protocol truth lives in `toon-protocol/connector` (`docs/protocol/`, `docs/adr/`), not here.

## Agent skills

### Workflow

Planning is done by a human at the keyboard: `/wayfinder` (when what to build is still unclear) or `/grill-with-docs` (when the design is solid and needs ADRs and glossary written), then `/to-spec`, then `/to-tickets` with each ticket added as a sub-issue of the spec issue. Only after that does an agent drive the spec issue to completion with `/implement`. No one-shot prompts for features.

### Issue tracker

Issues and specs are GitHub issues in `toon-protocol/rig`, driven with the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five default triage labels (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`), kept separate from the Sandcastle factory labels so a triage decision never starts a factory run. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` at the root plus `docs/adr/`. See `docs/agents/domain.md`.
