/**
 * materializeCommit (#125): a REAL source repository served through the #278
 * mock relay + mock gateway lands as a detached checkout of exactly the
 * requested commit; a kind:1617 patch (real `git format-patch` output) is
 * applied on its declared base with `git am`; missing objects are an honest
 * MaterializeError (the run's `startup_failure`), never a partial checkout.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearShaCache } from '@toon-protocol/arweave';
import {
  filterEvents,
  gitText,
  makeMockGateway,
  makeMockRelayFactory,
  repoStateEvents,
  storeFromObjects,
  txFor,
} from '../cli/read-testkit.js';
import { MaterializeError, materializeCommit } from './materialize-commit.js';

const OWNER = 'ab'.repeat(32);
const REPO = 'demo-repo';
const RELAY = 'wss://relay.test.example';

const cleanups: string[] = [];
afterEach(() => {
  clearShaCache();
  for (const dir of cleanups.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(dir);
  return dir;
}

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Fixture',
      GIT_AUTHOR_EMAIL: 'fixture@test',
      GIT_COMMITTER_NAME: 'Fixture',
      GIT_COMMITTER_EMAIL: 'fixture@test',
      GIT_AUTHOR_DATE: '2026-01-02T03:04:05Z',
      GIT_COMMITTER_DATE: '2026-01-02T03:04:05Z',
    },
  }).trim();
}

function makeSourceRepo(): string {
  const dir = tempDir('rig-ci-mat-src-');
  git(['init', '--initial-branch=main'], dir);
  writeFileSync(join(dir, 'README.md'), '# demo\n');
  git(['add', '.'], dir);
  git(['commit', '-m', 'first'], dir);
  writeFileSync(join(dir, 'code.txt'), 'v2\n');
  git(['add', '.'], dir);
  git(['commit', '-m', 'second'], dir);
  return dir;
}

function world(srcDir: string, dropShas: string[] = []) {
  const { announce, refsEvent, objects } = repoStateEvents({
    repoDir: srcDir,
    owner: OWNER,
    repoId: REPO,
  });
  const store = storeFromObjects(objects);
  for (const sha of dropShas) store.delete(txFor(sha));
  const gateway = makeMockGateway(store);
  const events = [announce, refsEvent];
  return {
    webSocketFactory: makeMockRelayFactory((filter) =>
      filterEvents(events, filter)
    ),
    fetchFn: gateway.fetchFn,
    resolveSha: async () => null,
  };
}

describe('materializeCommit', () => {
  it('checks out exactly the requested commit (detached) from relay + gateway', async () => {
    const src = makeSourceRepo();
    const first = git(['rev-parse', 'HEAD~1'], src);
    const dest = join(tempDir('rig-ci-mat-dst-'), 'checkout');

    const result = await materializeCommit({
      ownerPubkey: OWNER,
      repoId: REPO,
      relayUrls: [RELAY],
      commit: first,
      dir: dest,
      ...world(src),
    });

    expect(result.commit).toBe(first);
    expect(result.dir).toBe(dest);
    expect(gitText(dest, ['rev-parse', 'HEAD'])).toBe(first);
    expect(readFileSync(join(dest, 'README.md'), 'utf-8')).toBe('# demo\n');
    // The FIRST commit has no code.txt — the checkout is that commit, not the tip.
    expect(() => readFileSync(join(dest, 'code.txt'))).toThrow();
    expect(gitText(dest, ['status', '--porcelain'])).toBe('');
    expect(gitText(dest, ['fsck', '--strict', '--no-dangling'])).toBe('');
  });

  it('applies a kind:1617 format-patch on its declared base with git am', async () => {
    const src = makeSourceRepo();
    const base = git(['rev-parse', 'HEAD'], src);
    // A contributor's commit on top of `base`, turned into a real patch.
    const contrib = tempDir('rig-ci-mat-contrib-');
    git(['clone', '-q', src, '.'], contrib);
    writeFileSync(join(contrib, 'feature.txt'), 'hello from a PR\n');
    git(['add', '.'], contrib);
    git(['commit', '-m', 'add feature'], contrib);
    const patch = git(['format-patch', '--stdout', `${base}..HEAD`], contrib);
    const dest = join(tempDir('rig-ci-mat-dst-'), 'checkout');

    const result = await materializeCommit({
      ownerPubkey: OWNER,
      repoId: REPO,
      relayUrls: [RELAY],
      commit: base,
      dir: dest,
      patch: { content: patch },
      ...world(src),
    });

    expect(result.commit).not.toBe(base);
    expect(gitText(dest, ['rev-parse', 'HEAD'])).toBe(result.commit);
    expect(gitText(dest, ['rev-parse', 'HEAD~1'])).toBe(base);
    expect(readFileSync(join(dest, 'feature.txt'), 'utf-8')).toBe(
      'hello from a PR\n'
    );
    expect(gitText(dest, ['log', '-1', '--format=%s'])).toBe('add feature');
  });

  it('fails honestly when the commit closure cannot be downloaded', async () => {
    const src = makeSourceRepo();
    const tip = git(['rev-parse', 'HEAD'], src);
    const treeSha = git(['rev-parse', 'HEAD^{tree}'], src);
    const dest = join(tempDir('rig-ci-mat-dst-'), 'checkout');

    await expect(
      materializeCommit({
        ownerPubkey: OWNER,
        repoId: REPO,
        relayUrls: [RELAY],
        commit: tip,
        dir: dest,
        ...world(src, [treeSha]),
      })
    ).rejects.toThrow(MaterializeError);
  });

  it('rejects a patch that does not apply', async () => {
    const src = makeSourceRepo();
    const base = git(['rev-parse', 'HEAD'], src);
    const dest = join(tempDir('rig-ci-mat-dst-'), 'checkout');
    await expect(
      materializeCommit({
        ownerPubkey: OWNER,
        repoId: REPO,
        relayUrls: [RELAY],
        commit: base,
        dir: dest,
        patch: { content: 'this is not a patch\n' },
        ...world(src),
      })
    ).rejects.toThrow(/patch does not apply/);
  });
});
