/**
 * #125 acceptance check against the TOON sandbox: the whole relay-native CI
 * loop, end to end, on real paid writes — a maintainer identity publishes a
 * repo, a coordinator identity serves it, a push triggers a run through act on
 * Docker, and the maintainer's `rig ci status` reads the kind:9842 back from
 * the relay while the hub's client claim book has grown by the coordinator's
 * writes.
 *
 * Every step drives the REAL code paths (`dispatch` with default deps: the
 * embedded standalone publisher, the real relay, the real store); the only
 * injected seams are the two the sandbox's local gateway needs — an Arweave
 * `fetchFn` that maps `<gateway>/<txId>` to the local gateway's `/raw/<txId>`,
 * and a `resolveSha` that never reaches the public GraphQL index (every SHA a
 * fresh push writes is in the kind:30618 `arweave` map anyway).
 *
 * NETWORK- AND DOCKER-GATED, opt-in:
 *
 *   RIG_CI_SANDBOX=1 npx vitest run src/__integration__/ci-sandbox.integration.test.ts
 *
 * and skipped unless the sandbox's FULL profile answers (`make up` in
 * infra/sandbox — the `payments` profile has no store and no gateway, and
 * `rig push` uploads objects): relay ws://localhost:7100, hub
 * http://localhost:3200, store edge http://localhost:3210, gateway
 * http://localhost:3000. `act` must be on PATH or named by RIG_ACT_BIN, and
 * Docker must be reachable. Override the sandbox checkout (for its committed
 * throwaway keys) with RIG_CI_SANDBOX_DIR; default `../../../infra/sandbox`
 * relative to the rig package (the workspace's sibling checkout).
 *
 * Funding: the sandbox has no faucet, so both identities are funded directly on
 * the local validator — a SOL airdrop plus mock USDC minted with the sandbox's
 * committed mint authority (`keys/toon/usdc-authority.json`), exactly what its
 * own seeder does for the smoke buyer. Zero real funds anywhere.
 */

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  mkdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { dispatch, type DispatchDeps } from '../cli/dispatch.js';
import type { CiDeps } from '../cli/ci.js';
import type { CiStatusReport } from '../cli/ci-status.js';
import {
  addGitRemote,
  initGitRepository,
  writeToonConfig,
} from '../cli/git-config.js';
import type { CliIo } from '../cli/output.js';
import { ActRunner, resolveActBinary } from '../ci/act-runner.js';
import { CI_ADVERTISEMENT_KIND } from '../ci/nip-c1-events.js';
import type { FetchLike } from '../object-fetch.js';
import { queryRelay, type WebSocketLike } from '../remote-state.js';
import { deriveNostrKeyFromMnemonic } from '../standalone/nostr-identity.js';

// ---------------------------------------------------------------------------
// Sandbox facts (infra/sandbox README §3/§4)
// ---------------------------------------------------------------------------

const RELAY_WS = process.env['RIG_CI_SANDBOX_RELAY'] ?? 'ws://localhost:7100';
const HUB = process.env['RIG_CI_SANDBOX_HUB'] ?? 'http://localhost:3200';
const STORE_EDGE =
  process.env['RIG_CI_SANDBOX_STORE_EDGE'] ?? 'http://localhost:3210';
const GATEWAY =
  process.env['RIG_CI_SANDBOX_GATEWAY'] ?? 'http://localhost:3000';
const SOLANA_RPC =
  process.env['RIG_CI_SANDBOX_SOLANA_RPC'] ?? 'http://localhost:8899';
const SOLANA_WS =
  process.env['RIG_CI_SANDBOX_SOLANA_WS'] ?? 'ws://localhost:8900';
const SANDBOX_DIR =
  process.env['RIG_CI_SANDBOX_DIR'] ??
  resolve(import.meta.dirname, '../../../../../infra/sandbox');

/** 10 USDC channel deposit (6 dp) — thousands of 1 µUSDC relay writes. */
const CHANNEL_DEPOSIT = '10000000';
/** What each identity is minted: 100 USDC. */
const MINT_USDC = 100_000_000n;
/** 5 SOL each: rent + fees for the channel open. */
const AIRDROP_LAMPORTS = 5_000_000_000n;

const ENABLED = process.env['RIG_CI_SANDBOX'] === '1';
const RUN_TIMEOUT_MS = 5 * 60_000;

