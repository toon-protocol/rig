// Single-PR review runner — the entry point the `agent:review` label→runner
// workflow (.github/workflows/agent-review.yml) invokes when `agent:review` is
// applied to ONE pull request.
//
// This is a single-pass reviewer (one iteration), not a multi-round loop. It
// runs the reviewer role (review-prompt.md — two axes: Standards refinement
// + Spec review against the PR's target issue, enforce CODING_STANDARDS.md)
// against the PR's head branch, pushes any refinement commits back to the PR,
// and REQUIRES a structured verdict (toon-meta#275):
//   - the reviewer must emit <review>{"verdict":"clean"|"blocking",
//     "blockingFindings":[{file,line,summary,why}]}</review>; a malformed
//     verdict fails the run (one engine-style resume retry, then non-zero exit)
// The verdict is then submitted FORMALLY as the factory-ops identity
// (toon-meta#282, FACTORY_OPS_TOKEN):
//   - "clean"    → a real APPROVE review (a machine verdict — see toon-meta's
//     FACTORY.md, "What a factory-ops approval attests")
//   - "blocking" → a REQUEST_CHANGES review carrying the findings, plus the
//     `needs:human` label
// The approver must never be the PR author: the identity is resolved and
// compared against the author BEFORE the reviewer runs (fail fast) and again
// at submission; a missing/expired/wrong-identity token FAILS the job loudly
// rather than degrading to a COMMENTED review.
// It NEVER merges the PR and NEVER closes anything.
//
// STANDALONE-REVIEW MECHANICS (proven live on connector#634's first run):
//   Sandcastle checks the PR head branch out in its OWN worktree under
//   .sandcastle/worktrees/, and git refuses one branch in two worktrees — so
//   the workflow checks out MAIN, never the PR head. Because the local clone
//   is then on main, this runner materialises the PR head as a LOCAL branch
//   (git fetch origin +head:head) before createSandbox(): without it the
//   engine's `worktree add` falls back to `-b <branch> HEAD`, silently
//   reviewing an EMPTY diff off main. review-prompt.md's {{TARGET_BRANCH}}
//   resolves to the checked-out branch (main), so the diff base is right.
//
// The target issue for the Spec axis is resolved from the PR body's
// `Closes #n` (the implement runner writes one into every factory PR body).
// PRs without a closing reference get a Standards-only review.
//
// Required env:
//   SANDCASTLE_PR_NUMBER      the PR to review (github.event.pull_request.number)
//   CLAUDE_CODE_OAUTH_TOKEN   Claude Max-plan credential (org secret)
//   GH_TOKEN                  token with contents:write + pull-requests:write +
//                             issues:write (labels)
//
// Usage:
//   SANDCASTLE_PR_NUMBER=42 npx tsx .sandcastle/agent-review-pr.ts
//   # or: pnpm sandcastle:review   (with SANDCASTLE_PR_NUMBER exported)

import { execFileSync } from "node:child_process";
import * as sandcastle from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";
import { sandboxSecrets } from "./sandbox-secrets.ts";
import {
  assertApproverIsNotAuthor,
  getPrAuthorLogin,
  resolveFactoryOpsIdentity,
  resolveIssueFromPrBody,
  runReviewerWithVerdict,
  submitFactoryOpsVerdict,
  type ReviewVerdict,
} from "./review-verdict.ts";

const prNumber = process.env.SANDCASTLE_PR_NUMBER?.trim();
if (!prNumber || !/^\d+$/.test(prNumber)) {
  throw new Error(
    "SANDCASTLE_PR_NUMBER must be set to a numeric PR number " +
      `(got: ${JSON.stringify(process.env.SANDCASTLE_PR_NUMBER)}).`,
  );
}

// Resolve the PR's head branch on the host. `gh` authenticates via GH_TOKEN.
const headRef = execFileSync(
  "gh",
  ["pr", "view", prNumber, "--json", "headRefName", "--jq", ".headRefName"],
  { encoding: "utf8" },
).trim();

if (!headRef) {
  throw new Error(`Could not resolve head branch for PR #${prNumber}.`);
}

// Materialise the PR head as a local branch at origin's tip (the host clone is
// on main — see the standalone-review mechanics note above). Forced so a
// re-labeled PR re-reviews the CURRENT head even after a force-push.
execFileSync("git", ["fetch", "origin", `+${headRef}:${headRef}`], {
  stdio: "inherit",
});

