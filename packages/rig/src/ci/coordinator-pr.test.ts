/**
 * Pull request triggers (#130): kind:1618 / 1619 for a served repo run the
 * `on: pull_request` workflows against the PR tip and publish the usual
 * NIP-C1 events with `o = pull_request`, NIP-22 root (`E`/`K`/`P`) and
 * parent (`e`/`k`/`p`) tags and NO `r` tag; a PR update supersedes the
 * previous tip (its queued or in-progress run concludes `cancelled`); an
 * unserved repo's PR runs nothing.
 */

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import type { NostrEvent } from '../remote-state.js';
import { flush, waitFor } from './ci-testkit.js';
import {
  ADDR,
  MAINT,
  OWNER,
  STRANGER,
  WORKFLOW,
  blockingRunner,
  cleanupWorlds,
  git,
  makeWorld,
  must,
  progressEvents,
  push,
  publishedKinds,
  resetEventIds,
  resultEvents,
  serviceRequest,
  signed,
  type World,
} from './coordinator-testkit.js';
import {
  CI_JOB_RESULT_KIND,
  CI_WORKFLOW_PROGRESS_KIND,
  CI_WORKFLOW_RESULT_KIND,
} from './nip-c1-events.js';

const PUSH_ONLY = `name: deploy
on:
  push:
    branches: [main]
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - run: echo deploy
`;

const RELEASE_PRS_ONLY = `name: release-pr
on:
  pull_request:
    branches: [release]
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - run: echo release
`;

afterEach(cleanupWorlds);
beforeEach(resetEventIds);

/** Commit on the `feature` branch of the source repo (HEAD stays on main). */
function featureCommit(world: World, file: string, content: string): string {
  const onMain = git(['rev-parse', '--abbrev-ref', 'HEAD'], world.srcDir);
  const exists = git(['branch', '--list', 'feature'], world.srcDir) !== '';
  git(
    exists
      ? ['checkout', '-q', 'feature']
      : ['checkout', '-q', '-b', 'feature'],
    world.srcDir
  );
  const sha = world.commit(file, content, `feature: ${file}`);
  git(['checkout', '-q', onMain], world.srcDir);
  return sha;
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
        ['branch-name', 'feature'],
      ],
    },
    author
  );
}

/** A NIP-34 kind:1619 Pull Request Update moving `pr` to `tip`. */
function pullRequestUpdate(
  author: string,
  pr: NostrEvent,
  tip: string,
  createdAt: number
): NostrEvent {
  return signed(
    {
      kind: 1619,
      content: '',
      created_at: createdAt,
      tags: [
        ['a', ADDR],
        ['p', OWNER],
        ['E', pr.id],
        ['c', tip],
      ],
    },
    author
  );
}

/** Raw tags of every published event of `kind`, in publish order. */
function rawTags(world: World, kind: number): string[][][] {
  return world.publisher.ofKind(kind).map((p) => p.event.tags);
}

function tagValues(tags: string[][], name: string): string[] {
  return tags.filter((t) => t[0] === name).map((t) => t[1] as string);
}

