# TASK

The reviewer just committed refinements on branch `{{BRANCH}}`. Push them to
origin so the open pull request picks them up. **Do NOT merge, close, or open a
new PR.**

# STEPS

1. Confirm the branch has commits to push:

   !`git log origin/{{BRANCH}}..{{BRANCH}} --oneline`

   If there is nothing ahead of `origin/{{BRANCH}}`, output
   `<promise>COMPLETE</promise>` and stop.

2. Wire `git push` authentication so the push below is NOT unauthenticated.
   `gh` is authenticated from `GH_TOKEN`, but a bare `git push` uses git's own
   credential system. Install `gh` as git's credential helper (idempotent; the
   onSandboxReady hook already did this, but re-run it here so this step is
   self-contained):

   `gh auth setup-git`

3. Push, then CONFIRM the remote tip advanced — a push can fail without an
   obvious error:

   `git push origin {{BRANCH}}`
   `git ls-remote --heads origin {{BRANCH}}`
   !`git rev-parse {{BRANCH}}`

   If the SHA printed by `git ls-remote` does NOT match your local
   `git rev-parse {{BRANCH}}`, the push FAILED. Do **not** output
   `<promise>COMPLETE</promise>` — print the push error and stop. The runner
   verifies the branch advanced and will fail the job if it did not.

# RULES

- Never run `git merge`, `gh pr merge`, or `gh issue close`.
- Do not open a new PR — the existing PR updates automatically from the push.
- Only output `<promise>COMPLETE</promise>` once you have CONFIRMED the remote
  tip matches your local branch tip. A failed push is a failure, not a COMPLETE.

Once the push is confirmed to have landed, output `<promise>COMPLETE</promise>`.
