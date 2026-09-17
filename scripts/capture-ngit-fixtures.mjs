#!/usr/bin/env node
/**
 * Re-capture tool for the ngit wire fixtures (rig#155, spec rig#153).
 *
 * The fixtures committed under `packages/rig/src/nip34-fixtures/` are real
 * events pulled from `wss://relay.ngit.dev` and hand-selected to satisfy
 * #153's Testing Decisions (a kind:30617 with role tags + `clone`, a
 * kind:30618 with peeled `^{}` entries, a kind:1111 thread with a nested
 * reply, a kind:1630-1633 status in NIP-10 marker form). Fixtures are
 * static — nothing in the default test gate touches the network — so this
 * script is a one-off capture tool, not part of any build or test.
 *
 * Usage:
 *   node scripts/capture-ngit-fixtures.mjs                # run every query, print candidates
 *   node scripts/capture-ngit-fixtures.mjs announcements   # just the kind:30617 scan
 *   node scripts/capture-ngit-fixtures.mjs state           # just ngit's own kind:30618
 *   node scripts/capture-ngit-fixtures.mjs comments        # just the kind:1111 thread scan
 *   node scripts/capture-ngit-fixtures.mjs statuses        # just the kind:1630-1633 scan
 *   RELAY=wss://other.relay node scripts/capture-ngit-fixtures.mjs
 *
 * Each mode prints EVENT JSON (or, for the scans, a shortlist of candidate
 * ids) to stdout. Selecting a fixture from a scan and writing it into a
 * `packages/rig/src/nip34-fixtures/*.ts` module (or re-fetching it by id
 * with `--ids`) is a manual step: which candidate best demonstrates the
 * required shape is a judgement call, not something to automate away.
 *
 * Requires Node 22+ (global `WebSocket`). No dependencies.
 */

const RELAY = process.env.RELAY || 'wss://relay.ngit.dev';

/** ngit's own canonical repo (npub15qydau2hjma6ngxkl2cyar74wzyjshvl65za5k5rl69264ar2exs5cyejr). */
const NGIT_OWN_REPO_PUBKEY =
  'a008def15796fba9a0d6fab04e8fd57089285d9fd505da5a83fe8aad57a3564d';
const NGIT_OWN_REPO_D = 'ngit';

/** One-shot NIP-01 REQ: collect EVENTs until EOSE or timeout, then CLOSE. */
function queryRelay(relay, filter, timeoutMs = 12000) {
  return new Promise((resolvePromise) => {
    const ws = new WebSocket(relay);
    const events = [];
    const subId = 'cap' + Math.random().toString(36).slice(2, 8);
    let done = false;

    function finish() {
      if (done) return;
      done = true;
      try {
        ws.send(JSON.stringify(['CLOSE', subId]));
      } catch {
        /* ignore */
      }
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      resolvePromise(events);
    }

    ws.onopen = () => ws.send(JSON.stringify(['REQ', subId, filter]));
    ws.onmessage = (msg) => {
      let data;
      try {
        data = JSON.parse(msg.data);
      } catch {
        return;
      }
      if (data[0] === 'EVENT' && data[1] === subId) events.push(data[2]);
      else if (data[0] === 'EOSE' && data[1] === subId) finish();
      else if (data[0] === 'CLOSED' && data[1] === subId) finish();
    };
    ws.onerror = () => finish();
    setTimeout(finish, timeoutMs);
  });
}

function tag(event, name) {
  return event.tags.find((t) => t[0] === name);
}

