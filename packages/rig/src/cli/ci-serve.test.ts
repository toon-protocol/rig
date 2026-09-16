/**
 * `rig ci serve` tests (#125): flag validation, the act-missing refusal
 * (before anything is loaded or paid), and a full serve session driven
 * through the dispatch-level seams — fake standalone context (fake
 * Publisher), scripted relay, FakeRunner, injected abort signal — proving the
 * coordinator advertises, runs a push, and stops cleanly with exit 0, with
 * exactly one JSON document under `--json`.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearShaCache } from '@toon-protocol/arweave';
import {
  fakePublisher,
  flush,
  makeScriptedRelay,
  waitFor,
} from '../ci/ci-testkit.js';
import {
  CI_ADVERTISEMENT_KIND,
  CI_WORKFLOW_RESULT_KIND,
  buildCiServiceRequest,
  repoAddress,
} from '../ci/nip-c1-events.js';
import { FakeRunner } from '../ci/runner.js';
import type { NostrEvent } from '../remote-state.js';
import { hexToNpub } from '../npub.js';
import type { CiDeps } from './ci.js';
import {
  estimateRunCost,
  makeAffordabilityCheck,
  runCiServe,
} from './ci-serve.js';
import {
  ChannelMapStore,
  resolveChannelPaths,
} from '../standalone/channel-map.js';
import { dispatch } from './dispatch.js';
import type { CliIo } from './output.js';
import {
  makeMockGateway,
  repoStateEvents,
  storeFromObjects,
} from './read-testkit.js';
import type { StandaloneContext } from './standalone-context.js';

const OWNER = 'ab'.repeat(32);
const MAINT = 'cd'.repeat(32);
const STRANGER = 'ef'.repeat(32);
const COORD = '12'.repeat(32);
const REPO = 'demo';
const RELAY = 'wss://relay.test.example';

const cleanups: string[] = [];

/** Narrow an optional value or fail the test loudly (no non-null assertions). */
function must<T>(value: T | undefined | null, what = 'value'): T {
  if (value === undefined || value === null) {
    throw new Error(`expected ${what} to be present`);
  }
  return value;
}
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

interface Recorder {
  io: CliIo;
  out: string[];
  err: string[];
  json: unknown[];
}

function makeIo(): Recorder {
  const out: string[] = [];
  const err: string[] = [];
  const json: unknown[] = [];
  return {
    out,
    err,
    json,
    io: {
      out: (line) => out.push(line),
      err: (line) => err.push(line),
      emitJson: (payload) => json.push(payload),
      isInteractive: false,
      confirm: async () => false,
    },
  };
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
    },
  }).trim();
}

function signed(
  event: {
    kind: number;
    tags: string[][];
    content: string;
    created_at: number;
  },
  pubkey: string,
  n: number
): NostrEvent {
  return {
    id: n.toString(16).padStart(64, '0'),
    pubkey,
    sig: 'f0'.repeat(64),
    ...event,
  };
}