describe('pull request trigger (kind:1618)', () => {
  it('runs every on: pull_request workflow for a served repo: o=pull_request, NIP-22 E/K/P + e/k/p, no r (#130)', async () => {
    const world = makeWorld({
      workflows: {
        'ci.yml': WORKFLOW,
        'deploy.yml': PUSH_ONLY,
        'release-pr.yml': RELEASE_PRS_ONLY,
      },
    });
    const tip = featureCommit(world, 'feature.txt', 'hello\n');
    const { announce, refsEvent } = world.snapshot(1000);
    world.relay.serve([announce, refsEvent, serviceRequest(MAINT, 1100)]);
    const handle = await world.start();
    expect(publishedKinds(world.publisher)).toEqual([]);

    const pr = pullRequest(STRANGER, tip, 2000);
    expect(world.relay.push(pr)).toBe(true);
    await handle.idle();

    // Only ci.yml (on: pull_request, no branch filter) ran: deploy.yml is
    // push-only and release-pr.yml wants PRs against `release`, not main.
    expect(world.runner.requests.map((r) => r.workflow.path)).toEqual([
      '.github/workflows/ci.yml',
    ]);
    const request = must(world.runner.requests[0]);
    expect(request.trigger.commit).toBe(tip);
    expect(request.secrets).toEqual({});
    expect(publishedKinds(world.publisher)).toEqual([
      CI_WORKFLOW_PROGRESS_KIND, // queued
      CI_WORKFLOW_PROGRESS_KIND, // in_progress
      CI_JOB_RESULT_KIND,
      CI_WORKFLOW_PROGRESS_KIND, // in_progress (job quoted)
      CI_WORKFLOW_RESULT_KIND,
      CI_WORKFLOW_PROGRESS_KIND, // concluded
    ]);

    // Every event carries the PR context and no git ref.
    for (const kind of [
      CI_WORKFLOW_PROGRESS_KIND,
      CI_JOB_RESULT_KIND,
      CI_WORKFLOW_RESULT_KIND,
    ]) {
      for (const tags of rawTags(world, kind)) {
        expect(tagValues(tags, 'o')).toEqual(['pull_request']);
        expect(tagValues(tags, 'E')).toEqual([pr.id]);
        expect(tagValues(tags, 'K')).toEqual(['1618']);
        expect(tagValues(tags, 'P')).toEqual([STRANGER]);
        expect(tagValues(tags, 'e')).toEqual([pr.id]);
        expect(tagValues(tags, 'k')).toEqual(['1618']);
        expect(tagValues(tags, 'p')).toEqual([STRANGER]);
        expect(tagValues(tags, 'c')).toEqual([tip]);
        // No git-ref `r`: a 9842's only `r` is its run id (NIP-C1).
        expect(
          tagValues(tags, 'r').filter((v) => v.startsWith('refs/'))
        ).toEqual([]);
      }
    }
    const result = must(resultEvents(world.publisher)[0]);
    expect(
      tagValues(must(rawTags(world, CI_WORKFLOW_RESULT_KIND)[0]), 'r')
    ).toEqual([result.runId]);
    expect(result.conclusion).toBe('success');
    expect(result.trigger).toMatchObject({
      reason: 'pull_request',
      commit: tip,
      pr: {
        prEventId: pr.id,
        prAuthor: STRANGER,
        prKind: 1618,
        sourceEventId: pr.id,
        sourceAuthor: STRANGER,
        sourceKind: 1618,
      },
    });
    expect(result.trigger.ref).toBeUndefined();
    expect(result.provenance).toMatchObject({
      kind: 'service-request',
      pubkey: MAINT,
    });
    await handle.stop();
  });

  it('runs nothing for a served repo without a maintainer Service Request, and never hears a PR for a repo it does not serve', async () => {
    const world = makeWorld();
    const tip = featureCommit(world, 'feature.txt', 'hello\n');
    const { announce, refsEvent } = world.snapshot(1000);
    // A stranger's request does not open service.
    world.relay.serve([announce, refsEvent, serviceRequest(STRANGER, 1100)]);
    const handle = await world.start();

    expect(world.relay.push(pullRequest(STRANGER, tip, 2000))).toBe(true);
    await handle.idle();
    expect(world.runner.requests).toHaveLength(0);
    expect(publishedKinds(world.publisher)).toEqual([]);
    expect(
      world.logs.some((l) =>
        l.includes('pull request seen but no maintainer Service Request')
      )
    ).toBe(true);

    // A PR against a repo outside --repo never matches a subscription.
    const foreign = signed(
      {
        kind: 1618,
        content: '',
        created_at: 2100,
        tags: [
          ['a', `30617:${STRANGER}:other`],
          ['p', STRANGER],
          ['c', tip],
        ],
      },
      STRANGER
    );
    expect(world.relay.push(foreign)).toBe(false);
    await handle.idle();
    expect(world.runner.requests).toHaveLength(0);
    expect(publishedKinds(world.publisher)).toEqual([]);
    await handle.stop();
  });
});