async function scanAnnouncements() {
  console.error(`Scanning kind:30617 on ${RELAY} for clone + role tags (M/m/o)...`);
  // relay.ngit.dev has thousands of announcements; two pages of 500 is
  // enough to find real examples of the unmerged nips PR #2324 role tags.
  const page1 = await queryRelay(RELAY, { kinds: [30617], limit: 500 });
  const oldest = Math.min(...page1.map((e) => e.created_at));
  const page2 = await queryRelay(RELAY, {
    kinds: [30617],
    limit: 500,
    until: oldest,
  });
  const seen = new Map();
  for (const e of [...page1, ...page2]) seen.set(e.id, e);
  const events = [...seen.values()];

  const withRoleAndClone = events.filter((e) => {
    const names = new Set(e.tags.map((t) => t[0]));
    return (names.has('M') || names.has('m') || names.has('o')) && names.has('clone');
  });

  console.log(
    JSON.stringify(
      withRoleAndClone.map((e) => ({
        id: e.id,
        pubkey: e.pubkey,
        d: tag(e, 'd')?.[1],
        roleTags: e.tags.filter((t) => ['M', 'm', 'o'].includes(t[0])).map((t) => t[0]),
      })),
      null,
      2
    )
  );
  console.error(`${withRoleAndClone.length} candidate(s) out of ${events.length} scanned.`);
}

async function fetchState() {
  console.error(`Fetching kind:30618 for ngit's own repo on ${RELAY}...`);
  const events = await queryRelay(RELAY, {
    kinds: [30618],
    authors: [NGIT_OWN_REPO_PUBKEY],
    '#d': [NGIT_OWN_REPO_D],
  });
  console.log(JSON.stringify(events, null, 2));
}

async function scanComments() {
  console.error(`Scanning kind:1111 on ${RELAY} for a thread with a nested reply...`);
  const events = await queryRelay(RELAY, { kinds: [1111], limit: 200 });
  const byRoot = new Map();
  for (const e of events) {
    const E = tag(e, 'E');
    if (!E) continue;
    if (!byRoot.has(E[1])) byRoot.set(E[1], []);
    byRoot.get(E[1]).push(e);
  }
  const candidates = [];
  for (const [rootId, comments] of byRoot) {
    const K = tag(comments[0], 'K');
    if (!K || !['1621', '1617'].includes(K[1])) continue;
    const nested = comments.filter((c) => {
      const e = tag(c, 'e');
      return e && e[1] !== rootId;
    });
    if (nested.length > 0) {
      candidates.push({
        rootId,
        rootKind: K[1],
        commentCount: comments.length,
        nestedReplyIds: nested.map((c) => c.id),
      });
    }
  }
  console.log(JSON.stringify(candidates, null, 2));
  console.error(`${candidates.length} candidate thread(s) out of ${events.length} comments scanned.`);
}

async function scanStatuses() {
  console.error(`Scanning kind:1630-1633 on ${RELAY} for NIP-10 marker form...`);
  const events = await queryRelay(RELAY, {
    kinds: [1630, 1631, 1632, 1633],
    limit: 300,
  });
  const markerForm = events.filter((e) => {
    const e0 = tag(e, 'e');
    return e0 && e0.length >= 4 && e0[3];
  });
  console.log(
    JSON.stringify(
      markerForm.map((e) => ({
        id: e.id,
        kind: e.kind,
        targetId: tag(e, 'e')[1],
        marker: tag(e, 'e')[3],
        hasATag: Boolean(tag(e, 'a')),
      })),
      null,
      2
    )
  );
  console.error(`${markerForm.length} marker-form candidate(s) out of ${events.length} scanned.`);
}

async function fetchByIds(ids) {
  const events = await queryRelay(RELAY, { ids });
  console.log(JSON.stringify(events, null, 2));
}

async function main() {
  const [mode, ...rest] = process.argv.slice(2);
  if (mode === '--ids') {
    await fetchByIds(rest);
    return;
  }
  switch (mode) {
    case 'announcements':
      await scanAnnouncements();
      break;
    case 'state':
      await fetchState();
      break;
    case 'comments':
      await scanComments();
      break;
    case 'statuses':
      await scanStatuses();
      break;
    default:
      await scanAnnouncements();
      await fetchState();
      await scanComments();
      await scanStatuses();
      break;
  }
}

main().then(() => process.exit(0));
