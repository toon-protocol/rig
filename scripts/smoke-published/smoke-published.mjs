#!/usr/bin/env node
/**
 * e2e smoke test for the PUBLISHED `@toon-protocol/rig` npm package against
 * live networks (issue #1, the toon-client#376 lesson): the #376 `SolanaSigner`
 * guard crash shipped green through unit tests and was only caught by
 * smoke-testing the published npm artifact — the failure lived in the
 * packaged module graph, not in any unit. `rig name` / `rig site` have the
 * same shape today, so this installs `@toon-protocol/rig@latest` in a clean
 * env and drives the REAL CLI binary against real networks.
 *
 * Free paths (always run, no spend):
 *   - `rig name --help` / `rig site --help`
 *   - `rig name status <name> --json` against mainnet ar.io (the #376 pin)
 *   - `rig site publish --json --force-reupload` with no `--yes`: a pure
 *     estimate against a real devnet relay (nothing uploaded or paid)
 *
 * Paid path (opt-in, devnet-gated): behind RIG_SMOKE_DEVNET_MNEMONIC. Per the
 * issue's triage, provisioning a funded devnet identity + CI secret is a
 * human follow-up — this stays a stub (never spends) until that lands.
 *
 * Usage: RIG_BIN=rig node scripts/smoke-published/smoke-published.mjs
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

// The canonical all-zero-entropy BIP-39 test mnemonic used throughout this
// repo's unit tests (see e.g. packages/rig/src/cli/fund.test.ts). Identity
// resolution is required even for FREE reads (status/estimate derive the
// Solana pubkey), but no funds are ever needed for a free path.
export const TEST_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

export const DEFAULT_ARNS_NAME = 'ardrive';
export const DEFAULT_DEVNET_RELAY = 'wss://relay-ws.devnet.toonprotocol.dev';

// ---------------------------------------------------------------------------
// Pure validators (unit-tested in smoke-published.test.mjs)
// ---------------------------------------------------------------------------

/** Assert `--help` output for `<commandLabel>` still carries its Usage banner. */
export function assertUsageOutput(output, commandLabel) {
  const expected = `Usage: rig ${commandLabel}`;
  if (typeof output !== 'string' || !output.includes(expected)) {
    throw new Error(
      `expected \`rig ${commandLabel} --help\` output to contain ${JSON.stringify(expected)}, got: ${JSON.stringify((output ?? '').slice(0, 200))}`
    );
  }
}

/** Parse stdout as exactly one JSON document (the strict `--json` contract). */
export function parseJsonDocument(raw) {
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  try {
    return JSON.parse(trimmed);
  } catch {
    throw new Error(
      `expected exactly one JSON document on stdout, got non-JSON: ${JSON.stringify(trimmed.slice(0, 200))}`
    );
  }
}

/**
 * Assert the `rig name status --json` envelope shape (this is the #376
 * regression pin: a registered name must always carry a non-null `record`).
 */
export function assertNameStatusJson(json, expectedName) {
  if (json === null || typeof json !== 'object') {
    throw new Error('name status --json: expected an object');
  }
  if (json.command !== 'name' || json.action !== 'status') {
    throw new Error(
      `name status --json: expected command:"name" action:"status", got ${JSON.stringify({ command: json.command, action: json.action })}`
    );
  }
  if (json.name !== expectedName) {
    throw new Error(
      `name status --json: expected name ${JSON.stringify(expectedName)}, got ${JSON.stringify(json.name)}`
    );
  }
  if (typeof json.registered !== 'boolean') {
    throw new Error('name status --json: expected a boolean "registered"');
  }
  if (json.registered) {
    if (json.record === null || typeof json.record !== 'object') {
      throw new Error(
        'name status --json: registered=true but "record" is not an object (the #376 regression shape)'
      );
    }
    if (typeof json.record.antProcessId !== 'string') {
      throw new Error(
        'name status --json: registered name is missing record.antProcessId'
      );
    }
  }
  return json;
}

/**
 * Assert a `rig site publish --json` estimate envelope (no `--yes`): it must
 * never report `executed:true` — that would mean it spent without consent.
 */
export function assertSitePublishEstimateJson(json, expectedRepoId) {
  if (json === null || typeof json !== 'object') {
    throw new Error('site publish --json: expected an object');
  }
  if (json.command !== 'site publish') {
    throw new Error(
      `site publish --json: expected command:"site publish", got ${JSON.stringify(json.command)}`
    );
  }
  if (json.executed !== false) {
    throw new Error(
      `site publish --json (no --yes): expected executed:false (a pure estimate must never spend), got ${JSON.stringify(json.executed)}`
    );
  }
  if (json.repoId !== expectedRepoId) {
    throw new Error(
      `site publish --json: expected repoId ${JSON.stringify(expectedRepoId)}, got ${JSON.stringify(json.repoId)}`
    );
  }
  const fee = json.estimate?.totalFee;
  if (typeof fee !== 'string' || !/^\d+$/.test(fee)) {
    throw new Error(
      `site publish --json: expected estimate.totalFee to be a base-10 integer string, got ${JSON.stringify(fee)}`
    );
  }
  return json;
}

