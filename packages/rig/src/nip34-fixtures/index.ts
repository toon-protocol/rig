/**
 * Real NIP-34 wire fixtures captured from `wss://relay.ngit.dev` (rig#155,
 * spec rig#153). Conformance is tested against what the incumbent (ngit)
 * actually publishes, not against our reading of the NIP.
 *
 * Every event here is committed exactly as the relay sent it — no edited
 * tags, no re-serialization — so `ngit-fixtures.test.ts` can verify each
 * one's id and signature. Both `@toon-protocol/rig` and
 * `@toon-protocol/rig-web` tests import these fixtures from this module (the
 * latter via the `@toon-protocol/rig` package, a workspace dependency it
 * already uses for other wire-level test fixtures — see
 * `packages/rig-web/tests/e2e/seed/lib/event-builders.ts`).
 *
 * Re-capture with `scripts/capture-ngit-fixtures.mjs` (repo root).
 */

export {
  NGIT_ANNOUNCEMENT_WYRD,
  NGIT_ANNOUNCEMENT_WYRD_CAPTURED_AT,
  NGIT_ANNOUNCEMENT_WYRD_EVENT_ID,
  NGIT_ANNOUNCEMENT_WYRD_RELAY,
} from './ngit-announcement-wyrd.js';

export {
  NGIT_STATE_NGIT,
  NGIT_STATE_NGIT_CAPTURED_AT,
  NGIT_STATE_NGIT_EVENT_ID,
  NGIT_STATE_NGIT_RELAY,
} from './ngit-state-ngit.js';

export {
  NGIT_COMMENT_THREAD_COMMENTS,
  NGIT_COMMENT_THREAD_CAPTURED_AT,
  NGIT_COMMENT_THREAD_COMMENT_EVENT_IDS,
  NGIT_COMMENT_THREAD_NESTED_REPLY_ID,
  NGIT_COMMENT_THREAD_NESTED_REPLY_PARENT_ID,
  NGIT_COMMENT_THREAD_RELAY,
  NGIT_COMMENT_THREAD_ROOT,
  NGIT_COMMENT_THREAD_ROOT_EVENT_ID,
} from './ngit-comment-thread-hydrusui.js';

export {
  NGIT_STATUS_NGIT,
  NGIT_STATUS_NGIT_CAPTURED_AT,
  NGIT_STATUS_NGIT_EVENT_ID,
  NGIT_STATUS_NGIT_RELAY,
  NGIT_STATUS_NGIT_TARGET,
  NGIT_STATUS_NGIT_TARGET_EVENT_ID,
} from './ngit-status-ngit.js';

import type { NostrEvent } from '../remote-state.js';
import { NGIT_ANNOUNCEMENT_WYRD } from './ngit-announcement-wyrd.js';
import {
  NGIT_COMMENT_THREAD_COMMENTS,
  NGIT_COMMENT_THREAD_ROOT,
} from './ngit-comment-thread-hydrusui.js';
import { NGIT_STATE_NGIT } from './ngit-state-ngit.js';
import {
  NGIT_STATUS_NGIT,
  NGIT_STATUS_NGIT_TARGET,
} from './ngit-status-ngit.js';

/** Every captured event, flattened — for the id/signature verification test. */
export const ALL_NGIT_FIXTURE_EVENTS: NostrEvent[] = [
  NGIT_ANNOUNCEMENT_WYRD,
  NGIT_STATE_NGIT,
  NGIT_COMMENT_THREAD_ROOT,
  ...NGIT_COMMENT_THREAD_COMMENTS,
  NGIT_STATUS_NGIT,
  NGIT_STATUS_NGIT_TARGET,
];
