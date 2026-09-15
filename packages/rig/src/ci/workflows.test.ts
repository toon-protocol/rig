/**
 * Workflow discovery + trigger matching (rig#125): what the coordinator
 * reads out of a materialized checkout to decide which workflows a push,
 * pull request, or manual trigger runs.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  discoverWorkflows,
  matchesPullRequest,
  matchesPush,
  parseWorkflow,
  refMatchesPatterns,
  sha256Hex,
  type DiscoveredWorkflow,
} from './workflows.js';

const cleanups: string[] = [];
afterEach(() => {
  for (const dir of cleanups.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function checkout(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'rig-ci-wf-'));
  cleanups.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content);
  }
  return dir;
}

const CI_YML = `name: CI
on:
  push:
    branches: [main, 'release/**']
    tags: ['v*']
  pull_request:
    branches: [main]
  workflow_dispatch:
jobs:
  build:
    name: Build it
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
  test:
    runs-on: [self-hosted, linux]
    steps:
      - run: echo test
`;

describe('sha256Hex', () => {
  it('hashes bytes to lowercase hex', () => {
    const bytes = Buffer.from('hello');
    expect(sha256Hex(bytes)).toBe(
      createHash('sha256').update(bytes).digest('hex')
    );
  });
});

describe('parseWorkflow', () => {
  it('parses name, on: map, and jobs (runs-on string or array)', () => {
    const wf = parseWorkflow('.github/workflows/ci.yml', CI_YML);
    expect(wf.parseError).toBeUndefined();
    expect(wf.name).toBe('CI');
    expect(wf.sha256).toBe(sha256Hex(Buffer.from(CI_YML)));
    expect(wf.triggers).toEqual({
      push: { branches: ['main', 'release/**'], tags: ['v*'] },
      pull_request: { branches: ['main'] },
      workflow_dispatch: true,
    });
    expect(wf.jobs).toEqual([
      { id: 'build', name: 'Build it', runsOn: ['ubuntu-latest'] },
      { id: 'test', runsOn: ['self-hosted', 'linux'] },
    ]);
  });

  it('accepts `on: push` (string) and `on: [push, pull_request]` (array)', () => {
    const asString = parseWorkflow(
      'a.yml',
      'on: push\njobs:\n  a:\n    runs-on: x\n'
    );
    expect(asString.triggers).toEqual({ push: {} });
    const asArray = parseWorkflow(
      'b.yml',
      'on: [push, pull_request, workflow_dispatch]\njobs: {}\n'
    );
    expect(asArray.triggers).toEqual({
      push: {},
      pull_request: {},
      workflow_dispatch: true,
    });
  });

  it('accepts a bare `push:` key with no options and a single-string branch', () => {
    const wf = parseWorkflow(
      'c.yml',
      'on:\n  push:\n  pull_request:\n    branches: main\njobs: {}\n'
    );
    expect(wf.triggers).toEqual({
      push: {},
      pull_request: { branches: ['main'] },
    });
  });

  it('tolerates the YAML 1.1 `on` → true key quirk', () => {
    // `on:` unquoted is parsed as boolean true by YAML 1.1 loaders; the
    // yaml package (1.2) keeps it a string, but a workflow saved with `true:`
    // must still be understood.
    const wf = parseWorkflow('d.yml', 'true:\n  push:\njobs: {}\n');
    expect(wf.triggers).toEqual({ push: {} });
  });

  it('never throws on malformed YAML — sets parseError instead', () => {
    const wf = parseWorkflow('e.yml', 'on: [push\njobs: {');
    expect(wf.parseError).toMatch(/./);
    expect(wf.triggers).toEqual({});
    expect(wf.jobs).toEqual([]);
    expect(wf.sha256).toHaveLength(64);
  });

  it('flags a document that is not a workflow map', () => {
    expect(parseWorkflow('f.yml', '- just\n- a list\n').parseError).toMatch(
      /mapping/i
    );
    expect(parseWorkflow('g.yml', 'name: x\njobs: {}\n').parseError).toMatch(
      /on/
    );
  });
});

describe('discoverWorkflows', () => {
  it('scans .github/workflows then .ngit/act/workflows, sorted, yml + yaml', async () => {
    const dir = checkout({
      '.github/workflows/zeta.yaml': 'on: push\njobs: {}\n',
      '.github/workflows/alpha.yml': CI_YML,
      '.github/workflows/README.md': 'not a workflow',
      '.ngit/act/workflows/ngit.yml': 'on: pull_request\njobs: {}\n',
      'src/other.yml': 'on: push\n',
    });
    const found = await discoverWorkflows(dir);
    expect(found.map((w) => w.path)).toEqual([
      '.github/workflows/alpha.yml',
      '.github/workflows/zeta.yaml',
      '.ngit/act/workflows/ngit.yml',
    ]);
    expect(found[0]?.name).toBe('CI');
  });

  it('returns an empty list when neither directory exists', async () => {
    const dir = checkout({ 'README.md': 'x' });
    expect(await discoverWorkflows(dir)).toEqual([]);
  });

  it('reports a broken file alongside the good ones', async () => {
    const dir = checkout({
      '.github/workflows/bad.yml': 'on: [push\n',
      '.github/workflows/good.yml': 'on: push\njobs: {}\n',
    });
    const found = await discoverWorkflows(dir);
    expect(found.map((w) => [w.path, w.parseError !== undefined])).toEqual([
      ['.github/workflows/bad.yml', true],
      ['.github/workflows/good.yml', false],
    ]);
  });
});

describe('refMatchesPatterns (GitHub branch/tag filter semantics)', () => {
  it('matches exact names, * within one segment, ** across segments', () => {
    expect(refMatchesPatterns('main', ['main'])).toBe(true);
    expect(refMatchesPatterns('feature/x', ['feature/*'])).toBe(true);
    expect(refMatchesPatterns('feature/x/y', ['feature/*'])).toBe(false);
    expect(refMatchesPatterns('feature/x/y', ['feature/**'])).toBe(true);
    expect(refMatchesPatterns('v1.2.3', ['v*'])).toBe(true);
    expect(refMatchesPatterns('release', ['releases/**'])).toBe(false);
  });

  it('applies ! negation in order (later patterns win)', () => {
    expect(
      refMatchesPatterns('releases/beta', ['releases/**', '!releases/*-alpha'])
    ).toBe(true);
    expect(
      refMatchesPatterns('releases/x-alpha', [
        'releases/**',
        '!releases/*-alpha',
      ])
    ).toBe(false);
    // A negation with no prior positive match is not an include.
    expect(refMatchesPatterns('main', ['!other'])).toBe(false);
  });

  it('escapes regex metacharacters in patterns', () => {
    expect(refMatchesPatterns('v1.2', ['v1.2'])).toBe(true);
    expect(refMatchesPatterns('v1x2', ['v1.2'])).toBe(false);
  });
});

function wf(triggers: DiscoveredWorkflow['triggers']): DiscoveredWorkflow {
  return { path: 'w.yml', sha256: '0'.repeat(64), triggers, jobs: [] };
}

describe('matchesPush', () => {
  it('runs on any ref when push has no filters', () => {
    expect(matchesPush(wf({ push: {} }), 'refs/heads/anything')).toBe(true);
    expect(matchesPush(wf({ push: {} }), 'refs/tags/v1')).toBe(true);
  });

  it('honours branches for refs/heads and tags for refs/tags', () => {
    const w = wf({ push: { branches: ['main'], tags: ['v*'] } });
    expect(matchesPush(w, 'refs/heads/main')).toBe(true);
    expect(matchesPush(w, 'refs/heads/dev')).toBe(false);
    expect(matchesPush(w, 'refs/tags/v2')).toBe(true);
    expect(matchesPush(w, 'refs/tags/nightly')).toBe(false);
  });

  it('a branches-only filter never runs for tags (GitHub semantics), and vice versa', () => {
    expect(
      matchesPush(wf({ push: { branches: ['main'] } }), 'refs/tags/v1')
    ).toBe(false);
    expect(matchesPush(wf({ push: { tags: ['v*'] } }), 'refs/heads/main')).toBe(
      false
    );
  });

  it('never runs for a workflow without push or with a parse error', () => {
    expect(matchesPush(wf({ pull_request: {} }), 'refs/heads/main')).toBe(
      false
    );
    expect(
      matchesPush({ ...wf({ push: {} }), parseError: 'x' }, 'refs/heads/main')
    ).toBe(false);
  });
});

describe('matchesPullRequest', () => {
  it('runs when pull_request is declared and the base branch passes the filter', () => {
    expect(matchesPullRequest(wf({ pull_request: {} }))).toBe(true);
    expect(
      matchesPullRequest(wf({ pull_request: {} }), 'refs/heads/main')
    ).toBe(true);
    const w = wf({ pull_request: { branches: ['main'] } });
    expect(matchesPullRequest(w, 'refs/heads/main')).toBe(true);
    expect(matchesPullRequest(w, 'main')).toBe(true);
    expect(matchesPullRequest(w, 'refs/heads/dev')).toBe(false);
    // Unknown base with a branch filter: cannot prove a match → do not run.
    expect(matchesPullRequest(w)).toBe(false);
  });

  it('never runs without pull_request', () => {
    expect(matchesPullRequest(wf({ push: {} }), 'refs/heads/main')).toBe(false);
  });
});
