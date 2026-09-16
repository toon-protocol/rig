/**
 * `rig ci request|stop|trigger|secret` tests (#125): dispatch-level, with the
 * Publisher mocked at the StandaloneContext seam, a hermetic mock relay for
 * the coordinator's kind:19843 Advertisement, and a real tmp git repo for
 * `trigger`'s workflow content hash. Asserts the published NIP-C1 events
 * (kinds, tags, content), the JSON envelopes, the estimate-only and non-TTY
 * refusal paths, npub→hex coordinator parsing, and that a secret update
 * round-trips through NIP-44 to the advertised recipient key.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NostrEvent } from '../remote-state.js';
import type { Publisher } from '../publisher.js';
import type { UnsignedEvent } from '../nip34-events.js';
import { hexToNpub } from '../npub.js';
import {
  buildCiAdvertisement,
  parseCiManualTrigger,
  parseCiSecretUpdate,
  parseCiServiceControl,
} from '../ci/nip-c1-events.js';
import { decryptSecretUpdate, generateSecretsKey } from '../ci/secrets.js';
import type { CliIo } from './output.js';
import { dispatch, type DispatchDeps } from './dispatch.js';
import { writeToonConfig } from './git-config.js';
import { filterEvents, makeMockRelayFactory } from './read-testkit.js';
import type { StandaloneContext } from './standalone-context.js';

const OWNER = 'ab'.repeat(32);
const COORDINATOR = 'cd'.repeat(32);
const RELAY = 'wss://origin-relay.example';
const EVENT_ID = '99'.repeat(32);
const ADV_ID = '77'.repeat(32);
const NOW = 1_800_000_000;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

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

const WORKFLOW_YML =
  'name: ci\non: [push]\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n';

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'toon-rig-ci-'));
  git(['init', '--initial-branch=main'], dir);
  mkdirSync(join(dir, '.github', 'workflows'), { recursive: true });
  writeFileSync(join(dir, '.github', 'workflows', 'ci.yml'), WORKFLOW_YML);
  writeFileSync(join(dir, 'README.md'), '# demo\n');
  git(['add', '.'], dir);
  git(['commit', '-m', 'first'], dir);
  return dir;
}

interface Harness {
  deps: DispatchDeps;
  out: string[];
  err: string[];
  json: unknown[];
  confirms: string[];
}

interface FakeStandalone {
  context: StandaloneContext;
  published: { event: UnsignedEvent; relayUrls: string[] }[];
  stopped: boolean;
}

function makeStandalone(identity = OWNER): FakeStandalone {
  const published: FakeStandalone['published'] = [];
  const publisher: Publisher = {
    getFeeRates: async () => ({ uploadFee: 1000n, eventFee: 3n }),
    uploadGitObject: async () => {
      throw new Error('rig ci verbs never upload objects');
    },
    publishEvent: async (event, relayUrls) => {
      published.push({ event, relayUrls });
      return { eventId: EVENT_ID, feePaid: 3n };
    },
  };
  const fake: FakeStandalone = {
    published,
    stopped: false,
    context: {
      ownerPubkey: identity,
      identitySource: 'dotenv',
      identitySourceLabel: '/repo/.env',
      publisher,
      defaultRelayUrls: [RELAY],
      fetchRemote: async () => {
        throw new Error(
          'rig ci verbs never read remote state through the context'
        );
      },
      stop: async () => {
        fake.stopped = true;
      },
    },
  };
  return fake;
}

function makeHarness(
  cwd: string,
  fake: FakeStandalone,
  options: {
    interactive?: boolean;
    answer?: boolean;
    stdin?: string;
    remoteEvents?: NostrEvent[];
  } = {}
): Harness {
  const out: string[] = [];
  const err: string[] = [];
  const json: unknown[] = [];
  const confirms: string[] = [];
  const io: CliIo = {
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    emitJson: (payload) => json.push(payload),
    isInteractive: options.interactive ?? false,
    confirm: async (question) => {
      confirms.push(question);
      return options.answer ?? false;
    },
  };
  const deps: DispatchDeps & { clock: () => number } = {
    io,
    env: {},
    cwd,
    readStdin: async () => options.stdin ?? '',
    loadStandalone: async () => fake.context,
    probeDaemon: async () => ({
      baseUrl: 'http://127.0.0.1:8787',
      reachable: false,
    }),
    webSocketFactory: makeMockRelayFactory((filter) =>
      filterEvents(options.remoteEvents ?? [], filter)
    ),
    clock: () => NOW,
  };
  return { deps, out, err, json, confirms };
}

/** A live kind:19843 from COORDINATOR with a secrets-key. */
function advertisement(
  secretsPubkey: string,
  overrides: Partial<NostrEvent> = {}
): NostrEvent {
  const unsigned = buildCiAdvertisement(
    {
      version: '4.2.0',
      selectors: ['ubuntu-latest'],
      admission: 'maintainer-request',
      execution: 'request-required',
      billing: 'out-of-band',
      secretsKey: { pubkey: secretsPubkey, inboxRelays: [RELAY] },
      expiresAt: NOW + 600,
    },
    NOW - 60
  );
  return {
    id: ADV_ID,
    pubkey: COORDINATOR,
    sig: 'f0'.repeat(64),
    ...unsigned,
    ...overrides,
  };
}

