/**
 * `rig pr merge` tests: real temporary git repos, a mock relay for the patch
 * events, and the Publisher seam recording every paid call in order.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildCiServiceRequest,
  buildCiWorkflowResult,
} from '../ci/nip-c1-events.js';
import type { Publisher } from '../publisher.js';
import type { NostrEvent, RemoteState } from '../remote-state.js';
import type { EventCommandDeps } from './events.js';
import { runPrMerge } from './merge.js';
import { writeToonConfig } from './git-config.js';
import type { CliIo } from './output.js';
import { filterEvents, makeMockRelayFactory } from './read-testkit.js';
import type { StandaloneContext } from './standalone-context.js';

const OWNER = 'ab'.repeat(32);
const MAINTAINER = '12'.repeat(32);
const CONTRIB = 'cd'.repeat(32);
const STRANGER = 'ef'.repeat(32);
const RELAY = 'wss://relay.test.example';
const REPO_ID = 'demo';
const A_TAG = `30617:${OWNER}:${REPO_ID}`;
const PATCH_ID = 'b1'.repeat(32);
const REVISION_ID = 'b2'.repeat(32);

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Fixture',
      GIT_AUTHOR_EMAIL: 'fixture@test',
      GIT_COMMITTER_NAME: 'Fixture',
      GIT_COMMITTER_EMAIL: 'fixture@test',
    },
  }).trim();
}

function commitFile(
  dir: string,
  name: string,
  body: string,
  msg: string
): string {
  writeFileSync(join(dir, name), body);
  git(dir, 'add', '.');
  git(dir, 'commit', '-m', msg);
  return git(dir, 'rev-parse', 'HEAD');
}

interface Fixture {
  dir: string;
  home: string;
  base: string;
  /** format-patch text of a commit adding feature.txt on top of base. */
  cleanPatch: string;
  /** format-patch text of a commit changing README against base. */
  readmePatch: string;
}

function makeFixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'rig-merge-repo-'));
  const home = mkdtempSync(join(tmpdir(), 'rig-merge-home-'));
  git(dir, 'init', '--initial-branch=main');
  const base = commitFile(dir, 'README.md', 'base\n', 'base');
  git(dir, 'checkout', '-b', 'feature');
  commitFile(dir, 'feature.txt', 'feature\n', 'add feature');
  const cleanPatch = git(dir, 'format-patch', '--stdout', 'main..feature');
  git(dir, 'checkout', 'main');
  git(dir, 'checkout', '-b', 'readme');
  commitFile(dir, 'README.md', 'from contributor\n', 'edit readme');
  const readmePatch = git(dir, 'format-patch', '--stdout', 'main..readme');
  git(dir, 'checkout', 'main');
  return {
    dir,
    home,
    base,
    cleanPatch: cleanPatch + '\n',
    readmePatch: readmePatch + '\n',
  };
}

function patchEvent(
  id: string,
  pubkey: string,
  content: string,
  tags: string[][] = [],
  created_at = 100
): NostrEvent {
  return {
    id,
    kind: 1617,
    pubkey,
    created_at,
    tags: [['a', A_TAG], ...tags],
    content,
    sig: 'f0'.repeat(64),
  };
}

interface MergeJson {
  executed?: boolean;
  mergedShas: string[];
  statusEventId?: string;
  revisionId?: string;
  target?: string;
  error?: string;
  detail?: string;
  partial?: boolean;
  hint?: string;
  closed?: string[];
  closeErrors?: { issueId: string; error: string }[];
}

interface World {
  published: { kind: number; tags: string[][] }[];
  calls: string[];
  out: string[];
  err: string[];
  json: MergeJson[];
  last(): MergeJson;
  run(args: string[]): Promise<number>;
}