/** The opt-in devnet paid-round-trip secret, trimmed; `null` when unset/blank. */
export function devnetMnemonicFromEnv(env) {
  const value = env?.RIG_SMOKE_DEVNET_MNEMONIC;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

// ---------------------------------------------------------------------------
// CLI orchestration
// ---------------------------------------------------------------------------

function runRig(rigBin, args, opts = {}) {
  return execFileSync(rigBin, args, { encoding: 'utf8', ...opts });
}

/** Run `fn`, recording an ok/FAIL result under `name` and logging either way. */
function recordCheck(log, results, name, fn) {
  try {
    fn();
    log(`ok - ${name}`);
    results.push({ name, ok: true });
  } catch (err) {
    log(`FAIL - ${name}: ${err.message}`);
    results.push({ name, ok: false, error: err.message });
  }
}

function checkHelp(rigBin, log, results, subcommand) {
  recordCheck(log, results, `rig ${subcommand} --help`, () => {
    const out = runRig(rigBin, [subcommand, '--help']);
    assertUsageOutput(out, subcommand);
  });
}

function checkNameStatus(rigBin, log, results, arnsName, identityEnv) {
  const name = `rig name status ${arnsName} --json (mainnet, #376 pin)`;
  recordCheck(log, results, name, () => {
    const out = runRig(rigBin, ['name', 'status', arnsName, '--json'], {
      env: identityEnv,
    });
    assertNameStatusJson(parseJsonDocument(out), arnsName);
  });
}

/** A throwaway git repo with one file, ready for `rig init`. */
function makeThrowawayRepo(identityEnv) {
  const dir = mkdtempSync(join(tmpdir(), 'rig-smoke-site-'));
  const gitEnv = {
    ...identityEnv,
    GIT_AUTHOR_NAME: 'rig-smoke',
    GIT_AUTHOR_EMAIL: 'smoke@toonprotocol.dev',
    GIT_COMMITTER_NAME: 'rig-smoke',
    GIT_COMMITTER_EMAIL: 'smoke@toonprotocol.dev',
  };
  execFileSync('git', ['init', '-q'], { cwd: dir, env: gitEnv });
  writeFileSync(
    join(dir, 'index.html'),
    '<!doctype html><title>rig smoke</title>\n'
  );
  execFileSync('git', ['add', '-A'], { cwd: dir, env: gitEnv });
  execFileSync('git', ['commit', '-q', '-m', 'rig smoke-published'], {
    cwd: dir,
    env: gitEnv,
  });
  return dir;
}

function checkSitePublishEstimate(rigBin, log, results, relayUrl, identityEnv) {
  const name = 'rig site publish --json --force-reupload (no --yes, no spend)';
  recordCheck(log, results, name, () => {
    const repoId = `rig-smoke-${randomUUID()}`;
    const dir = makeThrowawayRepo(identityEnv);
    const cwdEnv = { cwd: dir, env: identityEnv };
    runRig(rigBin, ['init', '--repo-id', repoId], cwdEnv);
    runRig(rigBin, ['remote', 'add', 'origin', relayUrl], cwdEnv);
    const out = runRig(
      rigBin,
      ['site', 'publish', '--json', '--force-reupload'],
      cwdEnv
    );
    assertSitePublishEstimateJson(parseJsonDocument(out), repoId);
  });
}

/**
 * Opt-in, devnet-gated paid round-trip (`rig push` + `rig site`). Per the
 * issue #1 triage, provisioning a funded devnet identity + wiring the real
 * round-trip is a human follow-up — this is a deliberate stub that never
 * spends, so it stays safe to run before that lands.
 */
function runDevnetPaidRoundTrip(env, log) {
  const mnemonic = devnetMnemonicFromEnv(env);
  if (!mnemonic) {
    log(
      'skip - paid devnet round-trip: RIG_SMOKE_DEVNET_MNEMONIC not set ' +
        '(human-provisioned secret; see issue #1)'
    );
    return;
  }
  log(
    'skip - paid devnet round-trip: RIG_SMOKE_DEVNET_MNEMONIC is set, but the ' +
      'round-trip itself is not yet wired (stub — see issue #1 triage: ' +
      'provisioning + wiring real spend is an explicit human follow-up)'
  );
}

export function main(env = process.env, log = console.log) {
  const rigBin = env.RIG_BIN ?? 'rig';
  const arnsName = env.SMOKE_ARNS_NAME ?? DEFAULT_ARNS_NAME;
  const relayUrl = env.SMOKE_DEVNET_RELAY ?? DEFAULT_DEVNET_RELAY;
  const identityEnv = { ...env, RIG_MNEMONIC: TEST_MNEMONIC };

  const results = [];
  checkHelp(rigBin, log, results, 'name');
  checkHelp(rigBin, log, results, 'site');
  checkNameStatus(rigBin, log, results, arnsName, identityEnv);
  checkSitePublishEstimate(rigBin, log, results, relayUrl, identityEnv);
  runDevnetPaidRoundTrip(env, log);

  const failed = results.filter((r) => !r.ok);
  if (failed.length > 0) {
    log(`${failed.length}/${results.length} smoke checks FAILED`);
    return 1;
  }
  log(`${results.length}/${results.length} smoke checks passed`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main());
}
