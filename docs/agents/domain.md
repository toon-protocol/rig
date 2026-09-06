# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- **`CONTEXT.md`** at the repo root, or
- **`CONTEXT-MAP.md`** at the repo root if it exists: it points at one `CONTEXT.md` per context. Read each one relevant to the topic.
- **`docs/adr/`**: read ADRs that touch the area you're about to work in. In multi-context repos, also check `src/<context>/docs/adr/` for context-scoped decisions.

If any of these files don't exist, **proceed silently**. Don't flag their absence; don't suggest creating them upfront. The `/domain-modeling` skill (reached via `/grill-with-docs` and `/improve-codebase-architecture`) creates them lazily when terms or decisions actually get resolved.

## Layout: single-context

rig is a pnpm workspace with two packages (`packages/rig`, the CLI, and `packages/rig-web`, the frontend) that ship one product, so it is documented as a single context:

```
/
├── CONTEXT.md                 (created lazily by /domain-modeling)
├── docs/adr/
│   └── 0001-rig-web-ownership-and-url-permanence.md
└── packages/
    ├── rig/
    └── rig-web/
```

Protocol-level decisions live upstream in `toon-protocol/connector` under `docs/adr/` and `docs/protocol/`; rig ADRs record decisions about rig itself. When a rig change depends on a connector ADR, cite it by number.

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in `CONTEXT.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal: either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0001 (rig-web ownership), but worth reopening because…_
