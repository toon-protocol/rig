/**
 * rig-web's half of rig#155: proves the ngit wire fixtures captured for
 * rig#153 verify here too — the same events (byte-for-byte) that
 * `@toon-protocol/rig`'s own `ngit-fixtures.test.ts` checks, from this
 * package's own copy, `./ngit-wire.js`.
 *
 * That file is a self-contained COPY of
 * `packages/rig/src/nip34-fixtures/*.ts`, not an import of
 * `@toon-protocol/rig`: this package's typecheck gate
 * (`.sandcastle/gate/correctness.ts`, run by CI before `pnpm -r build`)
 * type checks rig-web before `@toon-protocol/rig` is built, and that
 * package resolves through its built `dist/` (a devDependency, not a
 * source reference) — importing it here would fail typecheck exactly the
 * way `tests/e2e/seed/**` already does today (excluded from this package's
 * `tsconfig.json` for that reason). See `./ngit-wire.ts`'s header for the
 * full rationale and prior art (`nip34-parsers.ts`, `gateway-preference.ts`).
 *
 * Pure crypto over in-repo data — no network access.
 *
 * `nostr-tools` is a `devDependency` here (package.json), matching how
 * `@toon-protocol/core`/`@toon-protocol/client` are already devDeps of this
 * package. It does NOT reopen the "no nostr-tools ... in the browser
 * bundle" concern `nip34-parsers.ts`'s header documents: that rationale is
 * about `src/web` PRODUCTION code reachable from `vite build`'s entry
 * graph, and this file — a `*.test.ts` — never enters it.
 */

import { verifyEvent } from 'nostr-tools/pure';
import { describe, expect, it } from 'vitest';

import {
  ALL_NGIT_FIXTURE_EVENTS,
  NGIT_ANNOUNCEMENT_WYRD,
  NGIT_ANNOUNCEMENT_WYRD_RELAY,
  NGIT_COMMENT_THREAD_NESTED_REPLY_ID,
  NGIT_COMMENT_THREAD_NESTED_REPLY_PARENT_ID,
  NGIT_STATE_NGIT,
  NGIT_STATUS_NGIT,
  NGIT_STATUS_NGIT_TARGET,
} from './ngit-wire.js';

describe('ngit wire fixtures verify in rig-web (rig#155)', () => {
  it('every fixture event has a valid id and signature', () => {
    for (const event of ALL_NGIT_FIXTURE_EVENTS) {
      expect(verifyEvent(event)).toBe(true);
    }
  });

  it('records the source relay and carries the expected kinds', () => {
    expect(NGIT_ANNOUNCEMENT_WYRD_RELAY).toBe('wss://relay.ngit.dev');
    expect(NGIT_ANNOUNCEMENT_WYRD.kind).toBe(30617);
    expect(NGIT_STATE_NGIT.kind).toBe(30618);
    expect(NGIT_STATUS_NGIT.kind).toBeGreaterThanOrEqual(1630);
    expect(NGIT_STATUS_NGIT.kind).toBeLessThanOrEqual(1633);
  });

  it('the announcement fixture carries a clone tag and role tags', () => {
    const tagNames = NGIT_ANNOUNCEMENT_WYRD.tags.map((t) => t[0]);
    expect(tagNames).toContain('clone');
    expect(tagNames).toContain('M');
    expect(tagNames).toContain('m');
  });

  it('the state fixture has peeled ^{} entries alongside plain refs', () => {
    const refNames = NGIT_STATE_NGIT.tags.map((t) => t[0]);
    expect(refNames.some((n) => n?.endsWith('^{}'))).toBe(true);
    expect(refNames).toContain('refs/heads/main');
    expect(refNames).toContain('HEAD');
  });

  it('the nested reply points at another comment, not the issue root', () => {
    expect(NGIT_COMMENT_THREAD_NESTED_REPLY_ID).not.toBe(
      NGIT_COMMENT_THREAD_NESTED_REPLY_PARENT_ID
    );
  });

  it('the status event targets the captured pull request, in marker form', () => {
    const eTag = NGIT_STATUS_NGIT.tags.find((t) => t[0] === 'e');
    expect(eTag?.[1]).toBe(NGIT_STATUS_NGIT_TARGET.id);
    expect(eTag?.[3]).toBe('root');
    expect(NGIT_STATUS_NGIT.tags.some((t) => t[0] === 'a')).toBe(true);
  });
});
