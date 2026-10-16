/**
 * `rig pr merge <patch-id>` — take a patch from open to applied in one paid
 * step, so the applied status can never claim something that did not happen.
 *
 * The order is the safety property:
 *   1. resolve the latest authorized revision of the patch (free reads);
 *   2. refuse a caller who is not an authorized author (ADR-0005) — nothing
 *      is spent;
 *   3. fetch the honored state and resolve the target branch (`--target`,
 *      else the patch's `branch-name` tag, else the default branch);
 *   4. make sure the honored tip is present locally;
 *   5. `git am` the patch onto that tip in an isolated worktree — a conflict
 *      aborts with the caller's working tree untouched, nothing spent;
 *   6. show the combined fee table (push + status) and confirm;
 *   7. push through the same planner/executor as `rig push` (fast-forward
 *      check included);
 *   8. only then publish kind:1631 naming the applied commit SHAs and the
 *      merged revision. A status failure after a successful push is a
 *      PARTIAL success with a `rig pr status` retry hint.
 *
 * The local target branch only moves after the push succeeded: planning and
 * pushing read the applied tip through an overlay on the ref listing.
 *
 * Merging always runs through the embedded (standalone) publisher: the daemon
 * has no merge route, and the push and the status must share one session.
 */

import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { promisify } from 'node:util';
import {
  PATCH_KIND,
  REPOSITORY_ANNOUNCEMENT_KIND,
  STATUS_APPLIED_KIND,
  STATUS_CLOSED_KIND,
} from '@toon-protocol/core/nip34';
import {
  isCiTrustLevel,
  CI_TRUST_ORDER,
  type CiTrustLevel,
} from '../ci/trust.js';
import { buildStatus, firstTagValue } from '../nip34-events.js';
import { hexToNpub } from '../npub.js';
import { executePush, planPush } from '../push.js';
import {
  authorizedAuthors,
  isPatchRevision,
  revisionRootId,
  selectRevision,
} from '../repo-authority.js';
import { GitRepoReader, type GitRef, type RepoRefs } from '../repo-reader.js';
import { defaultWebSocketFactory } from '../remote-state.js';
import { serializePushPlan, serializePushResult } from '../routes.js';
import {
  emitCliError,
  PrMergeError,
  UnconfiguredRepoAddressError,
} from './errors.js';
import { evaluateCiGate } from './ci-status.js';
import { runFetch } from './fetch.js';
import { readToonConfig, resolveRepoRoot } from './git-config.js';
import {
  identityReport,
  loadPaidSession,
  withForcedStandalone,
} from './push.js';
import { resolveRelays, singleRelayRefusal } from './remote.js';
import { renderIdentityLine, renderPlan, renderResult } from './render.js';
import { queryAll } from './tracker.js';
import type { EventCommandDeps } from './events.js';
import type { NostrEvent } from '../remote-state.js';

const execFileAsync = promisify(execFile);

const HEX64_RE = /^[0-9a-f]{64}$/;

export const PR_MERGE_USAGE = `Usage: rig pr merge <patch-id> [--target <branch>] [options]

Apply the latest authorized revision of a patch with \`git am\` onto the
honored tip of the target branch, push the result, and publish an applied
status (kind:1631) naming the new commit SHAs — in that order, so the status
never claims a merge that did not happen. A paid command; writes are permanent
and non-refundable. Only the owner or a declared maintainer may merge.

If the patch does not apply, nothing is spent and your working tree is left as
it was. If the push succeeds but the status publish fails, the merge is
reported as a partial success; retry with \`rig pr status <patch-id> applied\`.

Options:
  --target <branch>    branch to merge onto (default: the patch's branch-name
                       tag, else the repo's default branch)
  --require-ci-trust <level>
                       refuse the merge, before paying, unless the patch
                       series' head commit has a concluded green CI run at or
                       above this trust level (same gate as \`rig ci status\`)
  --closes <issue-id>  after a successful merge, publish closed (kind:1632)
                       for this issue; repeatable
  --yes                skip the confirmation prompt
  --json               machine-readable output (without --yes: estimate only)
  --relay <url>        ad-hoc relay override (bypasses git remotes)
  --remote <name>      git remote to use (default: origin)
  --repo-id <id>       repository id (default: git config toon.repoid)
  --owner <pubkey>     repository owner (default: git config toon.owner)`;