function makeWorld(
  fx: Fixture,
  opts: {
    events: NostrEvent[];
    identity?: string;
    refs?: Record<string, string>;
    headSymref?: string;
    failKind?: number;
  }
): World {
  const published: World['published'] = [];
  const calls: string[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const json: MergeJson[] = [];
  const announce: NostrEvent = {
    id: 'a1'.repeat(32),
    kind: 30617,
    pubkey: OWNER,
    created_at: 1,
    tags: [
      ['d', REPO_ID],
      ['maintainers', MAINTAINER],
    ],
    content: '',
    sig: 'f0'.repeat(64),
  };
  const remote: RemoteState = {
    announced: true,
    refs: new Map(Object.entries(opts.refs ?? { 'refs/heads/main': fx.base })),
    headSymref: opts.headSymref ?? 'refs/heads/main',
    shaToTxId: new Map(),
    refsEvent: null,
    announceEvent: announce,
    name: null,
    description: null,
    relays: [],
    maintainers: [MAINTAINER],
    payout: null,
    resolveMissing: async () => new Map(),
  };
  const publisher: Publisher = {
    getFeeRates: async () => ({ uploadFee: 10n, eventFee: 1n }),
    uploadGitObject: async () => {
      calls.push('upload');
      return { txId: 'x'.repeat(43), feePaid: 10n };
    },
    publishEvent: async (event) => {
      if (event.kind === opts.failKind) throw new Error('relay said no');
      calls.push(`publish:${event.kind}`);
      published.push({ kind: event.kind, tags: event.tags });
      return { eventId: `${event.kind}`.padEnd(64, '0'), feePaid: 1n };
    },
  };
  const ctx: StandaloneContext = {
    ownerPubkey: opts.identity ?? OWNER,
    identitySource: 'env',
    identitySourceLabel: 'test',
    publisher,
    defaultRelayUrls: [],
    fetchRemote: async () => remote,
    stop: async () => undefined,
  };
  const io: CliIo = {
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    emitJson: (p) => json.push(p as MergeJson),
    isInteractive: false,
    confirm: async () => false,
  };
  const deps: EventCommandDeps = {
    io,
    env: { TOON_CLIENT_HOME: fx.home },
    cwd: fx.dir,
    loadStandalone: async () => ctx,
    probeDaemon: async () => ({
      baseUrl: 'http://127.0.0.1:1',
      reachable: false,
    }),
    webSocketFactory: makeMockRelayFactory((filter) =>
      filterEvents(opts.events, filter)
    ),
  };
  return {
    published,
    calls,
    out,
    err,
    json,
    last: () => {
      const doc = json.at(-1);
      if (!doc) throw new Error('no JSON document emitted');
      return doc;
    },
    run: (args) => runPrMerge([...args, '--relay', RELAY], deps),
  };
}

let fx: Fixture;
beforeEach(async () => {
  fx = makeFixture();
  await writeToonConfig(fx.dir, { repoId: REPO_ID, owner: OWNER });
});
afterEach(() => {
  rmSync(fx.dir, { recursive: true, force: true });
  rmSync(fx.home, { recursive: true, force: true });
});

describe('rig pr merge', () => {
  it('pushes first, then publishes the 1631 naming the applied SHAs', async () => {
    const w = makeWorld(fx, {
      events: [patchEvent(PATCH_ID, CONTRIB, fx.cleanPatch)],
    });
    expect(await w.run([PATCH_ID, '--yes', '--json'])).toBe(0);

    const doc = w.last();
    expect(doc.executed).toBe(true);
    expect(doc.mergedShas).toHaveLength(1);
    // Push (uploads + 30618) strictly before the status.
    expect(w.calls.at(-1)).toBe('publish:1631');
    expect(w.calls.indexOf('publish:30618')).toBeLessThan(
      w.calls.indexOf('publish:1631')
    );
    const status = w.published.find((p) => p.kind === 1631);
    if (!status) throw new Error('no status published');
    expect(status.tags).toContainEqual([
      'applied-as-commits',
      ...doc.mergedShas,
    ]);
    expect(status.tags).toContainEqual(['e', PATCH_ID, '', 'root']);
    expect(status.tags).toContainEqual(['r', doc.mergedShas[0]]);
    expect(doc.statusEventId).toBeTruthy();
    // Local branch moved to the merge; working tree has the new file.
    expect(git(fx.dir, 'rev-parse', 'main')).toBe(doc.mergedShas[0]);
    expect(readFileSync(join(fx.dir, 'feature.txt'), 'utf-8')).toBe(
      'feature\n'
    );
  });

  it('merges the latest authorized revision and names it in the status', async () => {
    const revision = patchEvent(
      REVISION_ID,
      MAINTAINER,
      fx.cleanPatch,
      [
        ['t', 'root-revision'],
        ['e', PATCH_ID, '', 'reply'],
      ],
      200
    );
    const w = makeWorld(fx, {
      events: [patchEvent(PATCH_ID, CONTRIB, fx.readmePatch), revision],
    });
    expect(await w.run([PATCH_ID, '--yes', '--json'])).toBe(0);
    expect(w.last().revisionId).toBe(REVISION_ID);
    const status = w.published.find((p) => p.kind === 1631);
    if (!status) throw new Error('no status published');
    expect(status.tags).toContainEqual(['e', REVISION_ID, '', 'reply']);
  });

  it('leaves the working tree untouched and publishes nothing on a conflict', async () => {
    const conflicted = commitFile(
      fx.dir,
      'README.md',
      'from main\n',
      'diverge'
    );
    const w = makeWorld(fx, {
      events: [patchEvent(PATCH_ID, CONTRIB, fx.readmePatch)],
      refs: { 'refs/heads/main': conflicted },
    });
    expect(await w.run([PATCH_ID, '--yes', '--json'])).toBe(1);
    expect(w.last().error).toBe('apply_conflict');
    expect(w.calls).toEqual([]);
    expect(git(fx.dir, 'rev-parse', 'main')).toBe(conflicted);
    expect(git(fx.dir, 'status', '--porcelain')).toBe('');
    expect(readFileSync(join(fx.dir, 'README.md'), 'utf-8')).toBe(
      'from main\n'
    );
    expect(git(fx.dir, 'worktree', 'list').split('\n')).toHaveLength(1);
  });

  it('refuses a non-maintainer before anything is published', async () => {
    const w = makeWorld(fx, {
      events: [patchEvent(PATCH_ID, CONTRIB, fx.cleanPatch)],
      identity: STRANGER,
    });
    expect(await w.run([PATCH_ID, '--yes', '--json'])).toBe(1);
    expect(w.last().error).toBe('not_authorized');
    expect(w.calls).toEqual([]);
  });

  it('lets a declared maintainer merge', async () => {
    const w = makeWorld(fx, {
      events: [patchEvent(PATCH_ID, CONTRIB, fx.cleanPatch)],
      identity: MAINTAINER,
    });
    expect(await w.run([PATCH_ID, '--yes', '--json'])).toBe(0);
  });

  it('publishes no status when the push fails', async () => {
    const w = makeWorld(fx, {
      events: [patchEvent(PATCH_ID, CONTRIB, fx.cleanPatch)],
      failKind: 30618,
    });
    expect(await w.run([PATCH_ID, '--yes', '--json'])).toBe(1);
    expect(w.calls).not.toContain('publish:1631');
    expect(git(fx.dir, 'rev-parse', 'main')).toBe(fx.base);
  });

  it('refuses without a confirmation and spends nothing', async () => {
    const w = makeWorld(fx, {
      events: [patchEvent(PATCH_ID, CONTRIB, fx.cleanPatch)],
    });
    expect(await w.run([PATCH_ID, '--json'])).toBe(0);
    expect(w.last().executed).toBe(false);
    expect(w.calls).toEqual([]);
    expect(await w.run([PATCH_ID])).toBe(1);
    expect(w.calls).toEqual([]);
  });

  it('reports a status failure after a successful push as a partial success', async () => {
    const w = makeWorld(fx, {
      events: [patchEvent(PATCH_ID, CONTRIB, fx.cleanPatch)],
      failKind: 1631,
    });
    expect(await w.run([PATCH_ID, '--yes', '--json'])).toBe(1);
    const doc = w.last();
    expect(doc.partial).toBe(true);
    expect(doc.error).toBe('status_publish_failed');
    expect(doc.hint).toContain(`rig pr status ${PATCH_ID} applied`);
    expect(doc.mergedShas).toHaveLength(1);
    expect(w.calls).toContain('publish:30618');
  });

  describe('--require-ci-trust', () => {
    const HEAD = '1a'.repeat(20);
    const ISSUE_A = 'c1'.repeat(32);
    const ISSUE_B = 'c2'.repeat(32);
    const ciRun = (conclusion: 'success' | 'failure', trusted = true) => ({
      id: 'd1'.repeat(32),
      pubkey: 'cd'.repeat(32),
      sig: 'f0'.repeat(64),
      ...buildCiWorkflowResult(
        {
          trigger: {
            repoAddr: A_TAG,
            commit: HEAD,
            workflow: {
              path: '.github/workflows/ci.yml',
              sha256: '3c'.repeat(32),
            },
            reason: 'push',
            ref: 'refs/heads/main',
          },
          runId: 'run-1',
          conclusion,
          ...(trusted
            ? {
                provenance: {
                  kind: 'service-request' as const,
                  eventId: '11'.repeat(32),
                  relayUrl: RELAY,
                  pubkey: OWNER,
                },
              }
            : {}),
          jobs: [],
        },
        1_800_000_000
      ),
    });
    const patch = () =>
      patchEvent(PATCH_ID, CONTRIB, fx.cleanPatch, [['commit', HEAD]]);

    it('blocks the merge, paying nothing, when no green run exists', async () => {
      const w = makeWorld(fx, { events: [patch()] });
      expect(
        await w.run([
          PATCH_ID,
          '--yes',
          '--json',
          '--require-ci-trust',
          'maintainer-directed',
        ])
      ).toBe(1);
      expect(w.last().error).toBe('ci_gate_failed');
      expect(w.calls).toEqual([]);
    });

    it('blocks on a red run and on a run below the trust level', async () => {
      for (const run of [ciRun('failure'), ciRun('success', false)]) {
        const w = makeWorld(fx, { events: [patch(), run] });
        expect(
          await w.run([
            PATCH_ID,
            '--yes',
            '--json',
            '--require-ci-trust',
            'maintainer-directed',
          ])
        ).toBe(1);
        expect(w.calls).toEqual([]);
      }
    });

    it('merges when a qualifying green run exists', async () => {
      const request: NostrEvent = {
        id: '11'.repeat(32),
        pubkey: OWNER,
        sig: 'f0'.repeat(64),
        ...buildCiServiceRequest(
          A_TAG,
          'cd'.repeat(32),
          RELAY,
          1_800_000_000 - 100
        ),
      };
      const w = makeWorld(fx, {
        events: [patch(), ciRun('success'), request],
      });
      const code = await w.run([
        PATCH_ID,
        '--yes',
        '--json',
        '--require-ci-trust',
        'maintainer-directed',
      ]);
      expect(code).toBe(0);
      expect(w.calls).toContain('publish:1631');
    });

    it('rejects an unknown trust level', async () => {
      const w = makeWorld(fx, { events: [patch()] });
      expect(await w.run([PATCH_ID, '--require-ci-trust', 'bogus'])).toBe(2);
    });

    it('--closes publishes a 1632 per issue after the merge and lists them', async () => {
      const w = makeWorld(fx, { events: [patch()] });
      expect(
        await w.run([
          PATCH_ID,
          '--yes',
          '--json',
          '--closes',
          ISSUE_A,
          '--closes',
          ISSUE_B,
        ])
      ).toBe(0);
      expect(w.last().closed).toEqual([ISSUE_A, ISSUE_B]);
      const closes = w.published.filter((p) => p.kind === 1632);
      expect(closes.map((c) => c.tags[0]?.[1])).toEqual([ISSUE_A, ISSUE_B]);
      expect(w.calls.indexOf('publish:1631')).toBeLessThan(
        w.calls.indexOf('publish:1632')
      );
    });

    it('a failed merge closes no issues', async () => {
      const conflicted = commitFile(
        fx.dir,
        'README.md',
        'from main\n',
        'diverge'
      );
      const w = makeWorld(fx, {
        events: [patchEvent(PATCH_ID, CONTRIB, fx.readmePatch)],
        refs: { 'refs/heads/main': conflicted },
      });
      expect(
        await w.run([PATCH_ID, '--yes', '--json', '--closes', ISSUE_A])
      ).toBe(1);
      expect(w.published.filter((p) => p.kind === 1632)).toEqual([]);
    });

    it('a failed push closes no issues', async () => {
      const w = makeWorld(fx, { events: [patch()], failKind: 30618 });
      expect(
        await w.run([PATCH_ID, '--yes', '--json', '--closes', ISSUE_A])
      ).toBe(1);
      expect(w.calls).not.toContain('publish:1632');
    });

    it('reports a failed close after a successful merge as a partial success', async () => {
      const w = makeWorld(fx, { events: [patch()], failKind: 1632 });
      expect(
        await w.run([PATCH_ID, '--yes', '--json', '--closes', ISSUE_A])
      ).toBe(1);
      const doc = w.last();
      expect(doc.partial).toBe(true);
      expect(doc.error).toBe('close_publish_failed');
      expect(doc.closed).toEqual([]);
      expect(doc.closeErrors).toEqual([
        { issueId: ISSUE_A, error: 'relay said no' },
      ]);
      expect(doc.hint).toContain(`rig issue close ${ISSUE_A}`);
    });
  });

  describe('target resolution', () => {
    const refs = { 'refs/heads/main': '', 'refs/heads/dev': '' };
    const target = async (
      tags: string[][],
      args: string[],
      headSymref = 'refs/heads/main'
    ): Promise<string> => {
      const w = makeWorld(fx, {
        events: [patchEvent(PATCH_ID, CONTRIB, fx.cleanPatch, tags)],
        refs: Object.fromEntries(Object.keys(refs).map((k) => [k, fx.base])),
        headSymref,
      });
      expect(await w.run([PATCH_ID, '--yes', '--json', ...args])).toBe(0);
      return w.last().target ?? '';
    };

    it('--target wins over the branch-name tag', async () => {
      expect(await target([['branch-name', 'dev']], ['--target', 'main'])).toBe(
        'refs/heads/main'
      );
    });
    it('the branch-name tag wins over the default branch', async () => {
      expect(await target([['branch-name', 'dev']], [])).toBe('refs/heads/dev');
    });
    it('falls back to the default branch', async () => {
      expect(await target([], [], 'refs/heads/dev')).toBe('refs/heads/dev');
    });
  });
});

describe('rig pr merge: multi-event series', () => {
  const P2 = 'b4'.repeat(32); // sorts after P3, so id order alone is wrong
  const P3 = 'b3'.repeat(32);
  const FIRST = '1a'.repeat(20);
  const LAST = '2b'.repeat(20);

  type Mails = [string, string, string];

  /** Three commits as three format-patch mails, as ngit sends them. */
  function seriesMails(): Mails {
    git(fx.dir, 'checkout', '-b', 'series');
    commitFile(fx.dir, 'one.txt', '1\n', 'one');
    commitFile(fx.dir, 'two.txt', '2\n', 'two');
    commitFile(fx.dir, 'three.txt', '3\n', 'three');
    const mail = (back: number) =>
      git(fx.dir, 'format-patch', '--stdout', '-1', `HEAD~${back}`) + '\n';
    const mails: Mails = [mail(2), mail(1), mail(0)];
    git(fx.dir, 'checkout', 'main');
    return mails;
  }

  /**
   * Root plus two follow-ons, each `e`-replying to the previous patch. The
   * ngit shape also tags every follow-on with the series root and gives all
   * three the same `created_at`, so only the reply chain orders them.
   */
  function series(
    mails: Mails,
    opts: { lastAuthor?: string; middleAuthor?: string; ngit?: boolean } = {}
  ): NostrEvent[] {
    const at = (t: number) => (opts.ngit ? 100 : t);
    const root = opts.ngit ? [['e', PATCH_ID, '', 'root']] : [];
    return [
      patchEvent(PATCH_ID, CONTRIB, mails[0], [['commit', FIRST]], at(100)),
      patchEvent(
        P2,
        opts.middleAuthor ?? CONTRIB,
        mails[1],
        [['e', PATCH_ID, '', opts.ngit ? 'reply' : 'root']],
        at(101)
      ),
      patchEvent(
        P3,
        opts.lastAuthor ?? CONTRIB,
        mails[2],
        [...root, ['e', P2, '', 'reply'], ['commit', LAST]],
        at(102)
      ),
    ];
  }

  it('applies every event of the series and names all SHAs in the 1631', async () => {
    const w = makeWorld(fx, { events: series(seriesMails()) });
    expect(await w.run([PATCH_ID, '--yes', '--json'])).toBe(0);
    const shas = w.last().mergedShas;
    expect(shas).toHaveLength(3);
    expect(git(fx.dir, 'rev-parse', 'main')).toBe(shas[2]);
    expect(git(fx.dir, 'log', '--format=%s', '-3', 'main')).toBe(
      'three\ntwo\none'
    );
    const status = w.published.find((e) => e.kind === 1631);
    expect(status?.tags).toContainEqual(['applied-as-commits', ...shas]);
  });

  it('orders an ngit series (root-tagged, same created_at) by its reply chain', async () => {
    const w = makeWorld(fx, { events: series(seriesMails(), { ngit: true }) });
    expect(await w.run([PATCH_ID, '--yes', '--json'])).toBe(0);
    expect(w.last().mergedShas).toHaveLength(3);
    expect(git(fx.dir, 'log', '--format=%s', '-3', 'main')).toBe(
      'three\ntwo\none'
    );
  });

  it('gates CI on the final commit of the series', async () => {
    const w = makeWorld(fx, { events: series(seriesMails()) });
    expect(
      await w.run([
        PATCH_ID,
        '--yes',
        '--json',
        '--require-ci-trust',
        'maintainer-directed',
      ])
    ).toBe(1);
    expect(w.last().error).toBe('ci_gate_failed');
    expect(w.last().detail).toContain(LAST.slice(0, 12));
    expect(w.calls).toEqual([]);
  });

  it('ignores a follow-on patch from a stranger', async () => {
    const w = makeWorld(fx, {
      events: series(seriesMails(), { lastAuthor: STRANGER }),
    });
    expect(await w.run([PATCH_ID, '--yes', '--json'])).toBe(0);
    expect(w.last().mergedShas).toHaveLength(2);
  });

  it("drops what follows a stranger's patch rather than applying over the gap", async () => {
    const w = makeWorld(fx, {
      events: series(seriesMails(), { middleAuthor: STRANGER, ngit: true }),
    });
    expect(await w.run([PATCH_ID, '--yes', '--json'])).toBe(0);
    expect(w.last().mergedShas).toHaveLength(1);
  });

  it('restores everything and publishes nothing when a later patch conflicts', async () => {
    const mails = seriesMails();
    const conflicted = commitFile(fx.dir, 'two.txt', 'other\n', 'diverge');
    const w = makeWorld(fx, {
      events: series(mails),
      refs: { 'refs/heads/main': conflicted },
    });
    expect(await w.run([PATCH_ID, '--yes', '--json'])).toBe(1);
    expect(w.last().error).toBe('apply_conflict');
    expect(w.calls).toEqual([]);
    expect(git(fx.dir, 'rev-parse', 'main')).toBe(conflicted);
    expect(git(fx.dir, 'status', '--porcelain')).toBe('');
    expect(git(fx.dir, 'worktree', 'list').split('\n')).toHaveLength(1);
  });
});
