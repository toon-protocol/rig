/**
 * Materialize ONE commit into a working directory for a CI run (#125), using
 * rig's free read path — the coordinator, not the runner, owns repo
 * knowledge, so `act`'s local checkout handling never needs GitHub or any git
 * server (user story 23).
 *
 * Pipeline (the same engine `rig clone` uses, ../cli/clone.ts): relay state
 * (kind:30617/30618 → sha→txId hints) → download + SHA-1-verify the object
 * closure of the commit from Arweave gateways (../read-pipeline.ts) → write
 * the objects through git plumbing into a fresh repository
 * (../materialize.ts) → detached checkout of the commit.
 *
 * The kind:1617 patch path: `rig pr create` publishes patches whose content
 * is real `git format-patch` output against a `parent-commit`. For such a PR
 * the base commit is materialized and the patch applied with `git am`; the
 * resulting HEAD is the commit the run is for (its sha differs from the
 * contributor's local sha because the committer differs — the coordinator
 * publishes both, see ./coordinator.ts).
 *
 * Everything shells out with argument ARRAYS (never a shell); refnames never
 * reach git here at all (a detached checkout by full sha).
 */

import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import type { FetchLike } from '../object-fetch.js';
import { runGit, writeGitObjects } from '../materialize.js';
import { collectRepoObjects, missingObjectsMessage } from '../read-pipeline.js';
import { fetchRemoteState, type WebSocketFactory } from '../remote-state.js';

const FULL_SHA_RE = /^[0-9a-f]{40}$/;

/** The commit could not be obtained — the run concludes `startup_failure`. */
export class MaterializeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MaterializeError';
  }
}

export interface MaterializeCommitOptions {
  ownerPubkey: string;
  repoId: string;
  relayUrls: string[];
  /** The commit to check out (full sha). With `patch`, the patch's base. */
  commit: string;
  /** Destination directory (created; must not already be a repository). */
  dir: string;
  /** kind:1617 path: apply this format-patch text on top of `commit`. */
  patch?: { content: string };
  /**
   * Extra object ids to fetch alongside the commit's closure — the annotated
   * tag objects a Manual Trigger names as additional `c` values, so the
   * coordinator can peel them in the checkout. A missing one is NOT fatal
   * here (the caller decides what an unpeelable id means).
   */
  extraObjectIds?: readonly string[];
  webSocketFactory?: WebSocketFactory;
  fetchFn?: FetchLike;
  resolveSha?: (sha: string, repo: string) => Promise<string | null>;
  gateways?: readonly string[];
  /** Committer identity for `git am` (default: the coordinator's). */
  committer?: { name: string; email: string };
}

export interface MaterializedCommit {
  dir: string;
  /** HEAD after checkout: `commit`, an annotated tag's peeled commit, or the `git am` result. */
  commit: string;
  /** Objects written into the checkout's object store. */
  objectsWritten: number;
}

export type MaterializeCommit = (
  opts: MaterializeCommitOptions
) => Promise<MaterializedCommit>;

/** Run git with argument-array safety and a stdin payload. */
function gitWithStdin(
  cwd: string,
  args: string[],
  stdin: string,
  env: NodeJS.ProcessEnv
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf-8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf-8');
    });
    child.on('error', (err) =>
      reject(new Error(`failed to spawn git: ${err.message}`))
    );
    child.on('close', (code) => {
      if (code !== 0) {
        reject(
          new Error(`git ${args[0]} failed (exit ${code}): ${stderr.trim()}`)
        );
      } else {
        resolve(stdout);
      }
    });
    child.stdin.on('error', () => {
      // 'close' surfaces the failure
    });
    child.stdin.write(stdin);
    child.stdin.end();
  });
}

export const materializeCommit: MaterializeCommit = async (opts) => {
  if (!FULL_SHA_RE.test(opts.commit)) {
    throw new MaterializeError(
      `not a full commit sha: ${JSON.stringify(opts.commit)}`
    );
  }

  // ── Remote state (kind:30617 + 30618) — free ────────────────────────────
  const remote = await fetchRemoteState({
    relayUrls: opts.relayUrls,
    ownerPubkey: opts.ownerPubkey,
    repoId: opts.repoId,
    ...(opts.webSocketFactory
      ? { webSocketFactory: opts.webSocketFactory }
      : {}),
    ...(opts.resolveSha ? { resolveSha: opts.resolveSha } : {}),
  });
  if (!remote.announced && remote.refsEvent === null) {
    throw new MaterializeError(
      `repository ${opts.ownerPubkey.slice(0, 8)}…/${opts.repoId} is not on the relay`
    );
  }

  // ── Download + verify the commit's closure — free ───────────────────────
  const collected = await collectRepoObjects({
    tips: [opts.commit, ...(opts.extraObjectIds ?? [])],
    shaToTxId: remote.shaToTxId,
    resolveMissing: (shas) => remote.resolveMissing(shas),
    ...(opts.fetchFn ? { fetchFn: opts.fetchFn } : {}),
    ...(opts.gateways ? { gateways: opts.gateways } : {}),
  });
  const extra = new Set(
    (opts.extraObjectIds ?? []).map((id) => id.toLowerCase())
  );
  const fatal = collected.missing.filter(
    (m) => !extra.has(m.sha.toLowerCase())
  );
  if (fatal.length > 0) {
    throw new MaterializeError(
      missingObjectsMessage(
        fatal,
        `cannot materialize ${opts.commit.slice(0, 7)}`
      )
    );
  }

  // ── Fresh repository + detached checkout ────────────────────────────────
  await mkdir(opts.dir, { recursive: true });
  await runGit(opts.dir, ['init', '--quiet', '--initial-branch=main']);
  const objectsWritten = await writeGitObjects(
    opts.dir,
    collected.objects.values()
  );
  await runGit(opts.dir, ['checkout', '--quiet', '--detach', opts.commit]);

  if (opts.patch) {
    const committer = opts.committer ?? {
      name: 'rig ci',
      email: 'ci@rig.invalid',
    };
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GIT_COMMITTER_NAME: committer.name,
      GIT_COMMITTER_EMAIL: committer.email,
    };
    try {
      await gitWithStdin(opts.dir, ['am', '--quiet'], opts.patch.content, env);
    } catch (err) {
      throw new MaterializeError(
        `patch does not apply on ${opts.commit.slice(0, 7)}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
  // HEAD is the peeled commit: `commit` itself, the annotated tag's target
  // when a tag object was requested, or the `git am` result.
  const head = (await runGit(opts.dir, ['rev-parse', 'HEAD'])).trim();

  return { dir: opts.dir, commit: head, objectsWritten };
};