interface MergeFlags {
  patchId: string;
  target?: string;
  yes: boolean;
  json: boolean;
  relay: string[];
  remote?: string;
  repoId?: string;
  owner?: string;
  requireTrust?: CiTrustLevel;
  closes: string[];
}

function parseMergeArgs(args: string[]): MergeFlags | 'help' {
  const { values, positionals } = parseArgs({
    args,
    options: {
      target: { type: 'string' },
      yes: { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      relay: { type: 'string', multiple: true },
      remote: { type: 'string' },
      'repo-id': { type: 'string' },
      owner: { type: 'string' },
      'require-ci-trust': { type: 'string' },
      closes: { type: 'string', multiple: true },
      standalone: { type: 'boolean', default: false },
      'no-daemon': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: true,
  });
  if (values.help) return 'help';
  if (positionals.length !== 1) {
    throw new Error('expected exactly one argument: <patch-id>');
  }
  const patchId = positionals[0] as string;
  if (!HEX64_RE.test(patchId)) {
    throw new Error('<patch-id> must be a 64-character lowercase hex event id');
  }
  if (values.owner !== undefined && !HEX64_RE.test(values.owner)) {
    throw new Error('--owner must be a 64-character lowercase hex pubkey');
  }
  const flags: MergeFlags = {
    patchId,
    yes: values.yes === true,
    json: values.json === true,
    relay: values.relay ?? [],
    closes: [...new Set(values.closes ?? [])],
  };
  for (const id of flags.closes) {
    if (!HEX64_RE.test(id)) {
      throw new Error('--closes must be a 64-character lowercase hex issue id');
    }
  }
  const level = values['require-ci-trust'];
  if (level !== undefined) {
    if (!isCiTrustLevel(level)) {
      throw new Error(
        `--require-ci-trust must be one of ${CI_TRUST_ORDER.join(' | ')} (got ${JSON.stringify(level)})`
      );
    }
    flags.requireTrust = level;
  }
  if (values.target !== undefined) flags.target = values.target;
  if (values.remote !== undefined) flags.remote = values.remote;
  if (values['repo-id'] !== undefined) flags.repoId = values['repo-id'];
  if (values.owner !== undefined) flags.owner = values.owner;
  return flags;
}

// ---------------------------------------------------------------------------
// git helpers
// ---------------------------------------------------------------------------

async function git(
  cwd: string,
  args: string[],
  env?: NodeJS.ProcessEnv
): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    encoding: 'utf-8',
    maxBuffer: 64 * 1024 * 1024,
    ...(env ? { env } : {}),
  });
  return stdout.trim();
}

async function gitOk(cwd: string, args: string[]): Promise<boolean> {
  try {
    await git(cwd, args);
    return true;
  } catch {
    return false;
  }
}

function gitFailure(err: unknown): string {
  const e = err as { stderr?: string; stdout?: string; message?: string };
  return (e.stderr || e.stdout || e.message || String(err)).trim();
}

/**
 * A reader whose ref listing shows `refname` at `sha`: planning and pushing
 * see the applied tip while the real branch stays where it is until the push
 * has succeeded. The objects already live in the shared object store.
 */
class OverlayReader extends GitRepoReader {
  constructor(
    repoPath: string,
    private readonly overlay: { refname: string; sha: string }
  ) {
    super(repoPath);
  }

  override async listRefs(): Promise<RepoRefs> {
    const base = await super.listRefs();
    const refs: GitRef[] = base.refs.filter(
      (r) => r.refname !== this.overlay.refname
    );
    refs.push({
      refname: this.overlay.refname,
      sha: this.overlay.sha,
      type: 'commit',
    });
    return { ...base, refs };
  }
}

/**
 * The follow-on patches of `head` (NIP-34 / ngit multi-commit series): 1617s
 * that `e`-reply to it, directly or through earlier follow-ons, are not
 * revisions, and are signed by the head's author or an authorized author.
 * Ordered by reply depth, then `created_at`, then lowest id — the order ngit
 * sends them in. `head` itself is not included.
 */
