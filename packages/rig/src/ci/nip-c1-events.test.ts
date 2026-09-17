/**
 * NIP-C1 event builder + parser tests (rig#125, slice 1): every kind rig
 * emits or reads round-trips builder → signed-shape → parser, the tag
 * layouts match docs/specs/nip-c1.md, and the Service Request / Stop total
 * order + closing rules behave as the spec mandates.
 */

import { describe, it, expect } from 'vitest';
import type { NostrEvent } from '../remote-state.js';
import type { UnsignedEvent } from '../nip34-events.js';
import {
  CI_ADVERTISEMENT_KIND,
  CI_JOB_RESULT_KIND,
  CI_LIVE_LOG_TAIL_INTERVAL_MS,
  CI_LIVE_LOG_TAIL_JOB_BYTES,
  CI_LIVE_LOG_TAIL_KIND,
  CI_LIVE_LOG_TAIL_MAX_BYTES,
  CI_MANUAL_TRIGGER_KIND,
  CI_RUNNER_CHANNEL_KEY,
  CI_SECRET_UPDATE_KIND,
  CI_SERVICE_REQUEST_KIND,
  CI_SERVICE_STOP_KIND,
  CI_WORKFLOW_PROGRESS_KIND,
  CI_WORKFLOW_RESULT_KIND,
  buildCiAdvertisement,
  buildCiJobResult,
  buildCiLiveLogTail,
  buildCiManualTrigger,
  buildCiSecretUpdate,
  buildCiServiceRequest,
  buildCiServiceStop,
  buildCiWorkflowProgress,
  buildCiWorkflowResult,
  commonTriggerTags,
  controlOrder,
  liveLogTailBudget,
  liveLogTailEventBudget,
  parseCiAdvertisement,
  parseCiJobResult,
  parseCiLiveLogTail,
  parseCiManualTrigger,
  parseCiSecretUpdate,
  parseCiServiceControl,
  parseCiTriggerContext,
  parseCiWorkflowProgress,
  parseCiWorkflowResult,
  parseRepoAddress,
  repoAddress,
  selectServiceRequests,
  sliceLogTail,
  type CiTriggerContext,
  type ServiceControl,
} from './nip-c1-events.js';

const OWNER = 'ab'.repeat(32);
const MAINTAINER = 'cd'.repeat(32);
const STRANGER = 'ef'.repeat(32);
const COORDINATOR = '12'.repeat(32);
const REPO = 'demo-repo';

/** Narrow an optional value or fail the test loudly (no non-null assertions). */
function must<T>(value: T | undefined | null, what = 'value'): T {
  if (value === undefined || value === null) {
    throw new Error(`expected ${what} to be present`);
  }
  return value;
}
const ADDR = `30617:${OWNER}:${REPO}`;
const COMMIT = '9a'.repeat(20);
const TAG_OBJECT = '7b'.repeat(20);
const SHA256 = 'f1'.repeat(32);
const RELAY = 'wss://relay.test.example';
const NOW = 1_800_000_000;

/** Give an unsigned builder output the read-side shape a relay would serve. */
function signed(
  event: UnsignedEvent,
  overrides: Partial<NostrEvent> = {}
): NostrEvent {
  return {
    id: '00'.repeat(32),
    pubkey: COORDINATOR,
    sig: 'ff'.repeat(64),
    ...event,
    ...overrides,
  };
}

function tag(event: { tags: string[][] }, name: string): string[][] {
  return event.tags.filter((t) => t[0] === name);
}

const PUSH_TRIGGER: CiTriggerContext = {
  repoAddr: ADDR,
  commit: COMMIT,
  workflow: { path: '.github/workflows/ci.yml', sha256: SHA256 },
  reason: 'push',
  ref: 'refs/heads/main',
};

const PR_TRIGGER: CiTriggerContext = {
  repoAddr: ADDR,
  extraRepoAddrs: [`30617:${MAINTAINER}:${REPO}`],
  commit: COMMIT,
  tagObjectIds: [TAG_OBJECT],
  workflow: { path: '.github/workflows/ci.yml', sha256: SHA256 },
  reason: 'pull_request',
  pr: {
    prEventId: '31'.repeat(32),
    prAuthor: STRANGER,
    prKind: 1618,
    sourceEventId: '32'.repeat(32),
    sourceAuthor: STRANGER,
    sourceKind: 1619,
  },
};

// ---------------------------------------------------------------------------
// Repo address helpers
// ---------------------------------------------------------------------------

