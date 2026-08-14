# TASK

Repair pull request #{{PR_NUMBER}} on branch `{{BRANCH}}` so its checks pass and it is
mergeable.

You were dispatched by the factory's PR repair pass (toon-meta#357): this PR's ONLY
blocker(s) are a merge conflict and/or failing checks — every other precondition
(approval, review state, `needs:human`) already holds. Make the smallest change that
gets it green; do not expand scope.

# DIAGNOSE

First, find out exactly why this PR is red:

    gh pr view {{PR_NUMBER}} --json mergeable,statusCheckRollup

- If `mergeable` is `CONFLICTING`, resolve the conflict against `main` (see CONFLICTS
  below).
- For every failing check, read its logs before touching anything:

      gh run view <run-id> --log-failed

  (`<run-id>` is the numeric id in the failing check's `detailsUrl`.)

# CONFLICTS

If the PR conflicts with `main`:

    git fetch origin main
    git merge origin/main

Resolve conflicts by reading BOTH sides and choosing the resolution that preserves both
changes' intent (the same convention `.sandcastle/merge-prompt.md` uses) — never blindly
take "ours" or "theirs". If a conflict needs a judgement call only a human should make,
say so plainly in your final output instead of guessing.

# FAILING CHECKS

This is **rig** — a pnpm workspace (Node 22, pnpm 8.15.9) holding `@toon-protocol/rig`
(published to npm) and `rig-web`. The checks that can go red:

- **CI / Changeset check** — `@toon-protocol/rig` is a published package: a PR that
  changes it must carry a changeset (`pnpm changeset`). If the PR does not touch the
  publishable package, no changeset is required.
- **CI / build** (`.github/workflows/ci.yml`), the gate run on EVERY PR: install with
  `pnpm install --frozen-lockfile`, then the gate's own unit tests
  (`npx tsx --test .sandcastle/gate/*.test.ts`), the correctness gate
  (`npx tsx .sandcastle/gate/correctness.ts`), `pnpm -r build`, and
  `pnpm -r test --if-present`. Reproduce locally with the same commands, and run the
  BUILD before the TYPECHECK — typecheck resolves workspace `dist/` output, so an
  unbuilt tree produces phantom module-not-found errors.
- **CI / CI OK** — an aggregator over the gating jobs; fix the failing upstream job,
  never this one.
- **Agent image** (`.github/workflows/agent-image.yml`) — a build-only check over
  `.sandcastle/Dockerfile`, run only on PRs touching `.sandcastle/**` or that workflow.

Fix the ROOT CAUSE of the failure, not the symptom — e.g. a failing test means fix the
code (or an actually-wrong test), not delete the check that caught it. If a failing
check looks like infrastructure flakiness (a CDN, package registry, or setup-step
timeout with no code-level cause), say so plainly in your final output instead of
inventing a change just to make the diff "look different."

# EXECUTION

1. Diagnose the actual cause before editing anything.
2. Make the smallest change that fixes it.
3. Re-run what failed locally (`npx tsx .sandcastle/gate/correctness.ts`,
   `pnpm -r build`, `pnpm -r test --if-present` as applicable) and confirm it passes
   before you consider the job done.
4. Commit on the current branch (`{{BRANCH}}`) — this is the PR's own branch; do not open
   a new PR.
5. Do not touch anything outside what's needed to turn this PR green.

Once you've made your fix commit(s) (or determined the failure is not fixable from this
branch — say so clearly in your final output), output <promise>COMPLETE</promise>.