// PREFLIGHT the factory-ops approver identity (toon-meta#282) BEFORE the
// expensive reviewer pass: a missing/expired FACTORY_OPS_TOKEN, or one that
// authenticates as the PR's own author, fails the job here in seconds instead
// of after a full opus review. The submission path re-asserts the same guard.
const prAuthor = getPrAuthorLogin(prNumber);
const factoryOps = resolveFactoryOpsIdentity();
assertApproverIsNotAuthor(factoryOps, prAuthor);
console.log(
  `Approver preflight OK: factory-ops is '${factoryOps.login}', PR author is '${prAuthor}'.`,
);

// Resolve the Spec-axis target issue from the PR body's `Closes #n`.
const targetIssue = resolveIssueFromPrBody(prNumber);
console.log(
  targetIssue
    ? `Spec axis target: issue #${targetIssue.number} — ${targetIssue.title}`
    : "No `Closes #n` in the PR body — Standards-only review.",
);

/**
 * Read a branch's tip from origin, or null if the branch does not exist.
 *
 * Deliberately `git ls-remote` and NOT `gh api .../git/ref/heads/<branch>`:
 * the REST ref endpoint is served from a read replica and returns the PRE-push
 * SHA for seconds after a push lands. That cost toon-meta#396 a real review —
 * verdict CLEAN, commit pushed and live on the branch, but the single REST read
 * ~8s later still reported the old head, so the runner declared the push failed
 * and withheld the factory-ops approval. `ls-remote` talks to the same git
 * backend the push just wrote to, so it does not lag it.
 */
function readRemoteHead(ref: string): string | null {
  const out = execFileSync(
    "git",
    ["ls-remote", "origin", `refs/heads/${ref}`],
    { encoding: "utf8" },
  ).trim();
  return out ? (out.split(/\s+/)[0] ?? null) : null;
}

/**
 * Poll origin until `ref` points at `expectedSha`, up to ~60s. Returns the last
 * SHA observed (=== expectedSha on success). Replication lag is normally under
 * a second; the long ceiling costs nothing on the happy path (first read wins)
 * and only spends wall clock on the run that would otherwise fail wrongly.
 */