async function fetchSeriesFollowOns(
  relays: string[],
  head: NostrEvent,
  authorized: ReadonlySet<string>,
  webSocketFactory: Parameters<typeof queryAll>[2]
): Promise<NostrEvent[]> {
  const allowed = new Set([...authorized, head.pubkey.toLowerCase()]);
  const found = new Map<string, { event: NostrEvent; depth: number }>();
  let frontier = [head.id];
  for (let depth = 1; frontier.length > 0 && depth <= 256; depth++) {
    const replies = await queryAll(
      relays,
      [{ kinds: [PATCH_KIND], '#e': frontier }],
      webSocketFactory
    );
    frontier = [];
    for (const e of replies.values()) {
      if (
        e.kind !== PATCH_KIND ||
        e.id === head.id ||
        found.has(e.id) ||
        isPatchRevision(e) ||
        !allowed.has(e.pubkey.toLowerCase())
      ) {
        continue;
      }
      found.set(e.id, { event: e, depth });
      frontier.push(e.id);
    }
  }
  return [...found.values()]
    .sort(
      (a, b) =>
        a.depth - b.depth ||
        a.event.created_at - b.event.created_at ||
        (a.event.id < b.event.id ? -1 : 1)
    )
    .map((f) => f.event);
}

interface AppliedPatch {
  newHead: string;
  /** Commit SHAs the patch became, oldest first. */
  commits: string[];
}

/**
 * Run `git am` of `patchText` onto `tip` in a throwaway worktree. The caller's
 * working tree and index are never touched, so a conflict needs no restore.
 */
