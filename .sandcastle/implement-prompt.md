/mattpocock-skills:implement {{ISSUE_URL}}

You are running AFK in a sandbox, on branch `{{BRANCH}}`, which is already checked out.
Nobody will answer a question, so do not ask one. Treat the issue, its comments and its
parent spec (if it has one) as settled. Read them with `gh issue view {{ISSUE_NUMBER}} --comments`.

Commit to `{{BRANCH}}`, and reference `#{{ISSUE_NUMBER}}` in each commit message. Do not
push, open a PR or close the issue. The runner does all three once you finish.

## This repository

- `CLAUDE.md` covers how to work here, `CONTEXT.md` is the vocabulary and `docs/adr/` holds
  rig's decisions. Protocol truth (wire formats, ILP, claims) lives upstream in
  `toon-protocol/connector` (`docs/protocol/`, `docs/adr/`), not here. Cite a connector ADR by
  number rather than restating it.
- rig is a pnpm workspace with two packages: `packages/rig` (the CLI, published to npm) and
  `packages/rig-web` (the frontend, not published).
- After you finish, the runner runs the commands of CI's `build` job itself, in this order, and
  won't open a PR while any is red: `npx tsx --test .sandcastle/gate/*.test.ts`,
  `npx tsx .sandcastle/gate/correctness.ts`, `pnpm -r build` and `pnpm -r test --if-present`.
  Run them yourself before you commit. The correctness gate fails on any lint or typecheck
  violation beyond the frozen `.sandcastle/gate-baseline.json`. Never add to that baseline, never
  weaken, skip or delete a test, and never loosen a lint, to get green.
- A change under `packages/rig/` needs a changeset (`pnpm changeset`) or CI's changeset job fails.
  Name only `@toon-protocol/rig` in it. `@toon-protocol/rig-web` is in the `ignore` list, and a
  changeset naming only ignored packages is never consumed and blocks every later release.

## When you cannot finish

Stop only when a genuinely new decision is needed and no ADR covers it, the action is
irreversible, it touches mainnet or real funds, or it needs a credential that no workflow
exposes. In that case, commit nothing and explain what blocks you in a comment on the issue
(`gh issue comment {{ISSUE_NUMBER}}`). The runner moves an issue with no commits to
`needs-triage`.

If your context is getting full (around 150k tokens) before you are done, commit what works,
write the remaining steps to `.sandcastle/logs/handoff-{{ISSUE_NUMBER}}.md`, commit it with
`git add -f`, and end your turn. A fresh session continues from your commits.

When the ticket is done and committed, output <promise>COMPLETE</promise>.

If you stopped because you're blocked, output <promise>BLOCKED</promise> instead, after your
comment on the issue. The runner then ends the run. Otherwise it starts another session, which
hits the same blocker and posts the same comment again.