function makeServeWorld() {
  const srcDir = tempDir('rig-ci-serve-src-');
  git(['init', '--initial-branch=main'], srcDir);
  mkdirSync(join(srcDir, '.github', 'workflows'), { recursive: true });
  writeFileSync(
    join(srcDir, '.github', 'workflows', 'ci.yml'),
    'on: push\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - run: true\n'
  );
  writeFileSync(join(srcDir, 'README.md'), '# demo\n');
  git(['add', '.'], srcDir);
  git(['commit', '-m', 'initial'], srcDir);

  const store = new Map<string, Uint8Array>();
  const gateway = makeMockGateway(store);
  const relay = makeScriptedRelay();
  const publisher = fakePublisher();
  const snapshot = (createdAt: number) => {
    const { announce, refsEvent, objects } = repoStateEvents({
      repoDir: srcDir,
      owner: OWNER,
      repoId: REPO,
      createdAt,
    });
    for (const [tx, bytes] of storeFromObjects(objects)) store.set(tx, bytes);
    announce.tags.push(['maintainers', MAINT]);
    return { announce, refsEvent };
  };
  const { announce, refsEvent } = snapshot(1000);
  relay.serve([
    announce,
    refsEvent,
    signed(
      buildCiServiceRequest(repoAddress(OWNER, REPO), COORD, RELAY, 1100),
      MAINT,
      1
    ),
  ]);

  let stopped = 0;
  const context: StandaloneContext = {
    ownerPubkey: COORD,
    identitySource: 'env',
    identitySourceLabel: 'RIG_MNEMONIC env',
    publisher,
    defaultRelayUrls: [RELAY],
    fetchRemote: async () => {
      throw new Error(
        'the coordinator reads via fetchRemoteState, not fetchRemote'
      );
    },
    stop: async () => {
      stopped += 1;
    },
  };
  const abort = new AbortController();
  const rec = makeIo();
  const stateDir = join(tempDir('rig-ci-serve-state-'), 'state');
  const runner = new FakeRunner();
  const home = tempDir('rig-ci-serve-home-');
  const deps: CiDeps = {
    io: rec.io,
    env: { TOON_CLIENT_HOME: home },
    cwd: tempDir('rig-ci-serve-cwd-'),
    loadStandalone: async () => context,
    // The default wallet check reads THIS identity's recorded channels under
    // TOON_CLIENT_HOME; the affordability tests below drop this override.
    canAfford: async () => true,
    webSocketFactory: relay.factory,
    fetchFn: gateway.fetchFn,
    resolveSha: async () => null,
    runner,
    stateDir,
    signal: abort.signal,
  };
  return {
    srcDir,
    relay,
    publisher,
    gateway,
    snapshot,
    abort,
    rec,
    deps,
    runner,
    stateDir,
    home,
    context,
    stoppedCount: () => stopped,
    push(createdAt: number) {
      writeFileSync(join(srcDir, 'code.txt'), `v${createdAt}\n`);
      git(['add', '.'], srcDir);
      git(['commit', '-m', `change ${createdAt}`], srcDir);
      relay.push(snapshot(createdAt).refsEvent);
    },
  };
}

const REPO_FLAG = `${hexToNpub(OWNER)}/${REPO}`;

describe('rig ci serve: flags', () => {
  it('prints usage with --help', async () => {
    const rec = makeIo();
    const code = await runCiServe(['--help'], {
      io: rec.io,
      env: {},
      cwd: '/nonexistent',
    });
    expect(code).toBe(0);
    expect(rec.out.join('\n')).toContain('Usage: rig ci serve');
  });

  it('refuses without --relay or --repo (exit 2, usage on stderr)', async () => {
    const rec = makeIo();
    expect(
      await runCiServe(['--repo', REPO_FLAG], {
        io: rec.io,
        env: {},
        cwd: '/nonexistent',
      })
    ).toBe(2);
    expect(rec.err[0]).toContain('--relay');
    const rec2 = makeIo();
    expect(
      await runCiServe(['--relay', RELAY], {
        io: rec2.io,
        env: {},
        cwd: '/nonexistent',
      })
    ).toBe(2);
    expect(rec2.err[0]).toContain('--repo');
    const rec3 = makeIo();
    expect(
      await runCiServe(
        ['--relay', 'https://not-a-relay', '--repo', REPO_FLAG],
        { io: rec3.io, env: {}, cwd: '/x' }
      )
    ).toBe(2);
    const rec4 = makeIo();
    expect(
      await runCiServe(['--relay', RELAY, '--repo', 'no-slash'], {
        io: rec4.io,
        env: {},
        cwd: '/x',
      })
    ).toBe(2);
    expect(rec4.err[0]).toContain('<owner>/<repo-id>');
    const rec5 = makeIo();
    expect(
      await runCiServe(
        ['--relay', RELAY, '--repo', REPO_FLAG, '--concurrency', '0'],
        { io: rec5.io, env: {}, cwd: '/x' }
      )
    ).toBe(2);
  });

  it('refuses before loading an identity when act is not installed', async () => {
    const rec = makeIo();
    let loaded = 0;
    const code = await runCiServe(['--relay', RELAY, '--repo', REPO_FLAG], {
      io: rec.io,
      env: { PATH: '/nonexistent-bin' },
      cwd: '/nonexistent',
      loadStandalone: async () => {
        loaded += 1;
        throw new Error('must not be reached');
      },
    });
    expect(code).toBe(1);
    expect(loaded).toBe(0);
    expect(rec.err.join('\n')).toMatch(/act executable was not found/);
    expect(rec.err.join('\n')).toContain('Nothing was started or paid');
  });
});