describe('repo address', () => {
  it('builds and parses the 30617:<owner>:<repo-id> coordinate', () => {
    expect(repoAddress(OWNER.toUpperCase(), REPO)).toBe(ADDR);
    expect(parseRepoAddress(ADDR)).toEqual({
      ownerPubkey: OWNER,
      repoId: REPO,
    });
    expect(parseRepoAddress(`30617:${OWNER}:with:colons`)).toEqual({
      ownerPubkey: OWNER,
      repoId: 'with:colons',
    });
  });

  it('rejects other kinds and malformed pubkeys', () => {
    expect(parseRepoAddress(`30618:${OWNER}:${REPO}`)).toBeNull();
    expect(parseRepoAddress(`30617:nothex:${REPO}`)).toBeNull();
    expect(parseRepoAddress('garbage')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Common trigger tags
// ---------------------------------------------------------------------------

describe('commonTriggerTags', () => {
  it('emits a*, c*, w, o, r for a push trigger', () => {
    expect(commonTriggerTags(PUSH_TRIGGER)).toEqual([
      ['a', ADDR],
      ['c', COMMIT],
      ['w', '.github/workflows/ci.yml', SHA256],
      ['o', 'push'],
      ['r', 'refs/heads/main'],
    ]);
  });

  it('emits NIP-22 E/K/P + e/k/p and NO r for a pull_request trigger', () => {
    const tags = commonTriggerTags(PR_TRIGGER);
    expect(tags).toEqual([
      ['a', ADDR],
      ['a', `30617:${MAINTAINER}:${REPO}`],
      ['c', COMMIT],
      ['c', TAG_OBJECT],
      ['w', '.github/workflows/ci.yml', SHA256],
      ['o', 'pull_request'],
      ['E', must(PR_TRIGGER.pr).prEventId],
      ['K', '1618'],
      ['P', STRANGER],
      ['e', must(PR_TRIGGER.pr).sourceEventId],
      ['k', '1619'],
      ['p', STRANGER],
    ]);
    expect(tag({ tags }, 'r')).toEqual([]);
  });

  it('round-trips through parseCiTriggerContext', () => {
    expect(parseCiTriggerContext(commonTriggerTags(PUSH_TRIGGER))).toEqual(
      PUSH_TRIGGER
    );
    expect(parseCiTriggerContext(commonTriggerTags(PR_TRIGGER))).toEqual(
      PR_TRIGGER
    );
  });

  it('accepts K/k = 1617 (rig publishes 1617 patches as PRs)', () => {
    const trigger: CiTriggerContext = {
      ...PR_TRIGGER,
      extraRepoAddrs: undefined,
      tagObjectIds: undefined,
      pr: {
        prEventId: '41'.repeat(32),
        prAuthor: STRANGER,
        prKind: 1617,
        sourceEventId: '41'.repeat(32),
        sourceAuthor: STRANGER,
        sourceKind: 1617,
      },
    };
    delete trigger.extraRepoAddrs;
    delete trigger.tagObjectIds;
    const parsed = parseCiTriggerContext(commonTriggerTags(trigger));
    expect(parsed).toEqual(trigger);
  });

  it('rejects a tags naming different repo ids, a missing w, or an unknown o', () => {
    const base = commonTriggerTags(PUSH_TRIGGER);
    expect(
      parseCiTriggerContext([...base, ['a', `30617:${MAINTAINER}:other`]])
    ).toBeNull();
    expect(parseCiTriggerContext(base.filter((t) => t[0] !== 'w'))).toBeNull();
    expect(
      parseCiTriggerContext(
        base.map((t) => (t[0] === 'o' ? ['o', 'schedule'] : t))
      )
    ).toBeNull();
    expect(
      parseCiTriggerContext(
        base.map((t) => (t[0] === 'c' ? ['c', 'nothex'] : t))
      )
    ).toBeNull();
  });

  it('falls back to the PR author when the lowercase p is absent (manual PR form)', () => {
    const tags = commonTriggerTags(PR_TRIGGER).filter((t) => t[0] !== 'p');
    const parsed = parseCiTriggerContext(tags);
    expect(parsed?.pr?.sourceAuthor).toBe(STRANGER);
  });
});

// ---------------------------------------------------------------------------
// kind:19843 — Coordinator Advertisement
// ---------------------------------------------------------------------------

describe('Coordinator Advertisement (19843)', () => {
  const input = {
    version: '4.3.0',
    selectors: ['ubuntu-latest', 'Ubuntu-24.04'],
    admission: 'maintainer-request' as const,
    execution: 'request-required' as const,
    billing: 'out-of-band' as const,
    secretsKey: { pubkey: '77'.repeat(32), inboxRelays: [RELAY] },
    expiresAt: NOW + 900,
  };

  it('emits software/W/R/M/X/B/secrets-key/expiration with empty content and no d', () => {
    const event = buildCiAdvertisement(input, NOW);
    expect(event.kind).toBe(CI_ADVERTISEMENT_KIND);
    expect(event.content).toBe('');
    expect(event.created_at).toBe(NOW);
    expect(tag(event, 'd')).toEqual([]);
    expect(tag(event, 'software')).toEqual([['software', 'rig', '4.3.0']]);
    expect(tag(event, 'W')).toEqual([['W', 'act']]);
    expect(tag(event, 'R')).toEqual([
      ['R', 'act:ubuntu-latest'],
      ['R', 'act:ubuntu-24.04'],
    ]);
    expect(tag(event, 'M')).toEqual([['M', 'maintainer-request']]);
    expect(tag(event, 'X')).toEqual([['X', 'request-required']]);
    expect(tag(event, 'B')).toEqual([['B', 'out-of-band']]);
    expect(tag(event, 'secrets-key')).toEqual([
      ['secrets-key', 'nip44-v2', '77'.repeat(32), RELAY],
    ]);
    expect(tag(event, 'expiration')).toEqual([
      ['expiration', String(NOW + 900)],
    ]);
  });

  it('round-trips through parseCiAdvertisement', () => {
    const event = signed(buildCiAdvertisement(input, NOW), {
      id: '19'.repeat(32),
    });
    expect(parseCiAdvertisement(event)).toEqual({
      eventId: '19'.repeat(32),
      pubkey: COORDINATOR,
      createdAt: NOW,
      version: '4.3.0',
      families: ['act'],
      selectors: ['act:ubuntu-latest', 'act:ubuntu-24.04'],
      admission: 'maintainer-request',
      execution: 'request-required',
      billing: 'out-of-band',
      secretsKey: { pubkey: '77'.repeat(32), inboxRelays: [RELAY] },
      expiresAt: NOW + 900,
    });
  });

  it('omits B and secrets-key when not given', () => {
    const { billing: _b, secretsKey: _s, ...bare } = input;
    const event = signed(buildCiAdvertisement(bare, NOW));
    expect(tag(event, 'B')).toEqual([]);
    expect(tag(event, 'secrets-key')).toEqual([]);
    const parsed = parseCiAdvertisement(event);
    expect(parsed?.billing).toBeUndefined();
    expect(parsed?.secretsKey).toBeUndefined();
  });

  it('refuses an expiration more than 30 minutes out, not later than created_at, or no selectors', () => {
    expect(() =>
      buildCiAdvertisement({ ...input, expiresAt: NOW + 1801 }, NOW)
    ).toThrow(/expiration/);
    expect(() =>
      buildCiAdvertisement({ ...input, expiresAt: NOW }, NOW)
    ).toThrow(/expiration/);
    expect(() =>
      buildCiAdvertisement({ ...input, selectors: [] }, NOW)
    ).toThrow(/selector/);
    expect(() =>
      buildCiAdvertisement(
        { ...input, secretsKey: { pubkey: '77'.repeat(32), inboxRelays: [] } },
        NOW
      )
    ).toThrow(/inbox/);
  });

  it('parser rejects the wrong kind, a d tag, missing M/X/expiration, or W without R', () => {
    const good = signed(buildCiAdvertisement(input, NOW));
    expect(parseCiAdvertisement({ ...good, kind: 9843 })).toBeNull();
    expect(
      parseCiAdvertisement({ ...good, tags: [...good.tags, ['d', 'x']] })
    ).toBeNull();
    expect(
      parseCiAdvertisement({
        ...good,
        tags: good.tags.filter((t) => t[0] !== 'M'),
      })
    ).toBeNull();
    expect(
      parseCiAdvertisement({
        ...good,
        tags: good.tags.filter((t) => t[0] !== 'expiration'),
      })
    ).toBeNull();
    expect(
      parseCiAdvertisement({
        ...good,
        tags: good.tags.filter((t) => t[0] !== 'R'),
      })
    ).toBeNull();
    // An unknown policy value must not be read as open/automatic service.
    expect(
      parseCiAdvertisement({
        ...good,
        tags: good.tags.map((t) => (t[0] === 'X' ? ['X', 'whatever'] : t)),
      })
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// kind:9843 / 9844 — Service Request / Stop
// ---------------------------------------------------------------------------

describe('Service Request / Stop (9843 / 9844)', () => {
  it('emits exactly one a and one p tag with empty content', () => {
    const req = buildCiServiceRequest(ADDR, COORDINATOR, RELAY, NOW);
    expect(req).toEqual({
      kind: CI_SERVICE_REQUEST_KIND,
      content: '',
      tags: [
        ['a', ADDR, RELAY],
        ['p', COORDINATOR],
      ],
      created_at: NOW,
    });
    const stop = buildCiServiceStop(ADDR, COORDINATOR, undefined, NOW);
    expect(stop.kind).toBe(CI_SERVICE_STOP_KIND);
    expect(stop.tags).toEqual([
      ['a', ADDR],
      ['p', COORDINATOR],
    ]);
  });

  it('round-trips through parseCiServiceControl', () => {
    const req = signed(buildCiServiceRequest(ADDR, COORDINATOR, RELAY, NOW), {
      id: '43'.repeat(32),
      pubkey: OWNER,
    });
    expect(parseCiServiceControl(req)).toEqual({
      kind: 'request',
      eventId: '43'.repeat(32),
      pubkey: OWNER,
      createdAt: NOW,
      repoAddr: ADDR,
      coordinatorPubkey: COORDINATOR,
      relayHint: RELAY,
    });
    const stop = signed(buildCiServiceStop(ADDR, COORDINATOR, undefined, NOW), {
      pubkey: OWNER,
    });
    expect(parseCiServiceControl(stop)?.kind).toBe('stop');
    expect(parseCiServiceControl(stop)?.relayHint).toBeUndefined();
  });

  it('parser rejects content, two a tags, d/expiration tags, or an unknown kind', () => {
    const good = signed(buildCiServiceRequest(ADDR, COORDINATOR, RELAY, NOW));
    expect(parseCiServiceControl({ ...good, content: 'x' })).toBeNull();
    expect(
      parseCiServiceControl({ ...good, tags: [...good.tags, ['a', ADDR]] })
    ).toBeNull();
    expect(
      parseCiServiceControl({ ...good, tags: [...good.tags, ['d', 'x']] })
    ).toBeNull();
    expect(
      parseCiServiceControl({
        ...good,
        tags: [...good.tags, ['expiration', '1']],
      })
    ).toBeNull();
    expect(parseCiServiceControl({ ...good, kind: 9840 })).toBeNull();
  });

  it('controlOrder: greater created_at is later; equal timestamps → LOWER id is later', () => {
    const a = { createdAt: 10, eventId: 'aa' };
    const b = { createdAt: 11, eventId: '00' };
    expect(controlOrder(a, b)).toBeLessThan(0);
    expect(controlOrder(b, a)).toBeGreaterThan(0);
    const low = { createdAt: 10, eventId: '00' };
    const high = { createdAt: 10, eventId: 'ff' };
    // `low` has the lexicographically lower id, so it is LATER than `high`.
    expect(controlOrder(low, high)).toBeGreaterThan(0);
    expect(controlOrder(high, low)).toBeLessThan(0);
    expect(controlOrder(low, { ...low })).toBe(0);
  });
});

describe('selectServiceRequests', () => {
  const authorized = new Set([OWNER, MAINTAINER]);
  function control(
    kind: 'request' | 'stop',
    pubkey: string,
    createdAt: number,
    id: string,
    coordinator = COORDINATOR,
    repoAddr = ADDR
  ): ServiceControl {
    return {
      kind,
      eventId: id.repeat(32),
      pubkey,
      createdAt,
      repoAddr,
      coordinatorPubkey: coordinator,
    };
  }

  it('selects the newest accepted request; unauthorized requesters are ignored', () => {
    const r1 = control('request', OWNER, 100, '01');
    const r2 = control('request', MAINTAINER, 200, '02');
    const rx = control('request', STRANGER, 300, '03');
    const result = selectServiceRequests([rx, r2, r1], {
      coordinatorPubkey: COORDINATOR,
      repoAddr: ADDR,
      authorized,
    });
    expect(result.active?.eventId).toBe(r2.eventId);
    expect(result.open.map((c) => c.eventId)).toEqual([r1.eventId, r2.eventId]);
  });

  it('accepts an operator-allowlisted requester (NIP-C1 operator policy); their Stop closes only their own request', () => {
    const rx = control('request', STRANGER, 100, '01');
    const opts = {
      coordinatorPubkey: COORDINATOR,
      repoAddr: ADDR,
      authorized,
      acceptedRequesters: new Set([STRANGER.toUpperCase()]),
    };
    expect(selectServiceRequests([rx], opts).active?.eventId).toBe(rx.eventId);
    // Their Stop is author-local: it closes their own request, never a maintainer's.
    const r2 = control('request', MAINTAINER, 200, '02');
    const stop = control('stop', STRANGER, 300, '03');
    const after = selectServiceRequests([rx, r2, stop], opts);
    expect(after.open.map((c) => c.eventId)).toEqual([r2.eventId]);
    // A maintainer Stop still closes everything, the allowlisted request included.
    expect(
      selectServiceRequests([rx, control('stop', OWNER, 400, '04')], opts)
        .active
    ).toBeNull();
    // Without the allowlist the same request is ignored.
    expect(
      selectServiceRequests([rx], {
        coordinatorPubkey: COORDINATOR,
        repoAddr: ADDR,
        authorized,
      }).active
    ).toBeNull();
  });

  it('a maintainer Stop closes every earlier request; a later request re-opens service', () => {
    const r1 = control('request', OWNER, 100, '01');
    const r2 = control('request', MAINTAINER, 200, '02');
    const stop = control('stop', MAINTAINER, 300, '03');
    expect(
      selectServiceRequests([r1, r2, stop], {
        coordinatorPubkey: COORDINATOR,
        repoAddr: ADDR,
        authorized,
      }).active
    ).toBeNull();
    const r3 = control('request', OWNER, 400, '04');
    expect(
      selectServiceRequests([r1, r2, stop, r3], {
        coordinatorPubkey: COORDINATOR,
        repoAddr: ADDR,
        authorized,
      }).active?.eventId
    ).toBe(r3.eventId);
  });

  it("a non-maintainer Stop closes only that author's own earlier requests", () => {
    // MAINTAINER's request stands; STRANGER (no authority) stops — no effect
    // on the maintainer's request.
    const r1 = control('request', MAINTAINER, 100, '01');
    const stop = control('stop', STRANGER, 200, '02');
    expect(
      selectServiceRequests([r1, stop], {
        coordinatorPubkey: COORDINATOR,
        repoAddr: ADDR,
        authorized,
      }).active?.eventId
    ).toBe(r1.eventId);
    // A REMOVED maintainer (not in `authorized` any more) keeps the
    // author-local effect: it closes its own earlier request only.
    const rOld = control('request', STRANGER, 50, '05');
    const stopOwn = control('stop', STRANGER, 60, '06');
    const result = selectServiceRequests([rOld, stopOwn, r1], {
      coordinatorPubkey: COORDINATOR,
      repoAddr: ADDR,
      authorized,
    });
    expect(result.active?.eventId).toBe(r1.eventId);
  });

  it('equal timestamps: the lexicographically lower id is later', () => {
    const req = control('request', OWNER, 100, 'ff');
    const stop = control('stop', OWNER, 100, '00'); // later than req
    expect(
      selectServiceRequests([req, stop], {
        coordinatorPubkey: COORDINATOR,
        repoAddr: ADDR,
        authorized,
      }).active
    ).toBeNull();
    const req2 = control('request', OWNER, 100, '00');
    const stop2 = control('stop', OWNER, 100, 'ff'); // EARLIER than req2
    expect(
      selectServiceRequests([req2, stop2], {
        coordinatorPubkey: COORDINATOR,
        repoAddr: ADDR,
        authorized,
      }).active?.eventId
    ).toBe(req2.eventId);
  });

  it('ignores controls for another coordinator or another repo', () => {
    const other = control('request', OWNER, 100, '01', '99'.repeat(32));
    const otherRepo = control(
      'request',
      OWNER,
      100,
      '02',
      COORDINATOR,
      `30617:${OWNER}:other`
    );
    expect(
      selectServiceRequests([other, otherRepo], {
        coordinatorPubkey: COORDINATOR,
        repoAddr: ADDR,
        authorized,
      }).active
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// kind:9840 — Manual Trigger
// ---------------------------------------------------------------------------

describe('Manual Trigger (9840)', () => {
  it('emits p (coordinator) + common tags without o; r optional', () => {
    const { reason: _r, ...trigger } = PUSH_TRIGGER;
    const event = buildCiManualTrigger(COORDINATOR, trigger, NOW);
    expect(event.kind).toBe(CI_MANUAL_TRIGGER_KIND);
    expect(event.content).toBe('');
    expect(event.tags).toEqual([
      ['p', COORDINATOR],
      ['a', ADDR],
      ['c', COMMIT],
      ['w', '.github/workflows/ci.yml', SHA256],
      ['r', 'refs/heads/main'],
    ]);
  });

  it('PR form carries E/K/P/e/k and the ONLY lowercase p is the coordinator', () => {
    const { reason: _r, ...trigger } = PR_TRIGGER;
    const event = buildCiManualTrigger(COORDINATOR, trigger, NOW);
    expect(tag(event, 'p')).toEqual([['p', COORDINATOR]]);
    expect(tag(event, 'r')).toEqual([]);
    expect(tag(event, 'E')).toEqual([['E', must(PR_TRIGGER.pr).prEventId]]);
    expect(tag(event, 'e')).toEqual([['e', must(PR_TRIGGER.pr).sourceEventId]]);
    expect(tag(event, 'k')).toEqual([['k', '1619']]);
  });

  it('round-trips through parseCiManualTrigger (PR sourceAuthor falls back to prAuthor)', () => {
    const { reason: _r, ...trigger } = PR_TRIGGER;
    const event = signed(buildCiManualTrigger(COORDINATOR, trigger, NOW), {
      id: '40'.repeat(32),
      pubkey: MAINTAINER,
    });
    expect(parseCiManualTrigger(event, COORDINATOR)).toEqual({
      eventId: '40'.repeat(32),
      pubkey: MAINTAINER,
      createdAt: NOW,
      coordinatorPubkey: COORDINATOR,
      trigger,
    });
    const { reason: _r2, ...push } = PUSH_TRIGGER;
    const pushEvent = signed(buildCiManualTrigger(COORDINATOR, push, NOW));
    expect(parseCiManualTrigger(pushEvent)?.trigger).toEqual(push);
  });

  it('parser ignores requests for another coordinator, two p tags, or a missing w', () => {
    const { reason: _r, ...trigger } = PUSH_TRIGGER;
    const good = signed(buildCiManualTrigger(COORDINATOR, trigger, NOW));
    expect(parseCiManualTrigger(good, '99'.repeat(32))).toBeNull();
    expect(
      parseCiManualTrigger({ ...good, tags: [...good.tags, ['p', OWNER]] })
    ).toBeNull();
    expect(
      parseCiManualTrigger({
        ...good,
        tags: good.tags.filter((t) => t[0] !== 'w'),
      })
    ).toBeNull();
    expect(parseCiManualTrigger({ ...good, kind: 9843 })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// kind:29846 — Repository Secret Update
// ---------------------------------------------------------------------------

describe('Repository Secret Update (29846)', () => {
  const args = {
    repoAddr: ADDR,
    coordinatorPubkey: COORDINATOR,
    advertisementId: '19'.repeat(32),
    advertisementRelayHint: RELAY,
    senderPubkey: '55'.repeat(32),
    recipientPubkey: '77'.repeat(32),
    ciphertext: 'AqZ…ciphertext',
    createdAt: NOW,
  };

  it('emits exactly one of each a/p/e/sender/recipient/encryption tag', () => {
    const event = buildCiSecretUpdate(args);
    expect(event).toEqual({
      kind: CI_SECRET_UPDATE_KIND,
      content: 'AqZ…ciphertext',
      created_at: NOW,
      tags: [
        ['a', ADDR],
        ['p', COORDINATOR],
        ['e', '19'.repeat(32), RELAY, 'secrets-key'],
        ['sender', '55'.repeat(32)],
        ['recipient', '77'.repeat(32)],
        ['encryption', 'nip44-v2'],
      ],
    });
  });

  it('round-trips through parseCiSecretUpdate when the a pubkey equals the signer', () => {
    const event = signed(buildCiSecretUpdate(args), {
      id: '29'.repeat(32),
      pubkey: OWNER,
    });
    expect(parseCiSecretUpdate(event)).toEqual({
      eventId: '29'.repeat(32),
      pubkey: OWNER,
      createdAt: NOW,
      repoAddr: ADDR,
      coordinatorPubkey: COORDINATOR,
      advertisementId: '19'.repeat(32),
      senderPubkey: '55'.repeat(32),
      recipientPubkey: '77'.repeat(32),
      ciphertext: 'AqZ…ciphertext',
    });
  });

  it('parser rejects a signer ≠ a pubkey, a foreign tag, a missing marker, or a wrong encryption', () => {
    const good = signed(buildCiSecretUpdate(args), { pubkey: OWNER });
    expect(parseCiSecretUpdate({ ...good, pubkey: MAINTAINER })).toBeNull();
    expect(
      parseCiSecretUpdate({ ...good, tags: [...good.tags, ['t', 'x']] })
    ).toBeNull();
    expect(
      parseCiSecretUpdate({
        ...good,
        tags: good.tags.map((t) =>
          t[0] === 'e' ? ['e', t[1] as string, RELAY] : t
        ),
      })
    ).toBeNull();
    expect(
      parseCiSecretUpdate({
        ...good,
        tags: good.tags.map((t) =>
          t[0] === 'encryption' ? ['encryption', 'nip04'] : t
        ),
      })
    ).toBeNull();
    expect(parseCiSecretUpdate({ ...good, content: '' })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// kind:9841 — Job Result
// ---------------------------------------------------------------------------

const RUN_ID = 'run-0001';
const PROGRESS_ADDR = `${CI_WORKFLOW_PROGRESS_KIND}:${COORDINATOR}:${RUN_ID}`;
const PROVENANCE = {
  kind: 'service-request' as const,
  eventId: '43'.repeat(32),
  relayUrl: RELAY,
  pubkey: OWNER,
};

describe('Job Result (9841)', () => {
  const input = {
    trigger: PUSH_TRIGGER,
    progressAddress: PROGRESS_ADDR,
    relayUrl: RELAY,
    jobId: 'build',
    name: 'Build & test',
    conclusion: 'failure' as const,
    logsUrl: 'http://localhost:3000/raw/tx123',
    logTail: 'step 3 failed\nexit 1',
    logOmittedBytes: 4096,
    artifacts: [
      {
        url: 'http://localhost:3000/raw/tx456',
        filename: 'dist/app.js',
        name: 'dist',
      },
    ],
    queuedAt: NOW - 20,
    startedAt: NOW - 10,
    exitCode: 1,
    runsOn: ['ubuntu-latest'],
  };

  it('emits common tags, the 39842 progress quote, job/name/conclusion/logs/artifact/timing tags', () => {
    const event = buildCiJobResult(input, NOW);
    expect(event.kind).toBe(CI_JOB_RESULT_KIND);
    expect(event.content).toBe(
      '[log-tail omitted=4096]\nstep 3 failed\nexit 1'
    );
    expect(event.tags).toEqual([
      ...commonTriggerTags(PUSH_TRIGGER),
      ['q', PROGRESS_ADDR, RELAY],
      ['job', 'build'],
      ['name', 'Build & test'],
      ['conclusion', 'failure'],
      ['logs', 'http://localhost:3000/raw/tx123'],
      ['artifact', 'http://localhost:3000/raw/tx456', 'dist/app.js', 'dist'],
      ['queued_at', String(NOW - 20)],
      ['started_at', String(NOW - 10)],
      ['exit_code', '1'],
      ['runs_on', 'ubuntu-latest'],
    ]);
  });

  it('round-trips through parseCiJobResult', () => {
    const event = signed(buildCiJobResult(input, NOW), { id: '41'.repeat(32) });
    expect(parseCiJobResult(event)).toEqual({
      eventId: '41'.repeat(32),
      pubkey: COORDINATOR,
      createdAt: NOW,
      trigger: PUSH_TRIGGER,
      progressAddress: PROGRESS_ADDR,
      jobId: 'build',
      name: 'Build & test',
      conclusion: 'failure',
      logsUrl: 'http://localhost:3000/raw/tx123',
      logTail: 'step 3 failed\nexit 1',
      logOmittedBytes: 4096,
      artifacts: input.artifacts,
      queuedAt: NOW - 20,
      startedAt: NOW - 10,
      exitCode: 1,
      runsOn: ['ubuntu-latest'],
    });
  });

  it('MAY carry a provenance quote; a Job Result never quotes a service request by default', () => {
    const plain = buildCiJobResult(input, NOW);
    expect(
      plain.tags.some((t) => t[0] === 'q' && t[4] === 'service-request')
    ).toBe(false);
    const withProv = signed(
      buildCiJobResult(
        { ...input, provenance: { ...PROVENANCE, kind: 'manual-trigger' } },
        NOW
      )
    );
    expect(parseCiJobResult(withProv)?.provenance).toEqual({
      ...PROVENANCE,
      kind: 'manual-trigger',
    });
  });

  it('parser tolerates a bare content (no omitted header) and rejects a missing job or bad conclusion', () => {
    const good = signed(buildCiJobResult(input, NOW));
    const bare = parseCiJobResult({ ...good, content: 'just a tail' });
    expect(bare?.logTail).toBe('just a tail');
    expect(bare?.logOmittedBytes).toBe(0);
    expect(
      parseCiJobResult({
        ...good,
        tags: good.tags.filter((t) => t[0] !== 'job'),
      })
    ).toBeNull();
    expect(
      parseCiJobResult({
        ...good,
        tags: good.tags.map((t) =>
          t[0] === 'conclusion' ? ['conclusion', 'meh'] : t
        ),
      })
    ).toBeNull();
    expect(
      parseCiJobResult({ ...good, tags: good.tags.filter((t) => t[0] !== 'q') })
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// kind:9842 — Workflow Result
// ---------------------------------------------------------------------------

const JOB_QUOTES = [
  {
    eventId: '41'.repeat(32),
    relayUrl: RELAY,
    pubkey: COORDINATOR,
    jobId: 'build',
  },
  {
    eventId: '42'.repeat(32),
    relayUrl: RELAY,
    pubkey: '88'.repeat(32),
    jobId: 'lint',
  },
];

describe('Workflow Result (9842)', () => {
  const input = {
    trigger: PUSH_TRIGGER,
    runId: RUN_ID,
    conclusion: 'success' as const,
    queuedAt: NOW - 30,
    startedAt: NOW - 20,
    provenance: PROVENANCE,
    jobs: JOB_QUOTES,
  };

  it('emits common tags, the run-id r, conclusion, timings, the service-request quote, and one job quote per job', () => {
    const event = buildCiWorkflowResult(input, NOW);
    expect(event.kind).toBe(CI_WORKFLOW_RESULT_KIND);
    expect(event.content).toBe('');
    expect(event.tags).toEqual([
      ...commonTriggerTags(PUSH_TRIGGER),
      ['r', RUN_ID],
      ['conclusion', 'success'],
      ['queued_at', String(NOW - 30)],
      ['started_at', String(NOW - 20)],
      ['q', '43'.repeat(32), RELAY, OWNER, 'service-request'],
      ['q', '41'.repeat(32), RELAY, COORDINATOR, 'build'],
      ['q', '42'.repeat(32), RELAY, '88'.repeat(32), 'lint'],
    ]);
    // Push results carry BOTH the git ref and the run id under `r`.
    expect(tag(event, 'r')).toEqual([
      ['r', 'refs/heads/main'],
      ['r', RUN_ID],
    ]);
  });

  it('round-trips through parseCiWorkflowResult', () => {
    const event = signed(buildCiWorkflowResult(input, NOW), {
      id: '42'.repeat(32),
    });
    expect(parseCiWorkflowResult(event)).toEqual({
      eventId: '42'.repeat(32),
      pubkey: COORDINATOR,
      createdAt: NOW,
      trigger: PUSH_TRIGGER,
      runId: RUN_ID,
      conclusion: 'success',
      queuedAt: NOW - 30,
      startedAt: NOW - 20,
      provenance: PROVENANCE,
      jobs: JOB_QUOTES,
    });
  });

  it('an automatic run omits the provenance quote; manual replays use manual-trigger', () => {
    const auto = signed(
      buildCiWorkflowResult({ ...input, provenance: undefined }, NOW)
    );
    expect(parseCiWorkflowResult(auto)?.provenance).toBeUndefined();
    const manual = signed(
      buildCiWorkflowResult(
        {
          ...input,
          trigger: { ...PUSH_TRIGGER, reason: 'manual' },
          provenance: {
            ...PROVENANCE,
            kind: 'manual-trigger',
            pubkey: MAINTAINER,
          },
        },
        NOW
      )
    );
    expect(parseCiWorkflowResult(manual)?.provenance).toEqual({
      ...PROVENANCE,
      kind: 'manual-trigger',
      pubkey: MAINTAINER,
    });
    expect(parseCiWorkflowResult(manual)?.trigger.reason).toBe('manual');
  });

  it('parser rejects a missing run id, a missing conclusion, or content', () => {
    const good = signed(buildCiWorkflowResult(input, NOW));
    expect(
      parseCiWorkflowResult({
        ...good,
        tags: good.tags.filter((t) => !(t[0] === 'r' && t[1] === RUN_ID)),
      })
    ).toBeNull();
    expect(
      parseCiWorkflowResult({
        ...good,
        tags: good.tags.filter((t) => t[0] !== 'conclusion'),
      })
    ).toBeNull();
    expect(parseCiWorkflowResult({ ...good, content: 'x' })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// kind:39842 — Workflow Progress
// ---------------------------------------------------------------------------

describe('Workflow Progress (39842)', () => {
  const base = {
    trigger: PUSH_TRIGGER,
    runId: RUN_ID,
    queuedAt: NOW - 30,
    provenance: PROVENANCE,
    jobs: [] as typeof JOB_QUOTES,
    expiresAt: NOW + 1800,
  };

  it('queued: d/status/queue/expiration, NO conclusion, and the service-request quote is omitted', () => {
    const event = buildCiWorkflowProgress(
      { ...base, status: 'queued', queue: 2 },
      NOW
    );
    expect(event.kind).toBe(CI_WORKFLOW_PROGRESS_KIND);
    expect(event.content).toBe('');
    expect(event.tags).toEqual([
      ...commonTriggerTags(PUSH_TRIGGER),
      ['d', RUN_ID],
      ['status', 'queued'],
      ['queue', '2'],
      ['queued_at', String(NOW - 30)],
      ['expiration', String(NOW + 1800)],
    ]);
    expect(tag(event, 'conclusion')).toEqual([]);
  });

  it('in_progress: carries in-progress job ids, the frozen quote, and completed job quotes', () => {
    const event = buildCiWorkflowProgress(
      {
        ...base,
        status: 'in_progress',
        startedAt: NOW - 20,
        inProgress: ['lint'],
        jobs: [must(JOB_QUOTES[0])],
      },
      NOW
    );
    expect(tag(event, 'in-progress')).toEqual([['in-progress', 'lint']]);
    expect(tag(event, 'q')).toEqual([
      ['q', '43'.repeat(32), RELAY, OWNER, 'service-request'],
      ['q', '41'.repeat(32), RELAY, COORDINATOR, 'build'],
    ]);
    expect(tag(event, 'queue')).toEqual([]);
    expect(tag(event, 'started_at')).toEqual([
      ['started_at', String(NOW - 20)],
    ]);
  });

  it('concluded: requires a conclusion; non-concluded refuses one', () => {
    expect(() =>
      buildCiWorkflowProgress({ ...base, status: 'concluded' }, NOW)
    ).toThrow(/conclusion/);
    expect(() =>
      buildCiWorkflowProgress(
        { ...base, status: 'in_progress', conclusion: 'success' },
        NOW
      )
    ).toThrow(/conclusion/);
    const event = buildCiWorkflowProgress(
      {
        ...base,
        status: 'concluded',
        conclusion: 'timed_out',
        jobs: JOB_QUOTES,
      },
      NOW
    );
    expect(tag(event, 'conclusion')).toEqual([['conclusion', 'timed_out']]);
  });

  it('refuses an expiration beyond 30 minutes or not after created_at', () => {
    expect(() =>
      buildCiWorkflowProgress(
        { ...base, status: 'queued', expiresAt: NOW + 1801 },
        NOW
      )
    ).toThrow(/expiration/);
    expect(() =>
      buildCiWorkflowProgress(
        { ...base, status: 'queued', expiresAt: NOW },
        NOW
      )
    ).toThrow(/expiration/);
  });

  it('round-trips every status through parseCiWorkflowProgress', () => {
    const queued = signed(
      buildCiWorkflowProgress({ ...base, status: 'queued', queue: 1 }, NOW),
      { id: '51'.repeat(32) }
    );
    expect(parseCiWorkflowProgress(queued)).toEqual({
      eventId: '51'.repeat(32),
      pubkey: COORDINATOR,
      createdAt: NOW,
      trigger: PUSH_TRIGGER,
      runId: RUN_ID,
      status: 'queued',
      queue: 1,
      inProgress: [],
      queuedAt: NOW - 30,
      expiresAt: NOW + 1800,
      jobs: [],
    });
    const concluded = signed(
      buildCiWorkflowProgress(
        {
          ...base,
          status: 'concluded',
          conclusion: 'success',
          startedAt: NOW - 20,
          jobs: JOB_QUOTES,
        },
        NOW
      )
    );
    const parsed = parseCiWorkflowProgress(concluded);
    expect(parsed?.status).toBe('concluded');
    expect(parsed?.conclusion).toBe('success');
    expect(parsed?.provenance).toEqual(PROVENANCE);
    expect(parsed?.jobs).toEqual(JOB_QUOTES);
    expect(parsed?.startedAt).toBe(NOW - 20);
  });

  it('parser rejects a missing d, an unknown status, concluded without conclusion, or no expiration', () => {
    const good = signed(
      buildCiWorkflowProgress(
        { ...base, status: 'in_progress', inProgress: ['build'] },
        NOW
      )
    );
    expect(
      parseCiWorkflowProgress({
        ...good,
        tags: good.tags.filter((t) => t[0] !== 'd'),
      })
    ).toBeNull();
    expect(
      parseCiWorkflowProgress({
        ...good,
        tags: good.tags.map((t) =>
          t[0] === 'status' ? ['status', 'running'] : t
        ),
      })
    ).toBeNull();
    expect(
      parseCiWorkflowProgress({
        ...good,
        tags: good.tags.map((t) =>
          t[0] === 'status' ? ['status', 'concluded'] : t
        ),
      })
    ).toBeNull();
    expect(
      parseCiWorkflowProgress({
        ...good,
        tags: good.tags.filter((t) => t[0] !== 'expiration'),
      })
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// kind:39841 — Live Log Tail (rig's NIP-C1 extension, ADR-0002)
// ---------------------------------------------------------------------------

describe('Live Log Tail (39841)', () => {
  const base = {
    trigger: PUSH_TRIGGER,
    runId: RUN_ID,
    jobs: [
      { job: 'build', tail: 'compiling…\n', omitted: 4096 },
      { job: 'lint', tail: '', omitted: 0 },
    ],
    expiresAt: NOW + 1800,
  };

  it('is addressable on the run id and mirrors the run Progress tags', () => {
    const event = buildCiLiveLogTail(base, NOW);
    expect(event.kind).toBe(CI_LIVE_LOG_TAIL_KIND);
    expect(event.tags).toEqual([
      ...commonTriggerTags(PUSH_TRIGGER),
      ['d', RUN_ID],
      ['expiration', String(NOW + 1800)],
    ]);
    // The `d` is the run's Progress `d`, so holding a run addresses its tail.
    const progress = buildCiWorkflowProgress(
      {
        trigger: PUSH_TRIGGER,
        runId: RUN_ID,
        status: 'in_progress',
        jobs: [],
        expiresAt: NOW + 1800,
      },
      NOW
    );
    expect(tag(event, 'd')).toEqual(tag(progress, 'd'));
    expect(tag(event, 'a')).toEqual(tag(progress, 'a'));
    expect(tag(event, 'c')).toEqual(tag(progress, 'c'));
    expect(tag(event, 'w')).toEqual(tag(progress, 'w'));
    expect(tag(event, 'o')).toEqual(tag(progress, 'o'));
    expect(tag(event, 'r')).toEqual(tag(progress, 'r'));
  });

  it('round-trips jobs, tails, omitted counts and the runner channel', () => {
    const event = signed(
      buildCiLiveLogTail(
        { ...base, runner: { tail: 'pulling image\n', omitted: 12 } },
        NOW
      ),
      { id: '61'.repeat(32) }
    );
    expect(parseCiLiveLogTail(event)).toEqual({
      eventId: '61'.repeat(32),
      pubkey: COORDINATOR,
      createdAt: NOW,
      trigger: PUSH_TRIGGER,
      runId: RUN_ID,
      jobs: [
        { job: 'build', tail: 'compiling…\n', omitted: 4096 },
        { job: 'lint', tail: '', omitted: 0 },
      ],
      runner: { tail: 'pulling image\n', omitted: 12 },
      expiresAt: NOW + 1800,
    });
  });

  it('round-trips a run with no runner channel and no live jobs', () => {
    const parsed = parseCiLiveLogTail(
      signed(buildCiLiveLogTail({ ...base, jobs: [] }, NOW))
    );
    expect(parsed?.jobs).toEqual([]);
    expect(parsed?.runner).toBeUndefined();
  });

  it('refuses an expiration beyond 30 minutes or not after created_at', () => {
    expect(() =>
      buildCiLiveLogTail({ ...base, expiresAt: NOW + 1801 }, NOW)
    ).toThrow(/expiration/);
    expect(() => buildCiLiveLogTail({ ...base, expiresAt: NOW }, NOW)).toThrow(
      /expiration/
    );
    // A consumer applies the same bound, against the event's own created_at,
    // so no clock skew is involved.
    const good = signed(buildCiLiveLogTail(base, NOW));
    expect(
      parseCiLiveLogTail({
        ...good,
        tags: good.tags.map((t) =>
          t[0] === 'expiration' ? ['expiration', String(NOW + 1801)] : t
        ),
      })
    ).toBeNull();
  });

  it('refuses builder input the wire shape cannot carry', () => {
    expect(() => buildCiLiveLogTail({ ...base, runId: '' }, NOW)).toThrow(
      /run id/
    );
    expect(() =>
      buildCiLiveLogTail(
        { ...base, jobs: [{ job: 'build', tail: 'a', omitted: -1 }] },
        NOW
      )
    ).toThrow(/omitted/);
    expect(() =>
      buildCiLiveLogTail(
        {
          ...base,
          jobs: [
            { job: 'build', tail: 'a', omitted: 0 },
            { job: 'build', tail: 'b', omitted: 0 },
          ],
        },
        NOW
      )
    ).toThrow(/twice/);
    // The runner channel has its own slot; it is never a job.
    expect(() =>
      buildCiLiveLogTail(
        {
          ...base,
          jobs: [{ job: CI_RUNNER_CHANNEL_KEY, tail: 'a', omitted: 0 }],
        },
        NOW
      )
    ).toThrow(/runner channel/);
  });

  it('ignores fields it does not know, at every level', () => {
    const good = signed(buildCiLiveLogTail(base, NOW));
    const forward: NostrEvent = {
      ...good,
      content: JSON.stringify({
        jobs: [
          { job: 'build', tail: 'x', omitted: 1, steps: [{ name: 'run' }] },
        ],
        runner: { tail: 'y', omitted: 2, backend: 'act' },
        cursor: 'deadbeef',
      }),
      tags: [...good.tags, ['later-tag', 'value']],
    };
    expect(parseCiLiveLogTail(forward)).toMatchObject({
      runId: RUN_ID,
      jobs: [{ job: 'build', tail: 'x', omitted: 1 }],
      runner: { tail: 'y', omitted: 2 },
    });
  });

  it('defaults a missing omitted to zero', () => {
    const good = signed(buildCiLiveLogTail(base, NOW));
    const parsed = parseCiLiveLogTail({
      ...good,
      content: JSON.stringify({
        jobs: [{ job: 'build', tail: 'x' }],
        runner: { tail: 'y' },
      }),
    });
    expect(parsed?.jobs).toEqual([{ job: 'build', tail: 'x', omitted: 0 }]);
    expect(parsed?.runner).toEqual({ tail: 'y', omitted: 0 });
  });

  it('rejects a malformed event rather than half-parsing it', () => {
    const good = signed(buildCiLiveLogTail(base, NOW));
    const withContent = (content: unknown): NostrEvent => ({
      ...good,
      content: typeof content === 'string' ? content : JSON.stringify(content),
    });
    const cases: NostrEvent[] = [
      { ...good, kind: CI_WORKFLOW_PROGRESS_KIND },
      { ...good, tags: good.tags.filter((t) => t[0] !== 'd') },
      { ...good, tags: good.tags.map((t) => (t[0] === 'd' ? ['d', ''] : t)) },
      { ...good, tags: good.tags.filter((t) => t[0] !== 'expiration') },
      { ...good, tags: good.tags.filter((t) => t[0] !== 'a') },
      { ...good, tags: [...good.tags, ['d', 'run-0002']] },
      withContent(''),
      withContent('{not json'),
      withContent([{ job: 'build', tail: 'x', omitted: 0 }]),
      withContent({ runner: { tail: 'x', omitted: 0 } }),
      withContent({ jobs: 'build' }),
      withContent({ jobs: [{ tail: 'x', omitted: 0 }] }),
      withContent({ jobs: [{ job: '', tail: 'x', omitted: 0 }] }),
      withContent({ jobs: [{ job: 'build', omitted: 0 }] }),
      withContent({ jobs: [{ job: 'build', tail: 'x', omitted: -1 }] }),
      withContent({ jobs: [{ job: 'build', tail: 'x', omitted: 1.5 }] }),
      withContent({ jobs: [{ job: 'build', tail: 'x', omitted: '1' }] }),
      withContent({
        jobs: [
          { job: 'build', tail: 'x', omitted: 0 },
          { job: 'build', tail: 'y', omitted: 0 },
        ],
      }),
      withContent({
        jobs: [{ job: CI_RUNNER_CHANNEL_KEY, tail: 'x', omitted: 0 }],
      }),
      withContent({ jobs: [], runner: 'x' }),
      withContent({ jobs: [], runner: null }),
      withContent({ jobs: [], runner: { omitted: 0 } }),
    ];
    for (const ev of cases) {
      expect(parseCiLiveLogTail(ev)).toBeNull();
    }
  });
});

describe('live log tail budgets', () => {
  it('gives a lone job the full per-job tail and keeps an event relay-safe', () => {
    const one = liveLogTailBudget(1);
    expect(one).toBe(CI_LIVE_LOG_TAIL_JOB_BYTES);
    for (const entries of [1, 2, 3, 4, 7, 16, 64, 1000]) {
      const share = liveLogTailBudget(entries);
      expect(share).toBeGreaterThan(0);
      expect(share).toBeLessThanOrEqual(one);
      expect(share * entries).toBeLessThanOrEqual(CI_LIVE_LOG_TAIL_MAX_BYTES);
    }
    // Enough live entries and the budget is divided evenly, not per-job.
    expect(liveLogTailBudget(64)).toBeLessThan(one);
    expect(liveLogTailBudget(0)).toBe(one);
  });

  it('budgets one event per cadence tick plus the closing replacement', () => {
    const cadence = CI_LIVE_LOG_TAIL_INTERVAL_MS;
    expect(liveLogTailEventBudget(10 * cadence)).toBe(11);
    // A partial tick still costs an event.
    expect(liveLogTailEventBudget(10 * cadence + 1)).toBe(12);
    // A run that cannot tick at all still pays for its closing replacement.
    expect(liveLogTailEventBudget(0)).toBe(1);
    expect(liveLogTailEventBudget(-1)).toBe(1);
  });
});

describe('sliceLogTail', () => {
  it('takes the end of the output and counts what precedes it', () => {
    expect(sliceLogTail('abcdef', 4)).toEqual({ tail: 'cdef', omitted: 2 });
    expect(sliceLogTail('abc', 8)).toEqual({ tail: 'abc', omitted: 0 });
    expect(sliceLogTail('', 8)).toEqual({ tail: '', omitted: 0 });
  });

  it('counts bytes, not characters, and never splits one', () => {
    // '€' is three UTF-8 bytes; a 4-byte budget keeps one and drops the rest.
    const sliced = sliceLogTail('€€€', 4);
    expect(sliced.tail).toBe('€');
    expect(sliced.omitted).toBe(6);
    expect(Buffer.byteLength(sliced.tail, 'utf8')).toBeLessThanOrEqual(4);
  });
});
