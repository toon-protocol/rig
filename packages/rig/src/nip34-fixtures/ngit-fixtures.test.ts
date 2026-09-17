/**
 * Verifies every ngit wire fixture's id and signature (rig#155).
 *
 * A fixture is only useful as a conformance oracle if it is provably what
 * the relay actually sent: this test recomputes each event's id (NIP-01
 * canonical serialization + sha256) and checks its schnorr signature over
 * that id, so a corrupted or hand-edited fixture fails the gate instead of
 * silently poisoning the read-path tests that consume it. Pure crypto over
 * in-repo data — no network access.
 */

import { verifyEvent } from 'nostr-tools/pure';
import { describe, expect, it } from 'vitest';

import { ALL_NGIT_FIXTURE_EVENTS } from './index.js';

describe('ngit wire fixtures (rig#155)', () => {
  it('captured at least one fixture of each kind #153 asks for', () => {
    const kinds = new Set(ALL_NGIT_FIXTURE_EVENTS.map((e) => e.kind));
    expect(kinds.has(30617)).toBe(true); // repository announcement
    expect(kinds.has(30618)).toBe(true); // repository state
    expect(kinds.has(1621)).toBe(true); // issue (comment thread root)
    expect(kinds.has(1111)).toBe(true); // NIP-22 comment
    expect([1630, 1631, 1632, 1633].some((k) => kinds.has(k))).toBe(true); // status
  });

  for (const event of ALL_NGIT_FIXTURE_EVENTS) {
    it(`event ${event.id} (kind ${event.kind}) has a valid id and signature`, () => {
      expect(verifyEvent(event)).toBe(true);
    });
  }
});