describe('rig ci serve: a serve session', () => {
  it('advertises, runs a push, and stops cleanly on the abort signal (exit 0)', async () => {
    const world = makeServeWorld();
    const running = dispatch(
      [
        'ci',
        'serve',
        '--relay',
        RELAY,
        '--repo',
        REPO_FLAG,
        '--concurrency',
        '2',
        '--timeout',
        '120',
      ],
      world.deps
    );
    await waitFor(
      () => world.publisher.ofKind(CI_ADVERTISEMENT_KIND).length === 1,
      'the advertisement'
    );
    await flush();
    expect(world.rec.out.join('\n')).toContain(
      `Coordinator: ${hexToNpub(COORD)}`
    );
    expect(world.rec.out.join('\n')).toContain(
      `rig ci request ${hexToNpub(COORD)}`
    );
    expect(world.rec.out.join('\n')).toContain('State:');

    world.push(2000);
    await waitFor(
      () => world.publisher.ofKind(CI_WORKFLOW_RESULT_KIND).length === 1,
      'the workflow result'
    );
    expect(world.runner.requests).toHaveLength(1);
    expect(must(world.runner.requests[0]).timeoutMs).toBe(120_000);

    world.abort.abort();
    expect(await running).toBe(0);
    expect(world.stoppedCount()).toBe(1);
    expect(world.rec.err.join('\n')).toContain('stopping');
    expect(world.rec.json).toEqual([]);
  });

  it('emits exactly one JSON document under --json and keeps the coordinator chatter on stderr', async () => {
    const world = makeServeWorld();
    const running = runCiServe(
      ['--relay', RELAY, '--repo', REPO_FLAG, '--json'],
      world.deps
    );
    await waitFor(() => world.rec.json.length === 1, 'the JSON document');
    expect(world.rec.json[0]).toMatchObject({
      command: 'ci serve',
      path: 'standalone',
      coordinator: COORD,
      coordinatorNpub: hexToNpub(COORD),
      relay: RELAY,
      repos: [{ ownerPubkey: OWNER, repoId: REPO }],
      runner: { family: 'act', selectors: ['ubuntu-latest'] },
      concurrency: 1,
      timeoutSeconds: 1800,
      stateDir: world.stateDir,
    });
    expect((world.rec.json[0] as { secretsKey: string }).secretsKey).toMatch(
      /^[0-9a-f]{64}$/
    );
    expect(world.rec.out).toEqual([]);
    world.push(2000);
    await waitFor(
      () => world.publisher.ofKind(CI_WORKFLOW_RESULT_KIND).length === 1,
      'the workflow result'
    );
    world.abort.abort();
    expect(await running).toBe(0);
    expect(world.rec.json).toHaveLength(1);
    expect(world.rec.err.some((l) => l.startsWith('[ci]'))).toBe(true);
  });

  /**
   * A gateway shaped like the sandbox's (and any ar.io node behind a
   * sandboxing redirect): plain `/<txId>` is NOT served, only the store's
   * raw-bytes route `/raw/<txId>` is. Every other host is unreachable, so a
   * run can only succeed if the coordinator reads through the named gateway.
   */
  function rawRouteOnlyGateway(world: ReturnType<typeof makeServeWorld>) {
    const seen: string[] = [];
    world.deps.fetchFn = async (url, init) => {
      seen.push(url);
      const parsed = new URL(url);
      const raw = /^\/raw\/([^/]+)$/.exec(parsed.pathname);
      if (parsed.host !== 'gw.test' || raw === null) {
        return { ok: false, arrayBuffer: async () => new ArrayBuffer(0) };
      }
      return world.gateway.fetchFn(`https://gw.test/${raw[1]}`, init);
    };
    return seen;
  }

  it('reads objects through --gateway (<url>/raw/<txId>) before the shared gateway list (#134)', async () => {
    const world = makeServeWorld();
    const seen = rawRouteOnlyGateway(world);
    const running = runCiServe(
      ['--relay', RELAY, '--repo', REPO_FLAG, '--gateway', 'https://gw.test/'],
      world.deps
    );
    await waitFor(
      () => world.publisher.ofKind(CI_ADVERTISEMENT_KIND).length === 1,
      'the advertisement'
    );
    world.push(2000);
    await waitFor(
      () => world.publisher.ofKind(CI_WORKFLOW_RESULT_KIND).length === 1,
      'the workflow result'
    );
    expect(world.runner.requests).toHaveLength(1);
    // Every object came from the named gateway's raw route; nothing fell
    // through to the shared list.
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((u) => u.startsWith('https://gw.test/raw/'))).toBe(true);
    world.abort.abort();
    expect(await running).toBe(0);
  });

  it('RIG_ARWEAVE_GATEWAY names the gateway when --gateway is absent, for links and reads alike (#134)', async () => {
    const world = makeServeWorld();
    const seen = rawRouteOnlyGateway(world);
    world.deps.env = {
      ...world.deps.env,
      RIG_ARWEAVE_GATEWAY: 'https://gw.test',
    };
    const running = runCiServe(
      ['--relay', RELAY, '--repo', REPO_FLAG, '--json'],
      world.deps
    );
    await waitFor(() => world.rec.json.length === 1, 'the JSON document');
    expect(world.rec.json[0]).toMatchObject({ gateway: 'https://gw.test' });
    world.push(2000);
    await waitFor(
      () => world.publisher.ofKind(CI_WORKFLOW_RESULT_KIND).length === 1,
      'the workflow result'
    );
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((u) => u.startsWith('https://gw.test/raw/'))).toBe(true);
    world.abort.abort();
    expect(await running).toBe(0);
  });

  it('reports a session failure as a CLI error and stops the context', async () => {
    const world = makeServeWorld();
    world.deps.loadStandalone = async () => {
      throw new Error('no identity found');
    };
    const code = await runCiServe(
      ['--relay', RELAY, '--repo', REPO_FLAG, '--json'],
      world.deps
    );
    expect(code).toBe(1);
    expect(world.rec.json[0]).toMatchObject({
      command: 'ci serve',
      error: expect.any(String),
    });
    expect(world.rec.err.join('\n')).toContain('no identity found');
  });
});

