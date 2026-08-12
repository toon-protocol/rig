/**
 * Tests for #78 — operator notices printed once per `id` on a bootstrapping
 * command. `AnnouncedPeer` fixtures are constructed directly (not routed
 * through a real relay + `parseIlpPeerInfo`) because no published
 * `@toon-protocol/core` round-trips `notice` yet — see the module doc in
 * `./notice.ts` and `./network-bootstrap.ts`'s `AnnouncedPeer.info` widening
 * note for why. This is the same fixture-construction convention
 * `pickPaymentPeer`'s own tests (`./network-bootstrap.test.ts`) already use.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AnnouncedPeer } from './network-bootstrap.js';
import {
  NOTICE_STORE_FILENAME,
  NoticeStore,
  formatNoticeLines,
  normalizeNotice,
  showOperatorNoticeOnce,
  trustedNoticeFrom,
  type OperatorNotice,
} from './notice.js';

const SEED_PUBKEY = 'a1'.repeat(32);
const OTHER_PUBKEY = 'b2'.repeat(32);

function peerWithNotice(
  pubkey: string,
  notice: unknown,
  overrides: Partial<AnnouncedPeer['info']> = {}
): AnnouncedPeer {
  return {
    pubkey,
    info: {
      ilpAddress: 'g.proxy.relay',
      btpEndpoint: 'wss://proxy.devnet.toonprotocol.dev:443',
      assetCode: 'USDC',
      assetScale: 6,
      notice,
      ...overrides,
    },
    createdAt: 1000,
  };
}

const VALID_NOTICE = {
  id: 'notice-1',
  severity: 'info',
  summary: 'Devnet apex settlement identity rotates 2026-08-20.',
  url: 'https://example.com/docs/operators/2026-08-20-rotation.md',
};

// ---------------------------------------------------------------------------
// normalizeNotice
// ---------------------------------------------------------------------------

describe('normalizeNotice', () => {
  it('accepts a well-formed notice', () => {
    expect(normalizeNotice(VALID_NOTICE)).toEqual(VALID_NOTICE);
  });

  it('accepts action-required severity', () => {
    const notice = { ...VALID_NOTICE, severity: 'action-required' };
    expect(normalizeNotice(notice)).toEqual(notice);
  });

  it('degrades an unrecognized severity to info rather than rejecting', () => {
    const notice = { ...VALID_NOTICE, severity: 'critical' };
    expect(normalizeNotice(notice)).toEqual({
      ...VALID_NOTICE,
      severity: 'info',
    });
  });

  it('ignores unknown keys', () => {
    const notice = { ...VALID_NOTICE, somethingElse: 'ignored' };
    expect(normalizeNotice(notice)).toEqual(VALID_NOTICE);
  });

  it('drops a notice missing id/summary/url instead of throwing', () => {
    expect(
      normalizeNotice({ severity: 'info', summary: 'x', url: 'y' })
    ).toBeUndefined();
    expect(
      normalizeNotice({ id: 'a', severity: 'info', url: 'y' })
    ).toBeUndefined();
    expect(
      normalizeNotice({ id: 'a', severity: 'info', summary: 'x' })
    ).toBeUndefined();
    expect(normalizeNotice({ id: '', summary: 'x', url: 'y' })).toBeUndefined();
  });

  it('drops non-object / undefined / null values', () => {
    expect(normalizeNotice(undefined)).toBeUndefined();
    expect(normalizeNotice(null)).toBeUndefined();
    expect(normalizeNotice('not an object')).toBeUndefined();
    expect(normalizeNotice(42)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// trustedNoticeFrom
// ---------------------------------------------------------------------------

describe('trustedNoticeFrom', () => {
  it('returns undefined when there is no peer', () => {
    expect(trustedNoticeFrom(undefined, [SEED_PUBKEY])).toBeUndefined();
  });

  it('returns the notice from a genesis-seed announce', () => {
    const peer = peerWithNotice(SEED_PUBKEY, VALID_NOTICE);
    expect(trustedNoticeFrom(peer, [SEED_PUBKEY])).toEqual(VALID_NOTICE);
  });

  it('never prints a notice from an untrusted (non-seed) announcer', () => {
    const peer = peerWithNotice(OTHER_PUBKEY, VALID_NOTICE);
    expect(trustedNoticeFrom(peer, [SEED_PUBKEY])).toBeUndefined();
  });

  it('changes nothing when the trusted announce carries no notice', () => {
    const peer = peerWithNotice(SEED_PUBKEY, undefined);
    expect(trustedNoticeFrom(peer, [SEED_PUBKEY])).toBeUndefined();
  });

  it('ignores a malformed notice on an otherwise-trusted announce', () => {
    const peer = peerWithNotice(SEED_PUBKEY, { severity: 'info' });
    expect(trustedNoticeFrom(peer, [SEED_PUBKEY])).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// formatNoticeLines
// ---------------------------------------------------------------------------

describe('formatNoticeLines', () => {
  it('renders info as a single line with summary and url', () => {
    const notice: OperatorNotice = { ...VALID_NOTICE, severity: 'info' };
    const lines = formatNoticeLines(notice);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(notice.summary);
    expect(lines[0]).toContain(notice.url);
  });

  it('renders action-required as a visually distinct, multi-line block', () => {
    const notice: OperatorNotice = {
      ...VALID_NOTICE,
      severity: 'action-required',
    };
    const infoLines = formatNoticeLines({ ...notice, severity: 'info' });
    const actionLines = formatNoticeLines(notice);
    expect(actionLines.length).toBeGreaterThan(infoLines.length);
    expect(actionLines.some((l) => l.includes('ACTION REQUIRED'))).toBe(true);
    expect(actionLines.some((l) => l.includes(notice.summary))).toBe(true);
    expect(actionLines.some((l) => l.includes(notice.url))).toBe(true);
  });

  it('never renders anything beyond the url string itself (no fetch, no extra content)', () => {
    const notice: OperatorNotice = {
      ...VALID_NOTICE,
      severity: 'action-required',
    };
    const lines = formatNoticeLines(notice).join('\n');
    expect(lines).toContain(notice.url);
  });
});

// ---------------------------------------------------------------------------
// NoticeStore
// ---------------------------------------------------------------------------

describe('NoticeStore', () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rig-notice-store-'));
    path = join(dir, NOTICE_STORE_FILENAME);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reports unseen for an id it has never recorded', () => {
    const store = new NoticeStore({ path });
    expect(store.hasSeen('notice-1')).toBe(false);
  });

  it('never re-shows the same id, including across separate process runs', () => {
    const first = new NoticeStore({ path });
    first.markSeen('notice-1');
    // A fresh instance pointed at the same path emulates a new process.
    const second = new NoticeStore({ path });
    expect(second.hasSeen('notice-1')).toBe(true);
  });

  it('still shows a different id from the same store', () => {
    const store = new NoticeStore({ path });
    store.markSeen('notice-1');
    expect(store.hasSeen('notice-2')).toBe(false);
  });

  it('degrades a corrupt store file to "nothing seen" rather than crashing', () => {
    writeFileSync(path, 'not-json{');
    const store = new NoticeStore({ path });
    expect(() => store.hasSeen('notice-1')).not.toThrow();
    expect(store.hasSeen('notice-1')).toBe(false);
  });

  it('recovers a corrupt file on the next write (no permanent silent suppression)', () => {
    writeFileSync(path, 'not-json{');
    const store = new NoticeStore({ path });
    store.markSeen('notice-1');
    const fresh = new NoticeStore({ path });
    expect(fresh.hasSeen('notice-1')).toBe(true);
  });

  it('degrades a structurally-invalid store file to "nothing seen"', () => {
    writeFileSync(path, JSON.stringify({ version: 1, seenIds: [42, true] }));
    const store = new NoticeStore({ path });
    expect(store.hasSeen('notice-1')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// showOperatorNoticeOnce (end-to-end wiring, no relay involved)
// ---------------------------------------------------------------------------

describe('showOperatorNoticeOnce', () => {
  let dir: string;
  let path: string;
  let warnings: string[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rig-notice-show-'));
    path = join(dir, NOTICE_STORE_FILENAME);
    warnings = [];
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const warn = (line: string) => warnings.push(line);

  it('prints a trusted announce notice on a bootstrapping command', () => {
    const store = new NoticeStore({ path });
    const peer = peerWithNotice(SEED_PUBKEY, VALID_NOTICE);
    showOperatorNoticeOnce(peer, [SEED_PUBKEY], store, warn);
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings.join('\n')).toContain(VALID_NOTICE.summary);
  });

  it('never prints the same id twice, even across separate command invocations', () => {
    const peer = peerWithNotice(SEED_PUBKEY, VALID_NOTICE);
    showOperatorNoticeOnce(
      peer,
      [SEED_PUBKEY],
      new NoticeStore({ path }),
      warn
    );
    expect(warnings.length).toBeGreaterThan(0);

    warnings = [];
    // Fresh store instance — a separate process run against the same file.
    showOperatorNoticeOnce(
      peer,
      [SEED_PUBKEY],
      new NoticeStore({ path }),
      warn
    );
    expect(warnings).toEqual([]);
  });

  it('prints a different id from the same announcer', () => {
    const store = new NoticeStore({ path });
    showOperatorNoticeOnce(
      peerWithNotice(SEED_PUBKEY, VALID_NOTICE),
      [SEED_PUBKEY],
      store,
      warn
    );
    warnings = [];
    showOperatorNoticeOnce(
      peerWithNotice(SEED_PUBKEY, { ...VALID_NOTICE, id: 'notice-2' }),
      [SEED_PUBKEY],
      store,
      warn
    );
    expect(warnings.length).toBeGreaterThan(0);
  });

  it('never prints a notice from an untrusted announcer', () => {
    const store = new NoticeStore({ path });
    showOperatorNoticeOnce(
      peerWithNotice(OTHER_PUBKEY, VALID_NOTICE),
      [SEED_PUBKEY],
      store,
      warn
    );
    expect(warnings).toEqual([]);
  });

  it('is a no-op (no crash, no output) when there is no announce at all', () => {
    const store = new NoticeStore({ path });
    expect(() =>
      showOperatorNoticeOnce(undefined, [SEED_PUBKEY], store, warn)
    ).not.toThrow();
    expect(warnings).toEqual([]);
  });

  it('changes nothing when the announce has no notice', () => {
    const store = new NoticeStore({ path });
    showOperatorNoticeOnce(
      peerWithNotice(SEED_PUBKEY, undefined),
      [SEED_PUBKEY],
      store,
      warn
    );
    expect(warnings).toEqual([]);
  });

  it('is unaffected by a malformed notice — bootstrap output stays clean', () => {
    const store = new NoticeStore({ path });
    expect(() =>
      showOperatorNoticeOnce(
        peerWithNotice(SEED_PUBKEY, { id: 123, summary: 'bad' }),
        [SEED_PUBKEY],
        store,
        warn
      )
    ).not.toThrow();
    expect(warnings).toEqual([]);
  });
});