describe('pull request update (kind:1619) supersedes the previous tip', () => {
  it('cancels the in-progress run for the old tip (9842 + 39842 cancelled) and runs the new tip with root + parent tags', async () => {
    const world = makeWorld();
    const tip1 = featureCommit(world, 'feature.txt', 'v1\n');
    const { announce, refsEvent } = world.snapshot(1000);
    world.relay.serve([announce, refsEvent, serviceRequest(MAINT, 1100)]);
    const blocking = blockingRunner();
    const handle = await world.start({ runner: blocking.runner });

    const pr = pullRequest(STRANGER, tip1, 2000);
    world.relay.push(pr);
    await waitFor(() => blocking.started.length === 1, 'the first run');
    await flush();
    expect(must(blocking.started[0]).trigger.commit).toBe(tip1);

    // The contributor pushes a new tip: its objects reach the relay's 30618
    // (a `feature` move runs no push workflow — ci.yml wants main).
    const tip2 = featureCommit(world, 'feature.txt', 'v2\n');
    const { refsEvent: withTip2 } = world.snapshot(2100);
    world.relay.push(withTip2);
    await flush();
    expect(blocking.started).toHaveLength(1);

    const update = pullRequestUpdate(STRANGER, pr, tip2, 2200);
    world.relay.push(update);
    await waitFor(() => blocking.started.length === 2, 'the second run');
    await flush();

    // The old run was aborted and concluded cancelled before the new one ran.
    expect(must(blocking.started[0]).signal?.aborted).toBe(true);
    const cancelled = must(resultEvents(world.publisher)[0]);
    expect(cancelled).toMatchObject({
      conclusion: 'cancelled',
      trigger: { commit: tip1, pr: { prEventId: pr.id, sourceEventId: pr.id } },
    });
    const cancelledProgress = progressEvents(world.publisher).filter(
      (p) => p.runId === cancelled.runId
    );
    expect(must(cancelledProgress.at(-1))).toMatchObject({
      status: 'concluded',
      conclusion: 'cancelled',
    });
    expect(world.logs.some((l) => l.includes('superseded by PR update'))).toBe(
      true
    );

    blocking.release();
    await handle.idle();
    const results = resultEvents(world.publisher);
    expect(results.map((r) => r.conclusion)).toEqual(['cancelled', 'success']);
    const fresh = must(results[1]);
    expect(fresh.runId).not.toBe(cancelled.runId);
    expect(fresh.trigger).toMatchObject({
      reason: 'pull_request',
      commit: tip2,
      pr: {
        prEventId: pr.id,
        prAuthor: STRANGER,
        prKind: 1618,
        sourceEventId: update.id,
        sourceAuthor: STRANGER,
        sourceKind: 1619,
      },
    });
    expect(fresh.trigger.ref).toBeUndefined();
    const resultTags = must(rawTags(world, CI_WORKFLOW_RESULT_KIND)[1]);
    expect(tagValues(resultTags, 'E')).toEqual([pr.id]);
    expect(tagValues(resultTags, 'K')).toEqual(['1618']);
    expect(tagValues(resultTags, 'e')).toEqual([update.id]);
    expect(tagValues(resultTags, 'k')).toEqual(['1619']);
    expect(tagValues(resultTags, 'r')).toEqual([fresh.runId]);
    await handle.stop();
  });

  it('cancels a still-queued run for the old tip without ever handing it to the Runner', async () => {
    const world = makeWorld();
    const tip1 = featureCommit(world, 'feature.txt', 'v1\n');
    const { announce, refsEvent } = world.snapshot(1000);
    world.relay.serve([announce, refsEvent, serviceRequest(MAINT, 1100)]);
    const blocking = blockingRunner();
    const handle = await world.start({
      runner: blocking.runner,
      concurrency: 1,
    });

    // A push run occupies the only slot; the PR run queues behind it.
    push(world, 2000);
    await waitFor(() => blocking.started.length === 1, 'the push run');
    const pr = pullRequest(STRANGER, tip1, 2100);
    world.relay.push(pr);
    await waitFor(
      () =>
        progressEvents(world.publisher).filter((p) => p.status === 'queued')
          .length === 2,
      'the PR run to queue'
    );

    const tip2 = featureCommit(world, 'feature.txt', 'v2\n');
    const { refsEvent: withTip2 } = world.snapshot(2200);
    world.relay.push(withTip2);
    const update = pullRequestUpdate(STRANGER, pr, tip2, 2300);
    world.relay.push(update);
    await waitFor(
      () =>
        progressEvents(world.publisher).filter((p) => p.status === 'queued')
          .length === 3,
      'the updated PR run to queue'
    );

    // The stale queued run concluded cancelled at once, from the queue.
    const stale = must(resultEvents(world.publisher)[0]);
    expect(stale).toMatchObject({
      conclusion: 'cancelled',
      trigger: { commit: tip1, reason: 'pull_request' },
    });
    expect(blocking.started).toHaveLength(1);

    blocking.release(); // the push run
    await waitFor(() => blocking.started.length === 2, 'the fresh PR run');
    expect(must(blocking.started[1]).trigger.commit).toBe(tip2);
    blocking.release();
    await handle.idle();
    expect(
      resultEvents(world.publisher).map((r) => [r.trigger.reason, r.conclusion])
    ).toEqual([
      ['pull_request', 'cancelled'],
      ['push', 'success'],
      ['pull_request', 'success'],
    ]);
    await handle.stop();
  });
});