let repoDir: string;
let fake: FakeStandalone;

beforeEach(async () => {
  repoDir = makeRepo();
  fake = makeStandalone();
  await writeToonConfig(repoDir, { repoId: 'demo', owner: OWNER });
  git(['remote', 'add', 'origin', RELAY], repoDir);
});

afterEach(() => {
  rmSync(repoDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// request / stop
// ---------------------------------------------------------------------------

describe('rig ci request / stop', () => {
  it('publishes a kind:9843 Service Request addressed to the coordinator with the repo a-tag + relay hint', async () => {
    const h = makeHarness(repoDir, fake);
    const code = await dispatch(
      ['ci', 'request', COORDINATOR, '--yes'],
      h.deps
    );
    expect(code).toBe(0);
    expect(fake.published).toHaveLength(1);
    const { event, relayUrls } = fake
      .published[0] as FakeStandalone['published'][0];
    expect(event.kind).toBe(9843);
    expect(event.content).toBe('');
    expect(event.tags).toEqual([
      ['a', `30617:${OWNER}:demo`, RELAY],
      ['p', COORDINATOR],
    ]);
    expect(event.created_at).toBe(NOW);
    expect(relayUrls).toEqual([RELAY]);
    expect(fake.stopped).toBe(true);
    const parsed = parseCiServiceControl({
      ...event,
      id: EVENT_ID,
      pubkey: OWNER,
      sig: '',
    });
    expect(parsed).toMatchObject({
      kind: 'request',
      coordinatorPubkey: COORDINATOR,
    });
    const text = h.out.join('\n');
    expect(text).toContain('kind:9843');
    expect(text).toContain(`Coordinator: ${COORDINATOR}`);
    expect(text).toContain(
      `Published kind:9843 CI service request → ${COORDINATOR.slice(0, 8)}…: ${EVENT_ID}`
    );
  });

  it('stop publishes a kind:9844 and accepts the coordinator as an npub', async () => {
    const h = makeHarness(repoDir, fake);
    const code = await dispatch(
      ['ci', 'stop', hexToNpub(COORDINATOR), '--yes', '--json'],
      h.deps
    );
    expect(code).toBe(0);
    expect(fake.published[0]?.event.kind).toBe(9844);
    expect(fake.published[0]?.event.tags).toContainEqual(['p', COORDINATOR]);
    expect(h.json).toHaveLength(1);
    expect(h.json[0]).toMatchObject({
      command: 'ci stop',
      coordinator: COORDINATOR,
      repoAddr: { ownerPubkey: OWNER, repoId: 'demo' },
      path: 'standalone',
      kind: 9844,
      executed: true,
      feeEstimate: '3',
      result: { eventId: EVENT_ID, feePaid: '3', kind: 9844 },
    });
  });

  it('--json without --yes is a pure estimate (nothing published, exit 0)', async () => {
    const h = makeHarness(repoDir, fake);
    const code = await dispatch(
      ['ci', 'request', COORDINATOR, '--json'],
      h.deps
    );
    expect(code).toBe(0);
    expect(fake.published).toHaveLength(0);
    expect(h.json[0]).toMatchObject({
      command: 'ci request',
      executed: false,
      kind: 9843,
      feeEstimate: '3',
    });
  });

  it('refuses without --yes in a non-interactive session (exit 1, nothing published)', async () => {
    const h = makeHarness(repoDir, fake);
    const code = await dispatch(['ci', 'request', COORDINATOR], h.deps);
    expect(code).toBe(1);
    expect(fake.published).toHaveLength(0);
    expect(h.err.join('\n')).toContain('re-run with --yes');
  });

  it('asks for confirmation interactively and honours a "no"', async () => {
    const h = makeHarness(repoDir, fake, { interactive: true, answer: false });
    const code = await dispatch(['ci', 'request', COORDINATOR], h.deps);
    expect(code).toBe(1);
    expect(h.confirms).toHaveLength(1);
    expect(h.confirms[0]).toContain('3 base units');
    expect(fake.published).toHaveLength(0);
  });

  it('--repo-id/--owner override the git config and --relay bypasses the remote', async () => {
    const h = makeHarness(repoDir, fake);
    const other = 'ef'.repeat(32);
    const code = await dispatch(
      [
        'ci',
        'request',
        COORDINATOR,
        '--yes',
        '--repo-id',
        'other',
        '--owner',
        hexToNpub(other),
        '--relay',
        'wss://adhoc.example',
      ],
      h.deps
    );
    expect(code).toBe(0);
    expect(fake.published[0]?.event.tags[0]).toEqual([
      'a',
      `30617:${other}:other`,
      'wss://adhoc.example',
    ]);
    expect(fake.published[0]?.relayUrls).toEqual(['wss://adhoc.example']);
  });

  it('rejects a malformed coordinator before anything is paid (exit 2 + usage)', async () => {
    const h = makeHarness(repoDir, fake);
    expect(
      await dispatch(['ci', 'request', 'not-a-key', '--yes'], h.deps)
    ).toBe(2);
    expect(await dispatch(['ci', 'request', '--yes'], h.deps)).toBe(2);
    expect(
      await dispatch(['ci', 'stop', COORDINATOR, 'extra', '--yes'], h.deps)
    ).toBe(2);
    expect(h.err.join('\n')).toContain('<coordinator>');
    expect(h.err.join('\n')).toContain('Usage: rig ci request');
    expect(fake.published).toHaveLength(0);
  });

  it('fails with the unconfigured-address error outside a repo without --repo-id', async () => {
    const h = makeHarness('/nonexistent-not-a-repo', fake);
    const code = await dispatch(
      ['ci', 'request', COORDINATOR, '--yes', '--json'],
      h.deps
    );
    expect(code).toBe(1);
    expect(h.json[0]).toMatchObject({
      command: 'ci request',
      error: 'unconfigured_repo_address',
    });
    expect(fake.published).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// trigger
// ---------------------------------------------------------------------------

describe('rig ci trigger', () => {
  it('publishes a kind:9840 with the workflow path + content sha256 at HEAD', async () => {
    const h = makeHarness(repoDir, fake);
    const head = git(['rev-parse', 'HEAD'], repoDir);
    const sha256 = createHash('sha256').update(WORKFLOW_YML).digest('hex');
    const code = await dispatch(
      [
        'ci',
        'trigger',
        COORDINATOR,
        '--workflow',
        './.github/workflows/ci.yml',
        '--ref',
        'refs/heads/main',
        '--yes',
        '--json',
      ],
      h.deps
    );
    expect(code).toBe(0);
    const event = fake.published[0]?.event as UnsignedEvent;
    expect(event.kind).toBe(9840);
    expect(event.content).toBe('');
    expect(event.tags).toEqual([
      ['p', COORDINATOR],
      ['a', `30617:${OWNER}:demo`],
      ['c', head],
      ['w', '.github/workflows/ci.yml', sha256],
      ['r', 'refs/heads/main'],
    ]);
    const parsed = parseCiManualTrigger(
      { ...event, id: EVENT_ID, pubkey: OWNER, sig: '' },
      COORDINATOR
    );
    expect(parsed?.trigger).toEqual({
      repoAddr: `30617:${OWNER}:demo`,
      commit: head,
      workflow: { path: '.github/workflows/ci.yml', sha256 },
      ref: 'refs/heads/main',
    });
    expect(h.json[0]).toMatchObject({
      command: 'ci trigger',
      kind: 9840,
      executed: true,
      commit: head,
      workflow: { path: '.github/workflows/ci.yml', sha256 },
      ref: 'refs/heads/main',
    });
  });

  it('--commit resolves any local revision and hashes the file AT that commit', async () => {
    const first = git(['rev-parse', 'HEAD'], repoDir);
    writeFileSync(
      join(repoDir, '.github', 'workflows', 'ci.yml'),
      WORKFLOW_YML + '# changed\n'
    );
    git(['commit', '-am', 'second'], repoDir);
    const h = makeHarness(repoDir, fake);
    const code = await dispatch(
      [
        'ci',
        'trigger',
        COORDINATOR,
        '--workflow',
        '.github/workflows/ci.yml',
        '--commit',
        'HEAD~1',
        '--yes',
      ],
      h.deps
    );
    expect(code).toBe(0);
    const event = fake.published[0]?.event as UnsignedEvent;
    expect(event.tags).toContainEqual(['c', first]);
    expect(event.tags).toContainEqual([
      'w',
      '.github/workflows/ci.yml',
      createHash('sha256').update(WORKFLOW_YML).digest('hex'),
    ]);
    expect(event.tags.some((t) => t[0] === 'r')).toBe(false);
  });

  it('fails before paying when the workflow does not exist at the commit', async () => {
    const h = makeHarness(repoDir, fake);
    const code = await dispatch(
      [
        'ci',
        'trigger',
        COORDINATOR,
        '--workflow',
        '.github/workflows/nope.yml',
        '--yes',
        '--json',
      ],
      h.deps
    );
    expect(code).toBe(1);
    expect(fake.published).toHaveLength(0);
    expect(h.json[0]).toMatchObject({ command: 'ci trigger', error: 'error' });
    expect(String((h.json[0] as { detail: string }).detail)).toContain(
      'nope.yml'
    );
  });

  it('requires --workflow and a well-formed --ref (exit 2, nothing published)', async () => {
    const h = makeHarness(repoDir, fake);
    expect(
      await dispatch(['ci', 'trigger', COORDINATOR, '--yes'], h.deps)
    ).toBe(2);
    expect(
      await dispatch(
        [
          'ci',
          'trigger',
          COORDINATOR,
          '--workflow',
          'x.yml',
          '--ref',
          'main',
          '--yes',
        ],
        h.deps
      )
    ).toBe(2);
    expect(
      await dispatch(
        ['ci', 'trigger', COORDINATOR, '--workflow', '../x.yml', '--yes'],
        h.deps
      )
    ).toBe(2);
    expect(fake.published).toHaveLength(0);
    expect(h.err.join('\n')).toContain('--workflow');
  });
});

// ---------------------------------------------------------------------------
// secret set / remove
// ---------------------------------------------------------------------------

describe('rig ci secret', () => {
  it('set publishes ONE kind:29846 encrypted to the advertised secrets-key that decrypts to the update', async () => {
    const recipient = generateSecretsKey();
    const h = makeHarness(repoDir, fake, {
      remoteEvents: [advertisement(recipient.pubkey)],
    });
    const code = await dispatch(
      [
        'ci',
        'secret',
        'set',
        COORDINATOR,
        'DEPLOY_TOKEN=s3cret',
        'OTHER=two',
        '--yes',
        '--json',
      ],
      h.deps
    );
    expect(code).toBe(0);
    expect(fake.published).toHaveLength(1);
    const event = fake.published[0]?.event as UnsignedEvent;
    expect(event.kind).toBe(29846);
    expect(event.created_at).toBe(NOW);
    const parsed = parseCiSecretUpdate({
      ...event,
      id: EVENT_ID,
      pubkey: OWNER,
      sig: '',
    });
    expect(parsed).toMatchObject({
      repoAddr: `30617:${OWNER}:demo`,
      coordinatorPubkey: COORDINATOR,
      advertisementId: ADV_ID,
      recipientPubkey: recipient.pubkey,
    });
    expect(event.tags).toContainEqual(['e', ADV_ID, RELAY, 'secrets-key']);
    expect(event.tags).toContainEqual(['encryption', 'nip44-v2']);
    // Round trip with the coordinator's recipient key + the fresh sender key.
    const plain = decryptSecretUpdate(
      event.content,
      recipient.secretKey,
      parsed?.senderPubkey as string
    );
    expect(plain).toEqual({
      author: OWNER,
      created_at: NOW,
      set: { DEPLOY_TOKEN: 's3cret', OTHER: 'two' },
      remove: [],
    });
    // Never echo values: not in the envelope, not on either stream.
    const everything =
      JSON.stringify(h.json) + h.out.join('\n') + h.err.join('\n');
    expect(everything).not.toContain('s3cret');
    expect(everything).not.toContain('two"');
    expect(h.json[0]).toMatchObject({
      command: 'ci secret set',
      kind: 29846,
      executed: true,
      names: ['DEPLOY_TOKEN', 'OTHER'],
      operation: 'set',
    });
  });

  it('a bare NAME reads its value from stdin; remove publishes tombstones', async () => {
    const recipient = generateSecretsKey();
    const h = makeHarness(repoDir, fake, {
      remoteEvents: [advertisement(recipient.pubkey)],
      stdin: 'from-stdin\n',
    });
    expect(
      await dispatch(
        ['ci', 'secret', 'set', COORDINATOR, 'NPM_TOKEN', '--yes'],
        h.deps
      )
    ).toBe(0);
    const setEvent = fake.published[0]?.event as UnsignedEvent;
    const setSender = parseCiSecretUpdate({
      ...setEvent,
      id: EVENT_ID,
      pubkey: OWNER,
      sig: '',
    })?.senderPubkey as string;
    expect(
      decryptSecretUpdate(setEvent.content, recipient.secretKey, setSender).set
    ).toEqual({
      NPM_TOKEN: 'from-stdin',
    });

    expect(
      await dispatch(
        ['ci', 'secret', 'remove', COORDINATOR, 'NPM_TOKEN', 'OLD', '--yes'],
        h.deps
      )
    ).toBe(0);
    const rmEvent = fake.published[1]?.event as UnsignedEvent;
    const rmSender = parseCiSecretUpdate({
      ...rmEvent,
      id: EVENT_ID,
      pubkey: OWNER,
      sig: '',
    })?.senderPubkey as string;
    expect(
      decryptSecretUpdate(rmEvent.content, recipient.secretKey, rmSender)
    ).toEqual({
      author: OWNER,
      created_at: NOW,
      set: {},
      remove: ['NPM_TOKEN', 'OLD'],
    });
    expect(setSender).not.toBe(rmSender); // a fresh sender key per submission
  });

  it('scopes the update to the SIGNER’s repository perspective (NIP-C1: a.pubkey == signer)', async () => {
    const maintainer = 'ef'.repeat(32);
    const recipient = generateSecretsKey();
    const asMaintainer = makeStandalone(maintainer);
    const h = makeHarness(repoDir, asMaintainer, {
      remoteEvents: [advertisement(recipient.pubkey)],
    });
    expect(
      await dispatch(
        ['ci', 'secret', 'set', COORDINATOR, 'A=1', '--yes'],
        h.deps
      )
    ).toBe(0);
    const event = asMaintainer.published[0]?.event as UnsignedEvent;
    expect(event.tags[0]).toEqual(['a', `30617:${maintainer}:demo`]);
    expect(
      parseCiSecretUpdate({
        ...event,
        id: EVENT_ID,
        pubkey: maintainer,
        sig: '',
      })
    ).not.toBeNull();
  });

  it('refuses before paying when the coordinator has no live advertisement or no secrets-key', async () => {
    const recipient = generateSecretsKey();
    // No advertisement at all.
    let h = makeHarness(repoDir, fake, { remoteEvents: [] });
    expect(
      await dispatch(
        ['ci', 'secret', 'set', COORDINATOR, 'A=1', '--yes', '--json'],
        h.deps
      )
    ).toBe(1);
    expect(String((h.json[0] as { detail: string }).detail)).toContain(
      'no Coordinator Advertisement'
    );
    // Expired.
    h = makeHarness(repoDir, fake, {
      remoteEvents: [
        advertisement(recipient.pubkey, {
          tags: advertisement(recipient.pubkey).tags.map((t) =>
            t[0] === 'expiration' ? ['expiration', String(NOW - 1)] : t
          ),
          created_at: NOW - 1000,
        }),
      ],
    });
    expect(
      await dispatch(
        ['ci', 'secret', 'set', COORDINATOR, 'A=1', '--yes', '--json'],
        h.deps
      )
    ).toBe(1);
    expect(String((h.json[0] as { detail: string }).detail)).toContain(
      'expired'
    );
    // Live but without a secrets-key.
    const noKey = advertisement(recipient.pubkey);
    noKey.tags = noKey.tags.filter((t) => t[0] !== 'secrets-key');
    h = makeHarness(repoDir, fake, { remoteEvents: [noKey] });
    expect(
      await dispatch(
        ['ci', 'secret', 'set', COORDINATOR, 'A=1', '--yes', '--json'],
        h.deps
      )
    ).toBe(1);
    expect(String((h.json[0] as { detail: string }).detail)).toContain(
      'no secrets-key'
    );
    expect(fake.published).toHaveLength(0);
  });

  it('validates names (regex, reserved, duplicates, empty values) before paying (exit 2)', async () => {
    const h = makeHarness(repoDir, fake, {
      remoteEvents: [advertisement(generateSecretsKey().pubkey)],
    });
    expect(
      await dispatch(
        ['ci', 'secret', 'set', COORDINATOR, 'lower=1', '--yes'],
        h.deps
      )
    ).toBe(2);
    expect(
      await dispatch(
        [
          'ci',
          'secret',
          'set',
          COORDINATOR,
          'WORKFLOW_SECRETS_DECRYPTION_BUNKER=x',
          '--yes',
        ],
        h.deps
      )
    ).toBe(2);
    expect(
      await dispatch(
        ['ci', 'secret', 'set', COORDINATOR, 'A=1', 'A=2', '--yes'],
        h.deps
      )
    ).toBe(2);
    expect(
      await dispatch(
        ['ci', 'secret', 'set', COORDINATOR, 'A=', '--yes'],
        h.deps
      )
    ).toBe(2);
    expect(
      await dispatch(
        ['ci', 'secret', 'set', COORDINATOR, 'A', 'B', '--yes'],
        h.deps
      )
    ).toBe(2);
    expect(
      await dispatch(
        ['ci', 'secret', 'remove', COORDINATOR, 'A=1', '--yes'],
        h.deps
      )
    ).toBe(2);
    expect(
      await dispatch(['ci', 'secret', 'set', COORDINATOR, '--yes'], h.deps)
    ).toBe(2);
    expect(
      await dispatch(['ci', 'secret', 'frob', COORDINATOR, '--yes'], h.deps)
    ).toBe(2);
    expect(await dispatch(['ci', 'secret'], h.deps)).toBe(2);
    expect(fake.published).toHaveLength(0);
    const err = h.err.join('\n');
    expect(err).toContain('invalid secret name');
    expect(err).toContain('reserved');
    expect(err).toContain('more than once');
  });

  it('a bare NAME with empty stdin is a usage error (exit 2)', async () => {
    const h = makeHarness(repoDir, fake, {
      remoteEvents: [advertisement(generateSecretsKey().pubkey)],
      stdin: '',
    });
    expect(
      await dispatch(['ci', 'secret', 'set', COORDINATOR, 'A', '--yes'], h.deps)
    ).toBe(2);
    expect(h.err.join('\n')).toContain('no value on stdin');
    expect(fake.published).toHaveLength(0);
  });

  it('rejects a value over 16384 bytes — on argv or stdin — before paying (exit 2)', async () => {
    const big = 'x'.repeat(16385);
    let h = makeHarness(repoDir, fake, {
      remoteEvents: [advertisement(generateSecretsKey().pubkey)],
    });
    expect(
      await dispatch(
        ['ci', 'secret', 'set', COORDINATOR, `A=${big}`, '--yes'],
        h.deps
      )
    ).toBe(2);
    expect(h.err.join('\n')).toContain('exceeds 16384 bytes');
    expect(h.err.join('\n')).not.toContain(big);

    h = makeHarness(repoDir, fake, {
      remoteEvents: [advertisement(generateSecretsKey().pubkey)],
      stdin: `${big}\n`,
    });
    expect(
      await dispatch(['ci', 'secret', 'set', COORDINATOR, 'A', '--yes'], h.deps)
    ).toBe(2);
    expect(h.err.join('\n')).toContain('exceeds 16384 bytes');

    // Exactly the limit is fine (the 16385th byte is the trailing newline, stripped).
    h = makeHarness(repoDir, fake, {
      remoteEvents: [advertisement(generateSecretsKey().pubkey)],
      stdin: `${'y'.repeat(16384)}\n`,
    });
    expect(
      await dispatch(['ci', 'secret', 'set', COORDINATOR, 'A', '--yes'], h.deps)
    ).toBe(0);
    expect(fake.published).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// dispatch / help
// ---------------------------------------------------------------------------

describe('rig ci dispatch', () => {
  it('prints usage for --help and each verb’s --help; unknown verbs exit 2', async () => {
    const h = makeHarness(repoDir, fake);
    expect(await dispatch(['ci', '--help'], h.deps)).toBe(0);
    expect(h.out.join('\n')).toContain(
      'Usage: rig ci <request|stop|trigger|secret|status|serve>'
    );
    expect(h.out.join('\n')).toContain('Usage: rig ci status');
    for (const verb of ['request', 'stop', 'trigger', 'status']) {
      const hh = makeHarness(repoDir, fake);
      expect(await dispatch(['ci', verb, '--help'], hh.deps)).toBe(0);
      expect(hh.out.join('\n')).toContain(`Usage: rig ci ${verb}`);
    }
    const hs = makeHarness(repoDir, fake);
    expect(await dispatch(['ci', 'secret', '--help'], hs.deps)).toBe(0);
    expect(hs.out.join('\n')).toContain('Usage: rig ci secret set');
    const hu = makeHarness(repoDir, fake);
    expect(await dispatch(['ci', 'frobnicate'], hu.deps)).toBe(2);
    expect(await dispatch(['ci'], hu.deps)).toBe(2);
    expect(hu.err.join('\n')).toContain(
      'unknown rig ci subcommand: frobnicate'
    );
    expect(fake.published).toHaveLength(0);
  });
});