// ---------------------------------------------------------------------------
// Preflight (top-level await: vitest test files are ESM)
// ---------------------------------------------------------------------------

async function httpOk(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function relayAnswers(url: string): Promise<boolean> {
  try {
    const events = await queryRelay(
      url,
      { kinds: [30617], limit: 1 },
      3000,
      (u) => new WebSocket(u) as unknown as WebSocketLike
    );
    return Array.isArray(events);
  } catch {
    return false;
  }
}

function dockerReachable(): boolean {
  try {
    execFileSync('docker', ['info'], { stdio: 'ignore', timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

const preflight: { ok: boolean; why: string[] } = { ok: false, why: [] };
if (ENABLED) {
  const checks: [string, Promise<boolean> | boolean][] = [
    [`relay ${RELAY_WS}`, relayAnswers(RELAY_WS)],
    [`hub ${HUB}/ilp`, httpOk(`${HUB}/ilp`)],
    [
      `store edge ${STORE_EDGE}/ilp (full profile)`,
      httpOk(`${STORE_EDGE}/ilp`),
    ],
    [
      `gateway ${GATEWAY} (full profile)`,
      httpOk(`${GATEWAY}/ar-io/healthcheck`),
    ],
    ['docker', dockerReachable()],
    ['act (PATH or RIG_ACT_BIN)', resolveActBinary(process.env) !== null],
    [
      `sandbox keys at ${SANDBOX_DIR}/keys/toon`,
      existsSync(join(SANDBOX_DIR, 'keys', 'toon', 'usdc-authority.json')),
    ],
  ];
  for (const [what, check] of checks) {
    if (!(await check)) preflight.why.push(what);
  }
  preflight.ok = preflight.why.length === 0;
  if (!preflight.ok) {
    console.warn(
      `ci-sandbox: skipping — not reachable/available: ${preflight.why.join(', ')}`
    );
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

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

/** One rig identity against the sandbox: its own home, phrase, and env. */
interface Identity {
  name: string;
  home: string;
  mnemonic: string;
  pubkey: string;
  env: NodeJS.ProcessEnv;
}

function makeIdentity(name: string, cleanups: string[]): Identity {
  const home = mkdtempSync(join(tmpdir(), `rig-ci-sandbox-${name}-`));
  cleanups.push(home);
  const mnemonic = generateMnemonic(wordlist);
  const { pubkey } = deriveNostrKeyFromMnemonic(mnemonic);
  const env: NodeJS.ProcessEnv = {
    PATH: process.env['PATH'],
    HOME: process.env['HOME'],
    ...(process.env['RIG_ACT_BIN']
      ? { RIG_ACT_BIN: process.env['RIG_ACT_BIN'] }
      : {}),
    TOON_CLIENT_HOME: home,
    RIG_MNEMONIC: mnemonic,
    RIG_STANDALONE: '1',
    TOON_CONNECTOR: HUB,
    TOON_CLIENT_RELAY_URL: RELAY_WS,
    TOON_CLIENT_CHAIN: 'solana',
    TOON_CLIENT_RPC_URL: SOLANA_RPC,
    TOON_CLIENT_STORE_SEAL_TO: STORE_EDGE,
    TOON_CLIENT_DEPOSIT: CHANNEL_DEPOSIT,
    RIG_ARWEAVE_GATEWAY: GATEWAY,
  };
  return { name, home, mnemonic, pubkey, env };
}

/**
 * The local gateway serves bytes at `/raw/<txId>` only (README §4: plain
 * `/<id>` 302s to an unreachable ArNS host), so every Arweave read is
 * rewritten onto it regardless of which public gateway the caller tried.
 */
const gatewayFetch: FetchLike = async (url, init) => {
  const txId = new URL(url).pathname.replace(/^\/(raw\/)?/, '');
  return fetch(`${GATEWAY}/raw/${txId}`, init);
};

function deps(
  id: Identity,
  cwd: string,
  extra: Partial<CiDeps> = {}
): DispatchDeps & CiDeps {
  return {
    io: makeIo().io,
    env: id.env,
    cwd,
    fetchFn: gatewayFetch,
    resolveSha: async () => null,
    ...extra,
  };
}

async function run(
  argv: string[],
  id: Identity,
  cwd: string,
  extra: Partial<CiDeps> = {}
): Promise<{ code: number; rec: Recorder }> {
  const rec = makeIo();
  const code = await dispatch(argv, { ...deps(id, cwd, extra), io: rec.io });
  return { code, rec };
}

function git(cwd: string, args: string[]): string {
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

const WORKFLOW = `name: sandbox-ci
on:
  push:
    branches: ['**']
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo "hello from the TOON sandbox"
      - run: echo "commit=$GITHUB_SHA"
`;

// ---------------------------------------------------------------------------
// Funding on the local validator (mirrors scripts/seed-toon-solana.mjs)
// ---------------------------------------------------------------------------

async function solanaAddressOf(id: Identity): Promise<string> {
  // `rig fund` on a network without a faucet prints the derived addresses —
  // the one place rig exposes the phrase's Solana key without spending.
  const { code, rec } = await run(['fund', 'sol', '--json'], id, id.home);
  expect(code, rec.err.join('\n')).toBe(0);
  const payload = rec.json[0] as { addresses?: { solana: string | null } };
  const address = payload.addresses?.solana;
  if (!address)
    throw new Error(`rig fund derived no Solana address for ${id.name}`);
  return address;
}

async function fundOnValidator(
  targets: { who: string; address: string }[]
): Promise<void> {
  const kit = await import('@solana/kit');
  const rpc = kit.createSolanaRpc(SOLANA_RPC);
  const rpcSubscriptions = kit.createSolanaRpcSubscriptions(SOLANA_WS);
  const airdrop = kit.airdropFactory({ rpc, rpcSubscriptions });
  const sendAndConfirm = kit.sendAndConfirmTransactionFactory({
    rpc,
    rpcSubscriptions,
  });
  const enc = kit.getAddressEncoder();
  const keysDir = join(SANDBOX_DIR, 'keys', 'toon');
  const kp64 = (file: string) =>
    kit.createKeyPairSignerFromBytes(
      new Uint8Array(
        JSON.parse(readFileSync(join(keysDir, file), 'utf8')) as number[]
      )
    );
  const mint = await kp64('usdc-mint.json');
  const authority = await kp64('usdc-authority.json');

  const SYSTEM = kit.address('11111111111111111111111111111111');
  const TOKEN = kit.address('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
  const ATA_PROGRAM = kit.address(
    'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'
  );

  for (const { who, address } of targets) {
    const owner = kit.address(address);
    await airdrop({
      commitment: 'confirmed',
      lamports: kit.lamports(AIRDROP_LAMPORTS),
      recipientAddress: owner,
    });
    const [ata] = await kit.getProgramDerivedAddress({
      programAddress: ATA_PROGRAM,
      seeds: [enc.encode(owner), enc.encode(TOKEN), enc.encode(mint.address)],
    });
    const mintData = Buffer.alloc(9);
    mintData[0] = 7; // MintTo
    mintData.writeBigUInt64LE(MINT_USDC, 1);
    const { value: blockhash } = await rpc.getLatestBlockhash().send();
    const tx = await kit.pipe(
      kit.createTransactionMessage({ version: 0 }),
      (m) => kit.setTransactionMessageFeePayerSigner(authority, m),
      (m) => kit.setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
      (m) =>
        kit.appendTransactionMessageInstructions(
          [
            {
              programAddress: ATA_PROGRAM,
              accounts: [
                {
                  address: authority.address,
                  role: kit.AccountRole.WRITABLE_SIGNER,
                  signer: authority,
                },
                { address: ata, role: kit.AccountRole.WRITABLE },
                { address: owner, role: kit.AccountRole.READONLY },
                { address: mint.address, role: kit.AccountRole.READONLY },
                { address: SYSTEM, role: kit.AccountRole.READONLY },
                { address: TOKEN, role: kit.AccountRole.READONLY },
              ],
              data: new Uint8Array([1]), // CreateIdempotent
            },
            {
              programAddress: TOKEN,
              accounts: [
                { address: mint.address, role: kit.AccountRole.WRITABLE },
                { address: ata, role: kit.AccountRole.WRITABLE },
                {
                  address: authority.address,
                  role: kit.AccountRole.READONLY_SIGNER,
                  signer: authority,
                },
              ],
              data: new Uint8Array(mintData),
            },
          ],
          m
        ),
      (m) => kit.signTransactionMessageWithSigners(m)
    );
    await sendAndConfirm(tx as Parameters<typeof sendAndConfirm>[0], {
      commitment: 'confirmed',
    });
    console.log(`ci-sandbox: funded ${who} (${address}): 5 SOL + 100 USDC`);
  }
}

// ---------------------------------------------------------------------------
// The hub's client claim book (the smoke's `clientBookTotal`)
// ---------------------------------------------------------------------------

interface ClaimRow {
  direction?: string;
  book?: string;
  channel_id?: string;
  cumulative_amount?: string | number;
}

async function hubClientBookTotal(): Promise<bigint> {
  const bearer = readFileSync(
    join(
      SANDBOX_DIR,
      'keys',
      'toon',
      'relay-connector',
      'operator-bearer.token'
    ),
    'utf8'
  ).trim();
  const res = await fetch(`${HUB}/claims`, {
    headers: { authorization: `Bearer ${bearer}` },
  });
  if (!res.ok) throw new Error(`hub GET /claims -> ${res.status}`);
  const rows = (await res.json()) as ClaimRow[];
  const per = new Map<string, bigint>();
  for (const r of rows) {
    if (r.direction !== 'inbound' || r.book !== 'client') continue;
    const a = BigInt(r.cumulative_amount ?? 0);
    const key = r.channel_id ?? '';
    if (a > (per.get(key) ?? 0n)) per.set(key, a);
  }
  return [...per.values()].reduce((s, a) => s + a, 0n);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// The flow
// ---------------------------------------------------------------------------

describe.skipIf(!ENABLED || !preflight.ok)(
  'relay-native CI on the TOON sandbox (#125)',
  () => {
    const cleanups: string[] = [];
    let maintainer: Identity;
    let coordinator: Identity;
    let repoDir: string;
    let stateDir: string;
    const repoId = `ci-sandbox-${Date.now().toString(36)}`;
    const abort = new AbortController();
    let servePromise: Promise<number> | null = null;
    let bookBefore = 0n;

    beforeAll(async () => {
      maintainer = makeIdentity('maintainer', cleanups);
      coordinator = makeIdentity('coordinator', cleanups);

      // Fund both wallets on the local validator.
      await fundOnValidator([
        { who: 'maintainer', address: await solanaAddressOf(maintainer) },
        { who: 'coordinator', address: await solanaAddressOf(coordinator) },
      ]);

      // A tmp repo with one push workflow, owned by the maintainer, origin = the relay.
      repoDir = mkdtempSync(join(tmpdir(), 'rig-ci-sandbox-repo-'));
      cleanups.push(repoDir);
      await initGitRepository(repoDir);
      mkdirSync(join(repoDir, '.github', 'workflows'), { recursive: true });
      writeFileSync(join(repoDir, '.github', 'workflows', 'ci.yml'), WORKFLOW);
      writeFileSync(join(repoDir, 'README.md'), '# ci sandbox\n');
      git(repoDir, ['add', '.']);
      git(repoDir, ['commit', '-q', '-m', 'initial']);
      await writeToonConfig(repoDir, { repoId, owner: maintainer.pubkey });
      await addGitRemote(repoDir, 'origin', RELAY_WS);

      stateDir = mkdtempSync(join(tmpdir(), 'rig-ci-sandbox-state-'));
      cleanups.push(stateDir);
    }, 4 * 60_000);

    afterAll(async () => {
      abort.abort();
      if (servePromise) {
        await Promise.race([servePromise, sleep(30_000)]);
      }
      for (const dir of cleanups.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
      }
    }, 60_000);

    it(
      'publishes the repo, serves it, runs a push, and gates green on the result',
      async () => {
        // 1. The maintainer publishes the repo (objects to the store, 30617/30618 to the relay).
        const push1 = await run(
          ['push', '--yes', '--json'],
          maintainer,
          repoDir
        );
        expect(push1.code, push1.rec.err.join('\n')).toBe(0);

        // 2. The coordinator starts serving the repo (in-process, until aborted).
        const actBin = resolveActBinary(process.env);
        if (!actBin) throw new Error('unreachable: preflight checked act');
        const serveDeps = deps(coordinator, stateDir, {
          runner: new ActRunner({ actBin }),
          stateDir,
          signal: abort.signal,
        });
        servePromise = dispatch(
          [
            'ci',
            'serve',
            '--relay',
            RELAY_WS,
            '--repo',
            `${maintainer.pubkey}/${repoId}`,
            '--gateway',
            GATEWAY,
            '--timeout',
            '600',
            '--concurrency',
            '1',
            '--json',
          ],
          serveDeps
        );

        // Its Advertisement is the liveness signal: wait for it on the relay.
        const deadline = Date.now() + 90_000;
        let advertised = false;
        while (Date.now() < deadline && !advertised) {
          const ads = await queryRelay(
            RELAY_WS,
            {
              kinds: [CI_ADVERTISEMENT_KIND],
              authors: [coordinator.pubkey],
              limit: 1,
            },
            5000,
            (u) => new WebSocket(u) as unknown as WebSocketLike
          );
          advertised = ads.length > 0;
          if (!advertised) await sleep(2000);
        }
        expect(
          advertised,
          'coordinator advertisement (19843) on the relay'
        ).toBe(true);

        bookBefore = await hubClientBookTotal();

        // 3. The maintainer authorizes the coordinator.
        const req = await run(
          ['ci', 'request', coordinator.pubkey, '--yes', '--json'],
          maintainer,
          repoDir
        );
        expect(req.code, req.rec.err.join('\n')).toBe(0);

        // 4. A second push moves main → the coordinator runs ci.yml on the new tip.
        writeFileSync(join(repoDir, 'CHANGE.md'), 'trigger a run\n');
        git(repoDir, ['add', '.']);
        git(repoDir, ['commit', '-q', '-m', 'ci: trigger a sandbox run']);
        const tip = git(repoDir, ['rev-parse', 'HEAD']);
        const push2 = await run(
          ['push', '--yes', '--json'],
          maintainer,
          repoDir
        );
        expect(push2.code, push2.rec.err.join('\n')).toBe(0);

        // 5. Poll the free gate until the run concludes.
        const runDeadline = Date.now() + RUN_TIMEOUT_MS;
        let report: CiStatusReport | null = null;
        let lastCode = -1;
        while (Date.now() < runDeadline) {
          const status = await run(
            ['ci', 'status', tip, '--json'],
            maintainer,
            repoDir
          );
          lastCode = status.code;
          report = (status.rec.json[0] as CiStatusReport | undefined) ?? null;
          if (
            report &&
            report.summary.counted > 0 &&
            report.summary.pending === 0
          )
            break;
          await sleep(5000);
        }
        if (!report) throw new Error('rig ci status emitted no JSON document');
        expect(report.summary, JSON.stringify(report, null, 2)).toMatchObject({
          pending: 0,
          red: 0,
        });
        expect(report.summary.green).toBeGreaterThanOrEqual(1);
        expect(report.ok).toBe(true);
        expect(lastCode).toBe(0);

        const run0 = report.runs.find(
          (r) => r.coordinator === coordinator.pubkey
        );
        expect(run0, 'a run from our coordinator').toBeDefined();
        expect(run0?.status).toBe('concluded');
        expect(run0?.conclusion).toBe('success');
        expect(run0?.reason).toBe('push');
        expect(run0?.workflow.path).toBe('.github/workflows/ci.yml');
        expect(run0?.trust).toBe('maintainer-directed');
        expect(run0?.jobs.map((j) => j.jobId)).toEqual(['build']);
        expect(run0?.jobs[0]?.logsUrl).toMatch(new RegExp(`^${GATEWAY}/raw/`));

        // The full log is really on the store, served by the local gateway.
        const logRes = await fetch(run0?.jobs[0]?.logsUrl ?? '');
        expect(logRes.ok).toBe(true);
        expect(await logRes.text()).toContain('hello from the TOON sandbox');

        // 6. The strict-trust gate agrees, and an impossible requirement fails it.
        const strict = await run(
          [
            'ci',
            'status',
            tip,
            '--json',
            '--require-ci-trust',
            'maintainer-directed',
          ],
          maintainer,
          repoDir
        );
        expect(strict.code).toBe(0);

        // 7. Every coordinator write was a paid claim on the hub's client book.
        const bookAfter = await hubClientBookTotal();
        expect(bookAfter).toBeGreaterThan(bookBefore);
      },
      RUN_TIMEOUT_MS + 3 * 60_000
    );
  }
);