async function applyInIsolation(
  repoRoot: string,
  tip: string,
  patchText: string,
  committer: { name: string; email: string } | undefined
): Promise<AppliedPatch> {
  const scratch = await mkdtemp(join(tmpdir(), 'rig-merge-'));
  const worktree = join(scratch, 'wt');
  try {
    await git(repoRoot, ['worktree', 'add', '--detach', worktree, tip]);
    const patchFile = join(scratch, 'patch.mbox');
    await writeFile(patchFile, patchText, 'utf-8');
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (committer) {
      env['GIT_COMMITTER_NAME'] = committer.name;
      env['GIT_COMMITTER_EMAIL'] = committer.email;
    }
    try {
      await git(worktree, ['am', '--quiet', patchFile], env);
    } catch (err) {
      await git(worktree, ['am', '--abort']).catch(() => undefined);
      throw new PrMergeError(
        'apply_conflict',
        `the patch does not apply cleanly onto ${tip.slice(0, 7)} — ask the ` +
          `contributor for a revision (\`rig pr create --revises\`). Nothing ` +
          `was pushed, published, or paid, and your working tree is unchanged.\n` +
          gitFailure(err)
      );
    }
    const newHead = await git(worktree, ['rev-parse', 'HEAD']);
    const listed = await git(worktree, [
      'rev-list',
      '--reverse',
      `${tip}..${newHead}`,
    ]);
    const commits = listed === '' ? [] : listed.split('\n');
    if (commits.length === 0) {
      throw new PrMergeError(
        'nothing_to_apply',
        'the patch applied no commits (already merged?) — nothing was ' +
          'pushed, published, or paid.'
      );
    }
    return { newHead, commits };
  } finally {
    await git(repoRoot, ['worktree', 'remove', '--force', worktree]).catch(
      () => undefined
    );
    await git(repoRoot, ['worktree', 'prune']).catch(() => undefined);
    await rm(scratch, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

const BRANCH_PREFIX = 'refs/heads/';

/** Run `rig pr merge …`; returns the process exit code. */
export async function runPrMerge(
  args: string[],
  deps: EventCommandDeps
): Promise<number> {
  const { io } = deps;

  let flags: MergeFlags;
  try {
    const parsed = parseMergeArgs(args);
    if (parsed === 'help') {
      io.out(PR_MERGE_USAGE);
      return 0;
    }
    flags = parsed;
  } catch (err) {
    io.err(err instanceof Error ? err.message : String(err));
    io.err(PR_MERGE_USAGE);
    return 2;
  }
  deps = withForcedStandalone(deps);
  const webSocketFactory = deps.webSocketFactory ?? defaultWebSocketFactory;

  let stop: (() => Promise<void>) | undefined;
  try {
    // ── Repo addressing + relay (same chain as every paid command) ──────────
    const repoRoot = await resolveRepoRoot(deps.cwd);
    const toonConfig = await readToonConfig(repoRoot);
    const repoId = flags.repoId ?? toonConfig.repoId;
    if (!repoId) throw new UnconfiguredRepoAddressError('repository id');
    const resolved = await resolveRelays({
      relayFlags: flags.relay,
      remoteName: flags.remote,
      repoRoot,
      toonRelays: toonConfig.relays,
    });
    if (resolved.nudge !== undefined) io.err(resolved.nudge);
    const relays = resolved.relays;
    if (relays.length > 1) {
      io.err(singleRelayRefusal(resolved, 'Nothing was pushed or paid.'));
      return 1;
    }
    const relay = relays[0] as string;

    const session = await loadPaidSession(deps, relay);
    if (session.path !== 'standalone') {
      throw new Error('internal: rig pr merge requires the standalone session');
    }
    const ctx = session.ctx;
    stop = () => ctx.stop();
    const identity = identityReport(ctx);
    const owner = flags.owner ?? toonConfig.owner ?? identity.pubkey;
    const addr = { ownerPubkey: owner, repoId };
    const aTag = `${REPOSITORY_ANNOUNCEMENT_KIND}:${owner}:${repoId}`;

    // ── 1. Resolve the latest authorized revision ───────────────────────────
    const lookup = async (id: string) =>
      (await queryAll(relays, [{ ids: [id] }], webSocketFactory)).get(id);
    let root = await lookup(flags.patchId);
    if (root && root.kind === PATCH_KIND && isPatchRevision(root)) {
      const rootId = revisionRootId(root);
      if (rootId !== undefined) root = await lookup(rootId);
    }
    if (!root || root.kind !== PATCH_KIND) {
      throw new PrMergeError(
        'patch_not_found',
        `patch ${flags.patchId} not found as a kind:1617 patch on ${relay} — nothing was pushed or paid`
      );
    }
    if (!root.tags.some((t) => t[0] === 'a' && t[1] === aTag)) {
      throw new PrMergeError(
        'patch_not_found',
        `patch ${root.id} does not belong to ${aTag} — nothing was pushed or paid`
      );
    }
    const remote = await ctx.fetchRemote({
      ownerPubkey: owner,
      repoId,
      relayUrls: relays,
    });
    const authorized = authorizedAuthors(
      owner,
      remote.announceEvent?.tags ?? []
    );
    const revisionEvents = await queryAll(
      relays,
      [{ kinds: [PATCH_KIND], '#e': [root.id] }],
      webSocketFactory
    );
    const { latest } = selectRevision(
      root,
      [...revisionEvents.values()].filter((e) => e.kind === PATCH_KIND),
      authorized
    );

    const followOns = await fetchSeriesFollowOns(
      relays,
      latest,
      authorized,
      webSocketFactory
    );
    const series = [latest, ...followOns];
    const seriesText = series
      .map((e) => (e.content.endsWith('\n') ? e.content : `${e.content}\n`))
      .join('');

    // ── 2. Refuse a caller who cannot move refs, before anything is spent ───
    if (!authorized.has(identity.pubkey.toLowerCase())) {
      throw new PrMergeError(
        'not_authorized',
        `only the owner or a declared maintainer can merge — ` +
          `${identity.pubkey.slice(0, 8)}… is neither for ${aTag}. ` +
          'Readers would ignore the pushed state. Nothing was pushed or paid.'
      );
    }

    // ── 3. Target branch on the honored state ───────────────────────────────
    if (!remote.announced) {
      throw new PrMergeError(
        'target_not_found',
        `${aTag} is not announced on ${relay} — nothing to merge onto`
      );
    }
    const branch = (
      flags.target ??
      firstTagValue(latest.tags, 'branch-name') ??
      remote.headSymref ??
      'main'
    ).replace(/^refs\/heads\//, '');
    const refname = `${BRANCH_PREFIX}${branch}`;
    const tip = remote.refs.get(refname);
    if (tip === undefined) {
      throw new PrMergeError(
        'target_not_found',
        `branch ${JSON.stringify(branch)} is not in the honored repo state ` +
          `(${[...remote.refs.keys()].join(', ') || 'no refs'}) — pass --target. Nothing was pushed or paid.`
      );
    }

    // ── 4. The honored tip must be present locally ──────────────────────────
    if (!(await gitOk(repoRoot, ['cat-file', '-e', `${tip}^{commit}`]))) {
      await runFetch(
        ['--relay', relay, '--owner', owner, '--repo-id', repoId],
        { ...deps, io: { ...io, out: () => undefined } }
      );
      if (!(await gitOk(repoRoot, ['cat-file', '-e', `${tip}^{commit}`]))) {
        throw new PrMergeError(
          'tip_unavailable',
          `the honored tip ${tip.slice(0, 7)} of ${branch} could not be ` +
            'fetched — run `rig fetch` and retry. Nothing was pushed or paid.'
        );
      }
    }
    const reader = new GitRepoReader(repoRoot);
    // The local branch only moves forward onto the merge; never drop commits.
    const localRefs = (await reader.listRefs()).refs;
    const localSha = localRefs.find((r) => r.refname === refname)?.sha;
    if (
      localSha !== undefined &&
      localSha !== tip &&
      !(await reader.isAncestor(localSha, tip))
    ) {
      throw new PrMergeError(
        'local_branch_diverged',
        `local ${branch} (${localSha.slice(0, 7)}) is not behind the honored ` +
          `tip (${tip.slice(0, 7)}) — push or reset it first. Nothing was pushed or paid.`
      );
    }

    // ── 5. git am onto the tip, in isolation ────────────────────────────────
    const hasCommitter = await gitOk(repoRoot, ['config', 'user.email']);
    const applied = await applyInIsolation(
      repoRoot,
      tip,
      seriesText,
      hasCommitter
        ? undefined
        : {
            name: hexToNpub(identity.pubkey),
            email: `${hexToNpub(identity.pubkey)}@nostr`,
          }
    );

    // ── 5b. CI gate: refuse before any fee is shown or spent ────────────────
    if (flags.requireTrust !== undefined) {
      // The series head as the contributor tagged it (what CI ran on). With
      // no commit tags we fall back to the locally rebuilt head, which no CI
      // run can have seen, so the gate then refuses.
      const headCommit = (
        series
          .at(-1)
          ?.tags.filter((t) => t[0] === 'commit')
          .at(-1)?.[1] ?? applied.newHead
      ).toLowerCase();
      const gate = await evaluateCiGate({
        relays,
        owner,
        repoId,
        commit: headCommit,
        webSocketFactory,
        requireTrust: flags.requireTrust,
      });
      if (!gate.ok) {
        throw new PrMergeError(
          'ci_gate_failed',
          `no qualifying green CI run (trust >= ${flags.requireTrust}) for ` +
            `${headCommit.slice(0, 12)}: ${gate.reason ?? 'not green'}. ` +
            'Nothing was pushed, published, or paid.'
        );
      }
    }
    const overlay = new OverlayReader(repoRoot, {
      refname,
      sha: applied.newHead,
    });

    // ── 6. Plan the push, show the combined fee, confirm ────────────────────
    const feeRates = await ctx.publisher.getFeeRates();
    const pushPlan = await planPush({
      repoReader: overlay,
      remoteState: remote,
      feeRates,
      repoId,
      refs: [refname],
      force: false,
    });
    const plan = serializePushPlan(pushPlan);
    const total =
      BigInt(plan.estimate.totalFee) +
      feeRates.eventFee * BigInt(1 + flags.closes.length);
    if (!flags.json) {
      for (const line of renderPlan(plan)) io.out(line);
      io.out(
        `  status    kind:1631 applied (${applied.commits.length} commit${
          applied.commits.length === 1 ? '' : 's'
        })   ${feeRates.eventFee}`
      );
      if (flags.closes.length > 0) {
        io.out(
          `  closes    kind:1632 closed (${flags.closes.length} issue${
            flags.closes.length === 1 ? '' : 's'
          })   ${feeRates.eventFee * BigInt(flags.closes.length)}`
        );
      }
      io.out(`  total with status       ${total}`);
      io.out(renderIdentityLine(identity));
    }
    if (!flags.yes) {
      if (flags.json) {
        io.emitJson({
          command: 'pr merge',
          repoAddr: addr,
          identity,
          executed: false,
          patchId: root.id,
          revisionId: latest.id,
          target: refname,
          mergedShas: applied.commits,
          plan,
          totalFee: total.toString(),
          hint: 'estimate only — re-run with --yes to push and publish (permanent, non-refundable)',
        });
        return 0;
      }
      if (!io.isInteractive) {
        io.err(
          'refusing to spend channel funds without confirmation in a non-interactive ' +
            'session — re-run with --yes (or use --json for an estimate)'
        );
        return 1;
      }
      const proceed = await io.confirm(
        `Proceed with paid merge (total ${total} base units)? [y/N] `
      );
      if (!proceed) {
        io.err('aborted — nothing was pushed or published.');
        return 1;
      }
    }

    // ── 7. Push (a failure here publishes no status) ────────────────────────
    const pushResult = await executePush({
      plan: pushPlan,
      publisher: ctx.publisher,
      remoteState: remote,
      repoReader: overlay,
      relayUrls: relays,
    });
    const result = serializePushResult(pushPlan, pushResult);

    // The push landed: bring the local branch to the merge. Best effort.
    const localNote = await advanceLocalBranch(
      repoRoot,
      reader,
      refname,
      applied.newHead,
      localSha
    );
    if (localNote !== undefined) io.err(localNote);

    // ── 8. Only now: the applied status ─────────────────────────────────────
    let statusEventId: string | undefined;
    let statusError: string | undefined;
    try {
      const receipt = await ctx.publisher.publishEvent(
        buildStatus(owner, repoId, root.id, STATUS_APPLIED_KIND, root.pubkey, {
          commits: applied.commits,
          revisionEventId: latest.id,
        }),
        relays
      );
      statusEventId = receipt.eventId;
    } catch (err) {
      statusError = err instanceof Error ? err.message : String(err);
    }

    // ── 9. Closes: only after the push landed, one 1632 per issue ───────────
    const closed: string[] = [];
    const closeErrors: { issueId: string; error: string }[] = [];
    for (const issueId of flags.closes) {
      try {
        await ctx.publisher.publishEvent(
          buildStatus(owner, repoId, issueId, STATUS_CLOSED_KIND),
          relays
        );
        closed.push(issueId);
      } catch (err) {
        closeErrors.push({
          issueId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    const closeRetryHints = closeErrors.map(
      (e) => `rig issue close ${e.issueId}`
    );

    const retryHint = `rig pr status ${root.id} applied`;
    if (flags.json) {
      io.emitJson({
        command: 'pr merge',
        repoAddr: addr,
        identity,
        executed: true,
        patchId: root.id,
        revisionId: latest.id,
        target: refname,
        mergedShas: applied.commits,
        closed,
        ...(closeErrors.length > 0 ? { closeErrors } : {}),
        result,
        ...(statusEventId !== undefined ? { statusEventId } : {}),
        ...(statusError !== undefined
          ? {
              partial: true,
              error: 'status_publish_failed',
              detail: statusError,
              hint: `the push succeeded but the applied status was not published — retry with \`${retryHint}\``,
            }
          : closeErrors.length > 0
            ? {
                partial: true,
                error: 'close_publish_failed',
                detail: closeErrors
                  .map((e) => `${e.issueId}: ${e.error}`)
                  .join('; '),
                hint: `the push succeeded but some issues were not closed — retry with ${closeRetryHints
                  .map((h) => `\`${h}\``)
                  .join(', ')}`,
              }
            : {}),
      });
    } else {
      for (const line of renderResult(result)) io.out(line);
      if (statusEventId !== undefined) {
        io.out(
          `Merged ${applied.commits.length} commit(s) onto ${branch}; applied status ${statusEventId}`
        );
      }
    }
    if (!flags.json && closed.length > 0) {
      io.out(`Closed ${closed.length} issue(s): ${closed.join(', ')}`);
    }
    if (statusError !== undefined) {
      io.err(
        `partial success: the push succeeded but publishing the applied status failed: ${statusError}`
      );
      io.err(`retry the status with: ${retryHint}`);
    }
    if (closeErrors.length > 0) {
      for (const e of closeErrors) {
        io.err(
          `partial success: the push succeeded but closing issue ${e.issueId} failed: ${e.error}`
        );
      }
      for (const h of closeRetryHints) io.err(`retry the close with: ${h}`);
    }
    return statusError !== undefined || closeErrors.length > 0 ? 1 : 0;
  } catch (err) {
    return emitCliError(io, flags.json, 'pr merge', err);
  } finally {
    if (stop) await stop().catch(() => undefined);
  }
}

/**
 * Move the local target branch to the merged tip after a successful push.
 * A checked-out branch fast-forwards its working tree; otherwise the ref is
 * updated. Returns a warning line on failure — the push already succeeded.
 */
async function advanceLocalBranch(
  repoRoot: string,
  reader: GitRepoReader,
  refname: string,
  newHead: string,
  oldSha: string | undefined
): Promise<string | undefined> {
  try {
    const { head } = await reader.listRefs();
    if (head === refname) {
      await git(repoRoot, ['merge', '--ff-only', newHead]);
    } else {
      await git(repoRoot, [
        'update-ref',
        refname,
        newHead,
        oldSha ?? '0'.repeat(40),
      ]);
    }
    return undefined;
  } catch (err) {
    return (
      `warning: the push succeeded but local ${refname} could not be moved to ` +
      `${newHead.slice(0, 7)}: ${gitFailure(err)} — run \`rig fetch\``
    );
  }
}
