// The no-op merge guard must fail a PR whose merge result changes nothing and
// pass one with a real diff. Builds throwaway repos shaped like refs/pull/N/merge.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const script = resolve(import.meta.dirname, '../../.github/scripts/no-op-merge-guard.sh');

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
  }).trim();
}

// `headContent` is what the PR branch writes to f.txt; `baseContent` what main
// acquires meanwhile. Equal contents reproduce the connector#1008 shape.
function mergeResult(headContent: string, baseContent: string): { dir: string; head: string } {
  const dir = mkdtempSync(join(tmpdir(), 'noop-guard-'));
  git(dir, 'init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'f.txt'), 'start\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'start');
  git(dir, 'checkout', '-q', '-b', 'pr');
  writeFileSync(join(dir, 'f.txt'), headContent);
  git(dir, 'commit', '-qam', 'pr');
  const head = git(dir, 'rev-parse', 'HEAD');
  git(dir, 'checkout', '-q', 'main');
  writeFileSync(join(dir, 'f.txt'), baseContent);
  writeFileSync(join(dir, 'g.txt'), 'main moved\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'main moves');
  git(dir, 'checkout', '-q', '-b', 'merge');
  git(dir, 'merge', '-q', '--no-ff', '-m', 'merge', 'pr');
  return { dir, head };
}

function run(dir: string, head: string, event = 'pull_request') {
  return spawnSync('bash', [script], {
    cwd: dir,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      GITHUB_EVENT_NAME: event,
      PR_HEAD_SHA: head,
      PR_BASE_REF: 'main',
      PR_NUMBER: '1',
      PR_CHANGED_FILES: '1',
    },
  });
}

describe('no-op merge guard', () => {
  it('fails when the merge result changes zero files', () => {
    const { dir, head } = mergeResult('same\n', 'same\n');
    const r = run(dir, head);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /EMPTY commit/);
  });

  it('passes when the merge result has a real diff', () => {
    const { dir, head } = mergeResult('changed\n', 'start\n');
    const r = run(dir, head);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /changes 1 file/);
  });

  it('passes with no merge result to evaluate on push', () => {
    const { dir, head } = mergeResult('same\n', 'same\n');
    assert.equal(run(dir, head, 'push').status, 0);
  });
});
