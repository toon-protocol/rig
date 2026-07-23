// Unit tests for the pure validators `smoke-published.mjs` uses to check the
// PUBLISHED @toon-protocol/rig CLI's real output (issue #1, the
// toon-client#376 lesson: unit tests against source can pass while the
// packaged module graph is broken — only running the actual published
// binary against live networks catches that class of bug).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertUsageOutput,
  parseJsonDocument,
  assertNameStatusJson,
  assertSitePublishEstimateJson,
  devnetMnemonicFromEnv,
} from './smoke-published.mjs';

test('assertUsageOutput passes for a matching Usage banner', () => {
  assert.doesNotThrow(() =>
    assertUsageOutput('Usage: rig name <buy|set|status> <name> [options]\n\n...', 'name')
  );
});

test('assertUsageOutput throws when the banner is missing (broken --help)', () => {
  assert.throws(
    () => assertUsageOutput('command not found: rig', 'name'),
    /Usage: rig name/
  );
});

test('parseJsonDocument parses a single JSON document', () => {
  const json = parseJsonDocument('{"a":1}\n');
  assert.deepEqual(json, { a: 1 });
});

test('parseJsonDocument throws with the offending text on non-JSON stdout', () => {
  assert.throws(
    () => parseJsonDocument('not json at all'),
    /expected exactly one JSON document/
  );
});

test('assertNameStatusJson accepts a well-formed registered-name envelope', () => {
  const json = {
    command: 'name',
    action: 'status',
    name: 'ardrive',
    network: 'mainnet',
    processId: null,
    registered: true,
    identity: { pubkey: 'x', source: 'env', sourceLabel: 'RIG_MNEMONIC env' },
    solanaAddress: 'abc',
    record: {
      antProcessId: 'PID123',
      type: 'permabuy',
      startTimestamp: 1_700_000_000_000,
      endTimestamp: null,
      undernameLimit: 10,
    },
    targets: { '@': { transactionId: 'TX', ttlSeconds: 3600 } },
  };
  assert.doesNotThrow(() => assertNameStatusJson(json, 'ardrive'));
});

test('assertNameStatusJson rejects registered:true with a null record (#376 regression shape)', () => {
  const json = {
    command: 'name',
    action: 'status',
    name: 'ardrive',
    registered: true,
    record: null,
  };
  assert.throws(
    () => assertNameStatusJson(json, 'ardrive'),
    /registered=true but "record" is not an object/
  );
});

test('assertNameStatusJson rejects a name mismatch', () => {
  const json = { command: 'name', action: 'status', name: 'other', registered: false };
  assert.throws(() => assertNameStatusJson(json, 'ardrive'), /expected name/);
});

test('assertSitePublishEstimateJson accepts a pure (unexecuted) estimate', () => {
  const json = {
    command: 'site publish',
    repoId: 'repo-1',
    executed: false,
    estimate: { manifestBytes: 120, reuploadBytes: 0, totalFee: '4200' },
  };
  assert.doesNotThrow(() => assertSitePublishEstimateJson(json, 'repo-1'));
});

test('assertSitePublishEstimateJson rejects executed:true (must never spend without --yes)', () => {
  const json = {
    command: 'site publish',
    repoId: 'repo-1',
    executed: true,
    estimate: { totalFee: '4200' },
  };
  assert.throws(
    () => assertSitePublishEstimateJson(json, 'repo-1'),
    /expected executed:false/
  );
});

test('assertSitePublishEstimateJson rejects a non-numeric fee', () => {
  const json = {
    command: 'site publish',
    repoId: 'repo-1',
    executed: false,
    estimate: { totalFee: 'NaN' },
  };
  assert.throws(
    () => assertSitePublishEstimateJson(json, 'repo-1'),
    /totalFee to be a base-10 integer string/
  );
});

test('devnetMnemonicFromEnv is null when unset or blank', () => {
  assert.equal(devnetMnemonicFromEnv({}), null);
  assert.equal(devnetMnemonicFromEnv({ RIG_SMOKE_DEVNET_MNEMONIC: '   ' }), null);
});

test('devnetMnemonicFromEnv trims a configured secret', () => {
  assert.equal(
    devnetMnemonicFromEnv({ RIG_SMOKE_DEVNET_MNEMONIC: '  test phrase  ' }),
    'test phrase'
  );
});
