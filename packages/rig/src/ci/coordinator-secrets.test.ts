/**
 * Secrets at the coordinator (#131, on top of the push/stranger-PR evidence
 * in coordinator.test.ts › secrets): every run a maintainer causes — a
 * manual trigger, a maintainer's kind:1618 pull request — receives the
 * inventory while a stranger's 1618 gets an empty set; a 29846 for a repo
 * the coordinator does not serve is ignored; a remove survives a restart
 * (the tombstone is what is persisted); and an injected value is redacted
 * from the uploaded job log and the 9841 log tail — it never reaches a
 * published event, the store, or the coordinator's own log.
 */

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { NostrEvent } from '../remote-state.js';
import type { CoordinatorHandle } from './coordinator.js';
import {
  ADDR,
  COORD,
  MAINT,
  OWNER,
  RELAY,
  REPO,
  STRANGER,
  WORKFLOW,
  cleanupWorlds,
  git,
  jobEvents,
  makeWorld,
  must,
  push,
  resetEventIds,
  serviceRequest,
  signed,
  type World,
} from './coordinator-testkit.js';
import {
  buildCiManualTrigger,
  buildCiSecretUpdate,
  repoAddress,
} from './nip-c1-events.js';
import { FakeRunner, defaultFakeRunResult } from './runner.js';
import { encryptSecretUpdate, generateSecretsKey } from './secrets.js';
import { sha256Hex } from './workflows.js';

beforeEach(() => resetEventIds());
afterEach(() => cleanupWorlds());

/** A kind:29846 from `author`, NIP-44 encrypted to the coordinator's CURRENT secrets-key. */
function secretUpdate(
  world: World,
  handle: CoordinatorHandle,
  author: string,
  set: Record<string, string>,
  remove: string[] = [],
  repoId = REPO
): NostrEvent {
  const sender = generateSecretsKey();
  const created_at = world.clock.now();
  const ciphertext = encryptSecretUpdate(
    { author, created_at, set, remove },
    sender.secretKey,
    handle.secretsKeyPubkey
  );
  return signed(
    buildCiSecretUpdate({
      repoAddr: repoAddress(author, repoId),
      coordinatorPubkey: COORD,
      advertisementId: handle.advertisementId as string,
      advertisementRelayHint: RELAY,
      senderPubkey: sender.pubkey,
      recipientPubkey: handle.secretsKeyPubkey,
      ciphertext,
      createdAt: created_at,
    }),
    author
  );
}

/** A NIP-34 kind:1618 Pull Request from `author` whose tip is `tip`. */
function pullRequest(
  author: string,
  tip: string,
  createdAt: number
): NostrEvent {
  return signed(
    {
      kind: 1618,
      content: 'please merge',
      created_at: createdAt,
      tags: [
        ['a', ADDR],
        ['p', OWNER],
        ['subject', 'a feature'],
        ['c', tip],
      ],
    },
    author
  );
}

function everythingPublished(world: World): string {
  return (
    JSON.stringify(world.publisher.publishedEvents) +
    world.publisher.uploadedBlobs
      .map((b) => Buffer.from(b.body).toString('utf-8'))
      .join('\n') +
    world.logs.join('\n')
  );
}

describe('who receives the inventory', () => {
  it('a manual trigger and a maintainer pull request receive it; a stranger pull request gets an empty set', async () => {
    const world = makeWorld();
    const { announce, refsEvent } = world.snapshot(1000);
    world.relay.serve([announce, refsEvent, serviceRequest(MAINT, 1100)]);
    const handle = await world.start();

    world.relay.push(
      secretUpdate(world, handle, MAINT, { DEPLOY_TOKEN: 'hunter2' })
    );
    await handle.idle();
    expect(world.logs.some((l) => l.includes('secrets updated'))).toBe(true);
    const tip = git(['rev-parse', 'HEAD'], world.srcDir);
    const now = world.clock.now();

    // Manual trigger from a maintainer.
    world.relay.push(
      signed(
        buildCiManualTrigger(
          COORD,
          {
            repoAddr: ADDR,
            commit: tip,
            workflow: {
              path: '.github/workflows/ci.yml',
              sha256: sha256Hex(WORKFLOW),
            },
            ref: 'refs/heads/main',
          },
          now + 1
        ),
        MAINT
      )
    );
    await handle.idle();
    const manualRun = must(world.runner.requests[0], 'the manual run');
    expect(manualRun.trigger.reason).toBe('manual');
    expect(manualRun.secrets).toEqual({ DEPLOY_TOKEN: 'hunter2' });

    // Pull request from a maintainer.
    world.relay.push(pullRequest(MAINT, tip, now + 2));
    await handle.idle();
    const maintainerPr = must(world.runner.requests[1], 'the maintainer PR');
    expect(maintainerPr.trigger).toMatchObject({
      reason: 'pull_request',
      pr: { prAuthor: MAINT, prKind: 1618 },
    });
    expect(maintainerPr.secrets).toEqual({ DEPLOY_TOKEN: 'hunter2' });

    // Pull request from the repo owner (authorized without being listed).
    world.relay.push(pullRequest(OWNER, tip, now + 3));
    await handle.idle();
    expect(must(world.runner.requests[2], 'the owner PR').secrets).toEqual({
      DEPLOY_TOKEN: 'hunter2',
    });

    // Pull request from a stranger: runs, with nothing injected.
    world.relay.push(pullRequest(STRANGER, tip, now + 4));
    await handle.idle();
    const strangerPr = must(world.runner.requests[3], 'the stranger PR');
    expect(strangerPr.trigger).toMatchObject({
      reason: 'pull_request',
      pr: { prAuthor: STRANGER, prKind: 1618 },
    });
    expect(strangerPr.secrets).toEqual({});
    expect(world.runner.requests).toHaveLength(4);

    // The value is never in a published event, an upload, or the log.
    expect(everythingPublished(world)).not.toContain('hunter2');
    await handle.stop();
  });
});

