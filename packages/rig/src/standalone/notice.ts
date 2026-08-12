/**
 * Operator notices (#78, part of toon-protocol/toon-meta#252): a kind:10032
 * announce's optional `notice` field (toon-protocol/toon#183) is rig's one
 * delivery channel to a human running this client — printed once per `id`,
 * ever, never once per run. Only an announce authored by a committed
 * genesis-seed pubkey (`genesisSeedPubkeys()` in `./network-bootstrap.ts`)
 * is trusted: anyone can publish a kind:10032, so an untrusted announcer's
 * notice — and its operator-controlled `url` — is never shown or fetched.
 *
 * BLOCKED ON A PUBLISH, NOT ON THIS TICKET. `IlpPeerInfo.notice` already
 * exists on `@toon-protocol/core`'s `main` (toon#183, closed), but no
 * published core version carries it yet: toon#184 (closed) landed the
 * release changeset but not the actual `npm publish` — registry `latest`
 * was still 3.3.0 as of 2026-08-12, and `parseIlpPeerInfo` there builds its
 * result field by field, so an announce's `notice` is dropped on the way
 * in. `AnnouncedPeer.info.notice` is therefore always `undefined` today
 * (see the widening note in `./network-bootstrap.ts`) and nothing below can
 * be exercised end-to-end against a real relay yet — the tests construct
 * `AnnouncedPeer` fixtures directly, the same way `pickPaymentPeer`'s own
 * tests do. Turning it on once core publishes takes a dependency bump
 * (`pnpm update @toon-protocol/core`; the `^3.2.0` range already accepts a
 * 3.4.x, but the lockfile pins 3.2.0) and no rig code changes.
 *
 * Seen-notice ids persist next to rig's other client state under
 * `TOON_CLIENT_HOME`, sibling to the channel map (`rig-channels.json`) and
 * topology cache (`rig-topology-cache.json`) — see `NoticeStore` below.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AnnouncedPeer } from './network-bootstrap.js';

/** Notice-store filename under the shared client state dir (`TOON_CLIENT_HOME`). */
export const NOTICE_STORE_FILENAME = 'rig-seen-notices.json';

/** A validated, normalized `IlpPeerInfo.notice` (toon#183). */
export interface OperatorNotice {
  id: string;
  severity: 'info' | 'action-required';
  summary: string;
  url: string;
}

/**
 * Validate + normalize a raw `notice` value. Missing/wrong-typed
 * `id`/`summary`/`url` drops the notice entirely (`undefined`, and bootstrap
 * proceeds unaffected); an unrecognized `severity` degrades to `'info'`
 * rather than being rejected — mirrors core's own lenient-parsing contract
 * (toon#183) so an operator's typo can never cost this client its ability
 * to route. Unknown keys are ignored.
 */
export function normalizeNotice(value: unknown): OperatorNotice | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { id, severity, summary, url } = value as Record<string, unknown>;
  if (typeof id !== 'string' || id.length === 0) return undefined;
  if (typeof summary !== 'string' || summary.length === 0) return undefined;
  if (typeof url !== 'string' || url.length === 0) return undefined;
  return {
    id,
    summary,
    url,
    severity: severity === 'action-required' ? 'action-required' : 'info',
  };
}

/**
 * The notice to trust from a bootstrap's chosen payment peer, or
 * `undefined`. `peer` is expected to be `pickPaymentPeer`'s result, which
 * already prefers an announce authored by a genesis-seed pubkey over any
 * other — so this is exactly "is the payment peer we bootstrapped against a
 * seed peer", not a second, independent selection (per the issue: reuse the
 * existing preference rather than inventing a new one). An announce from
 * any other pubkey never reaches `normalizeNotice`, regardless of what its
 * `notice` field contains.
 */
export function trustedNoticeFrom(
  peer: AnnouncedPeer | undefined,
  seedPubkeys: readonly string[]
): OperatorNotice | undefined {
  if (!peer || !seedPubkeys.includes(peer.pubkey)) return undefined;
  return normalizeNotice(peer.info.notice);
}

const ACTION_REQUIRED_BORDER = '='.repeat(70);

/**
 * Render a notice for stderr. `url` is printed, never fetched — rendering
 * is the full extent of what rig does with it. `action-required` gets a
 * bordered, blank-line-padded block so it cannot be mistaken for routine
 * bootstrap chatter or scrolled past unnoticed; `info` stays a single line.
 */
export function formatNoticeLines(notice: OperatorNotice): string[] {
  if (notice.severity === 'action-required') {
    return [
      '',
      ACTION_REQUIRED_BORDER,
      `rig: ACTION REQUIRED — ${notice.summary}`,
      `rig: ${notice.url}`,
      ACTION_REQUIRED_BORDER,
      '',
    ];
  }
  return [`rig: notice — ${notice.summary} (${notice.url})`];
}

interface NoticeStoreFile {
  version: 1;
  seenIds: string[];
}

/**
 * File-backed set of notice ids already shown (#78's "once per id, ever,
 * across separate process runs"). Mirrors `TopologyCache`'s best-effort
 * contract (`./topology-cache.ts`): a corrupt or unreadable file degrades to
 * "nothing seen" — the notice reprints — rather than a crash or, worse,
 * permanent silent suppression from a file the store can no longer read.
 */
export class NoticeStore {
  private readonly path: string;

  constructor(options: { path: string }) {
    this.path = options.path;
  }

  hasSeen(id: string): boolean {
    return this.readFile().seenIds.includes(id);
  }

  /** Best-effort; a failed write just means the notice reprints next run. */
  markSeen(id: string): void {
    const file = this.readFile();
    if (file.seenIds.includes(id)) return;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(
        this.path,
        JSON.stringify(
          {
            version: 1,
            seenIds: [...file.seenIds, id],
          } satisfies NoticeStoreFile,
          null,
          2
        ),
        { mode: 0o600 }
      );
    } catch {
      // Best-effort — see module doc.
    }
  }

  private readFile(): NoticeStoreFile {
    const empty: NoticeStoreFile = { version: 1, seenIds: [] };
    let raw: string;
    try {
      raw = readFileSync(this.path, 'utf8');
    } catch {
      return empty;
    }
    try {
      const parsed = JSON.parse(raw) as NoticeStoreFile;
      if (
        typeof parsed !== 'object' ||
        parsed === null ||
        parsed.version !== 1 ||
        !Array.isArray(parsed.seenIds) ||
        !parsed.seenIds.every((x) => typeof x === 'string')
      ) {
        return empty;
      }
      return parsed;
    } catch {
      return empty; // corrupt store = "nothing seen", never an error
    }
  }
}

/**
 * Show `peer`'s notice on stderr (via `warn`) and persist its id — but only
 * once, ever, and only when `peer` is a trusted (genesis-seed) announce. A
 * no-op when there is no peer, no notice, an untrusted announcer, or the id
 * has already been shown. Called from every bootstrapping command's single
 * announce-discovery point (`createStandaloneContext`), never on its own —
 * it costs no extra round trip beyond the discovery that already happened.
 */
export function showOperatorNoticeOnce(
  peer: AnnouncedPeer | undefined,
  seedPubkeys: readonly string[],
  store: NoticeStore,
  warn: (line: string) => void
): void {
  const notice = trustedNoticeFrom(peer, seedPubkeys);
  if (!notice || store.hasSeen(notice.id)) return;
  for (const line of formatNoticeLines(notice)) warn(line);
  store.markSeen(notice.id);
}