async function awaitRemoteHead(
  ref: string,
  expectedSha: string,
  { attempts = 12, delayMs = 5_000 } = {},
): Promise<string | null> {
  let observed: string | null = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    observed = readRemoteHead(ref);
    if (observed === expectedSha) return observed;
    if (attempt < attempts) {
      console.log(
        `  [verify] origin/${ref} is ${observed ?? "<missing>"}, waiting for ` +
          `${expectedSha} (attempt ${attempt}/${attempts})`,
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  return observed;
}

// rig is a pnpm workspace: install with the committed lockfile (mirrors
// main.ts). We do NOT copyToWorktree node_modules (pnpm's symlinked store
// breaks across the host->worktree bind-mount).
const hooks = {
  sandbox: {
    onSandboxReady: [
      // Wire `git push` auth deterministically inside the container (FIRST hook).
      // The engine (@ai-hero/sandcastle@0.12.0) sets git identity + safe.directory
      // but NO credential helper, so the review-push step's bare `git push` to the
      // PR branch is unauthenticated and succeeds only by luck. `gh auth setup-git`
      // installs `gh` as git's credential helper (reads GH_TOKEN at push time,
      // stores no token in any file). Guarded on GH_TOKEN so token-less local dev
      // no-ops. See ./agent-implement-issue.ts for the full note.
      {
        command:
          'if [ -n "$GH_TOKEN" ]; then gh auth setup-git; ' +
          "git config --unset-all 'http.https://github.com/.extraheader' 2>/dev/null || true; fi",
      },
      { command: "pnpm install --frozen-lockfile" },
    ],
  },
};

console.log(
  `\n=== agent:review runner — PR #${prNumber} (head: ${headRef}) ===\n`,
);

// Set to a non-null message below if the review-push phase reported success but
// the PR branch never advanced. Recorded here so the `finally` still closes the
// sandbox before we fail the job non-zero.
let reviewPushError: string | null = null;

const sandbox = await sandcastle.createSandbox({
  branch: headRef,
  // Forward CLAUDE_CODE_OAUTH_TOKEN + GH_TOKEN into the container (the engine's
  // env resolver does not — see ./sandbox-secrets.ts). GH_TOKEN is what the
  // review-push step's in-sandbox `git push` to the PR branch authenticates
  // with, and what the reviewer's in-sandbox `gh issue view` (Spec axis) reads.
  sandbox: docker({ env: sandboxSecrets() }),
  hooks,
});

let verdict: ReviewVerdict;
try {
  const review = await runReviewerWithVerdict(sandbox, {
    branch: headRef,
    issue: targetIssue,
  });
  verdict = review.verdict;

  if (review.commits.length > 0) {
    // Push the reviewer's refinement commits back onto the PR branch. No merge,
    // no close, no new PR — the existing PR just gets updated.
    console.log(
      `\nReviewer made ${review.commits.length} commit(s) — pushing to the PR branch.`,
    );
    // DETERMINISTIC (no agent) — see toon-meta#235. This was an agent run
    // (review-push-prompt.md) whose only job was `git push origin <branch>`.
    // Run it directly; sandbox.exec() surfaces a non-zero exitCode (it does NOT
    // throw) — check it and fail loud.
    const push = await sandbox.exec(`git push origin ${headRef}`, {
      onLine: (line) => console.log(`  [push] ${line}`),
    });
    if (push.exitCode !== 0) {
      throw new Error(
        `git push of '${headRef}' failed (exit ${push.exitCode}).\n${push.stderr}`,
      );
    }

    // FAIL LOUD. review-push-prompt.md outputs COMPLETE regardless of whether the
    // in-sandbox `git push` actually landed. Verify from the HOST that origin's
    // PR-branch tip advanced to the reviewer's last commit. Polled, not read
    // once — see readRemoteHead()/awaitRemoteHead() above for why a single read
    // here fails on pushes that actually landed. If it never advances, the
    // reviewer's commits never reached the PR — exit non-zero so the Actions
    // job fails instead of green-lying (store#50 class of silent-push bug).
    const expectedSha = review.commits[review.commits.length - 1]!.sha;
    const remoteHeadAfter = await awaitRemoteHead(headRef, expectedSha);
    if (remoteHeadAfter === expectedSha) {
      console.log(
        `\nVerified: PR branch '${headRef}' advanced to ${remoteHeadAfter} — ` +
          `the open PR picked up the review commits.`,
      );
    } else {
      reviewPushError =
        `\nERROR: the review-push phase reported COMPLETE, but origin/'${headRef}' ` +
        `did NOT advance to the reviewer's commits within 60s.\n` +
        `  Expected head SHA (last review commit): ${expectedSha}\n` +
        `  Last observed remote head SHA:          ${remoteHeadAfter ?? "<branch not found>"}\n` +
        `  The reviewer made ${review.commits.length} commit(s) that never ` +
        `reached the PR — the in-sandbox \`git push\` failed silently. Inspect ` +
        `the push-review phase logs above. The Actions job is failing ` +
        `deliberately so this is not mistaken for success.`;
    }
  } else {
    console.log("\nReviewer made no changes — nothing to push.");
  }
} finally {
  await sandbox.close();
}

// The verdict's side effects run AFTER the sandbox is closed, from the
// authenticated host. Blocking findings must land on the PR even if the push
// verification below is about to fail the job; a clean APPROVAL must NOT be
// submitted on a failing run — an approval green-lights a merge, and
// approving from a red job would let auto-merge proceed past the failure.
if (verdict.verdict === "blocking") {
  submitFactoryOpsVerdict(prNumber, verdict, targetIssue);
} else if (reviewPushError) {
  console.error(
    "\nVerdict clean, but the review-push verification failed — NOT " +
      "submitting the factory-ops approval on a failing run.",
  );
} else {
  console.log("\nVerdict clean — submitting the factory-ops approval.");
  submitFactoryOpsVerdict(prNumber, verdict, targetIssue);
}

// Fail loud AFTER the sandbox is closed: a silently-failed review push must turn
// the Actions job red, never green.
if (reviewPushError) {
  console.error(reviewPushError);
  process.exit(1);
}

console.log("\nReview complete. The PR was NOT merged — a human still merges.");