describe('which updates are ignored', () => {
  it('ignores a 29846 whose a names a repo the coordinator does not serve, and keeps applying updates for the served one', async () => {
    const world = makeWorld();
    const { announce, refsEvent } = world.snapshot(1000);
    world.relay.serve([announce, refsEvent, serviceRequest(MAINT, 1100)]);
    const handle = await world.start();

    world.relay.push(
      secretUpdate(world, handle, MAINT, { LEAK: 'unserved' }, [], 'other')
    );
    await handle.idle();
    expect(
      world.logs.some((l) =>
        l.includes(`secret update for unserved repo 30617:${MAINT}:other`)
      )
    ).toBe(true);

    world.clock.advance(1);
    world.relay.push(secretUpdate(world, handle, MAINT, { KEEP: 'served' }));
    await handle.idle();

    push(world, 2000);
    await handle.idle();
    expect(must(world.runner.requests[0]).secrets).toEqual({ KEEP: 'served' });
    const onDisk = readFileSync(join(world.stateDir, 'secrets.json'), 'utf-8');
    expect(onDisk).toContain('served');
    expect(onDisk).not.toContain('unserved');
    await handle.stop();
  });
});

describe('restart', () => {
  it('a removed secret stays absent after a restart; an untouched one survives it', async () => {
    const world = makeWorld();
    const { announce, refsEvent } = world.snapshot(1000);
    world.relay.serve([announce, refsEvent, serviceRequest(MAINT, 1100)]);
    const first = await world.start();

    world.relay.push(
      secretUpdate(world, first, MAINT, { GONE: 'alpha', KEPT: 'beta' })
    );
    await first.idle();
    world.clock.advance(1000);
    world.relay.push(secretUpdate(world, first, MAINT, {}, ['GONE']));
    await first.idle();
    await first.stop();

    // The tombstone (not the value) is what survives on disk.
    const onDisk = JSON.parse(
      readFileSync(join(world.stateDir, 'secrets.json'), 'utf-8')
    ) as Record<string, Record<string, { value: string | null }>>;
    expect(must(onDisk[ADDR])['GONE']?.value).toBeNull();
    expect(must(onDisk[ADDR])['KEPT']?.value).toBe('beta');

    const second = await world.start();
    expect(second.secretsKeyPubkey).not.toBe(first.secretsKeyPubkey);
    push(world, 2000);
    await second.idle();
    expect(must(world.runner.requests[0]).secrets).toEqual({ KEPT: 'beta' });

    // The fresh key accepts new updates on top of the restored inventory.
    world.clock.advance(1000);
    world.relay.push(secretUpdate(world, second, MAINT, { NEW: 'gamma' }));
    await second.idle();
    push(world, 3000, 'later.txt', 'l\n');
    await second.idle();
    expect(must(world.runner.requests[1]).secrets).toEqual({
      KEPT: 'beta',
      NEW: 'gamma',
    });
    await second.stop();
  });
});

describe('log redaction', () => {
  it('redacts injected values from the uploaded job log and the 9841 log tail', async () => {
    const world = makeWorld();
    const { announce, refsEvent } = world.snapshot(1000);
    world.relay.serve([announce, refsEvent, serviceRequest(MAINT, 1100)]);
    // A workflow that prints its secrets — twice, once inside a longer token.
    const runner = new FakeRunner((request) => {
      const base = defaultFakeRunResult(request);
      const job = must(base.jobs[0]);
      const padding = 'x'.repeat(5000); // push the leak past the 4 KiB tail cut
      return {
        ...base,
        jobs: [
          {
            ...job,
            log:
              `${padding}\n` +
              `token=${request.secrets['DEPLOY_TOKEN']}\n` +
              `url=https://${request.secrets['DEPLOY_TOKEN']}@example/${request.secrets['NPM_TOKEN']}\n` +
              'done\n',
          },
        ],
      };
    });
    const handle = await world.start({ runner });

    world.relay.push(
      secretUpdate(world, handle, MAINT, {
        DEPLOY_TOKEN: 'hunter2',
        NPM_TOKEN: 'npm_hunter2_long',
      })
    );
    await handle.idle();
    push(world, 2000);
    await handle.idle();

    expect(runner.requests).toHaveLength(1);
    const [job] = jobEvents(world.publisher);
    expect(must(job).logTail).toContain('token=***\n');
    expect(must(job).logTail).toContain('url=https://***@example/***\n');
    expect(must(job).logTail).not.toContain('hunter2');
    const uploaded = must(world.publisher.uploadedBlobs[0], 'the log upload');
    const uploadedText = Buffer.from(uploaded.body).toString('utf-8');
    expect(uploadedText).toContain('token=***\n');
    expect(uploadedText).not.toContain('hunter2');
    expect(everythingPublished(world)).not.toContain('hunter2');
    await handle.stop();
  });
});