describe('rig ci serve: --requester (story 21)', () => {
  it('rejects a malformed requester (exit 2)', async () => {
    const rec = makeIo();
    expect(
      await runCiServe(
        ['--relay', RELAY, '--repo', REPO_FLAG, '--requester', 'nope'],
        { io: rec.io, env: {}, cwd: '/x' }
      )
    ).toBe(2);
    expect(rec.err[0]).toContain('--requester');
  });

  it("serves on an allowlisted stranger's request and reports the requesters", async () => {
    const world = makeServeWorld();
    // Only the STRANGER has asked; without --requester nothing would run.
    const { announce, refsEvent } = world.snapshot(1000);
    world.relay.serve([
      announce,
      refsEvent,
      signed(
        buildCiServiceRequest(repoAddress(OWNER, REPO), COORD, RELAY, 1100),
        STRANGER,
        7
      ),
    ]);
    const running = runCiServe(
      [
        '--relay',
        RELAY,
        '--repo',
        REPO_FLAG,
        '--requester',
        hexToNpub(STRANGER),
        '--json',
      ],
      world.deps
    );
    await waitFor(() => world.rec.json.length === 1, 'the JSON document');
    expect(world.rec.json[0]).toMatchObject({ requesters: [STRANGER] });
    world.push(2000);
    await waitFor(
      () => world.publisher.ofKind(CI_WORKFLOW_RESULT_KIND).length === 1,
      'the workflow result'
    );
    world.abort.abort();
    expect(await running).toBe(0);
  });
});

describe('rig ci serve: the wallet check (story 15)', () => {
  const RATES = { uploadFee: 1000n, uploadPerKib: 10n, eventFee: 5n };

  it('estimates a run as events × eventFee + uploads × the metered upload charge', () => {
    // 4 events × 5 + 1 upload × (1000 + 10 × (⌊sealed(64 KiB)/1024⌋ + 1))
    expect(estimateRunCost({ events: 4, uploads: 1, rates: RATES })).toBe(
      20n +
        1000n +
        10n *
          BigInt(Math.floor((Math.ceil((64 * 1024) / 3) * 4 + 704) / 1024) + 1)
    );
  });

  function recordChannel(
    home: string,
    identity: string,
    deposit: string,
    claimed: string
  ): void {
    const paths = resolveChannelPaths({ TOON_CLIENT_HOME: home });
    const store = new ChannelMapStore(paths);
    store.record({
      channelId: '0x' + '11'.repeat(32),
      peerId: 'nostr-test',
      identity,
      destination: 'g.toon.relay',
      chain: 'evm:31337',
      tokenNetwork: '0x' + '22'.repeat(20),
      context: {
        chainType: 'evm',
        chainId: 31337,
        tokenNetworkAddress: '0x' + '22'.repeat(20),
        tokenAddress: '0x' + '33'.repeat(20),
        recipient: '0x' + '44'.repeat(20),
      },
      depositTotal: deposit,
    });
    mkdirSync(dirname(paths.watermarkPath), { recursive: true });
    writeFileSync(
      paths.watermarkPath,
      JSON.stringify({
        ['0x' + '11'.repeat(32)]: { nonce: 3, cumulativeAmount: claimed },
      })
    );
  }

  it('refuses a run when the best open channel cannot cover it, and allows it when it can', async () => {
    const logs: string[] = [];
    const ctx = makeServeWorld().context;
    const home = tempDir('rig-ci-serve-wallet-');
    const check = makeAffordabilityCheck({
      ctx,
      env: { TOON_CLIENT_HOME: home },
      log: (l) => logs.push(l),
    });
    const estimate = { events: 4, uploads: 1, rates: RATES };
    const cost = estimateRunCost(estimate);

    recordChannel(home, COORD, (cost - 1n).toString(), '0');
    expect(await check(estimate)).toBe(false);
    expect(logs.at(-1)).toMatch(/wallet check: the best open channel has/);

    recordChannel(home, COORD, (cost + 500n).toString(), '500');
    expect(await check(estimate)).toBe(true);

    // Claimed past the deposit → nothing available.
    recordChannel(home, COORD, cost.toString(), (cost + 1n).toString());
    expect(await check(estimate)).toBe(false);
  });

  it('falls back to the wallet before any channel is recorded; unreadable or absent → refuse', async () => {
    const logs: string[] = [];
    const base = makeServeWorld().context;
    const home = tempDir('rig-ci-serve-wallet-');
    const estimate = { events: 4, uploads: 1, rates: RATES };
    const cost = estimateRunCost(estimate);
    const withWallet = (tokens: { symbol?: string; amount: string }[]) =>
      makeAffordabilityCheck({
        ctx: {
          ...base,
          money: {
            openChannel: async () => {
              throw new Error('unused');
            },
            closeChannel: async () => {
              throw new Error('unused');
            },
            settleChannel: async () => {
              throw new Error('unused');
            },
            walletChainBalances: async () => [
              { chain: 'evm', chainKey: 'evm:31337', address: '0x0', tokens },
            ],
          },
        },
        env: { TOON_CLIENT_HOME: home },
        log: (l) => logs.push(l),
      });

    expect(
      await withWallet([{ symbol: 'USDC', amount: (cost - 1n).toString() }])(
        estimate
      )
    ).toBe(false);
    expect(logs.at(-1)).toMatch(/no channel recorded yet/);
    expect(
      await withWallet([{ symbol: 'USDC', amount: cost.toString() }])(estimate)
    ).toBe(true);
    // A non-USDC token never counts.
    expect(
      await withWallet([{ symbol: 'ETH', amount: (cost * 10n).toString() }])(
        estimate
      )
    ).toBe(false);

    // No wallet reader at all → refuse.
    const noMoney = makeAffordabilityCheck({
      ctx: base,
      env: { TOON_CLIENT_HOME: home },
      log: (l) => logs.push(l),
    });
    expect(await noMoney(estimate)).toBe(false);
    expect(logs.at(-1)).toMatch(/no wallet reader/);

    // Unreadable wallet → refuse.
    const broken = makeAffordabilityCheck({
      ctx: {
        ...base,
        money: {
          openChannel: async () => {
            throw new Error('unused');
          },
          closeChannel: async () => {
            throw new Error('unused');
          },
          settleChannel: async () => {
            throw new Error('unused');
          },
          walletChainBalances: async () => {
            throw new Error('rpc down');
          },
        },
      },
      env: { TOON_CLIENT_HOME: home },
      log: (l) => logs.push(l),
    });
    expect(await broken(estimate)).toBe(false);
    expect(logs.at(-1)).toMatch(/wallet unreadable \(rpc down\)/);
  });

  it('is wired into serve by default: an empty home with no wallet reader starts no run and says why on stderr', async () => {
    const world = makeServeWorld();
    delete world.deps.canAfford;
    const running = runCiServe(
      ['--relay', RELAY, '--repo', REPO_FLAG],
      world.deps
    );
    await waitFor(
      () => world.publisher.ofKind(CI_ADVERTISEMENT_KIND).length === 1,
      'the advertisement'
    );
    world.push(2000);
    await waitFor(
      () => world.rec.err.some((l) => l.includes('wallet check')),
      'the wallet refusal'
    );
    await flush();
    expect(world.publisher.ofKind(CI_WORKFLOW_RESULT_KIND)).toHaveLength(0);
    expect(world.runner.requests).toHaveLength(0);
    expect(world.rec.err.some((l) => l.includes('wallet cannot cover'))).toBe(
      true
    );
    world.abort.abort();
    expect(await running).toBe(0);
  });
});
