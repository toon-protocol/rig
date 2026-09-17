/**
 * `rig refresh` (#158) — republish a repo's kind:30617 announcement with NO
 * field edit, purely to bring its NIP-34 conformance tags up to date.
 *
 * `rig push` announces a repo ONCE and never republishes: a replaceable-event
 * republish costs an event fee, and an owner must never be charged a fee they
 * did not confirm. So a repo announced before #158 — or one whose relay or
 * viewer URL has since changed — has no way to gain `relays`, `web` and the
 * `euc` fork-identity tag except through an owner-initiated republish.
 * `rig maintainers` and `rig payout` backfill them as a side effect of the
 * edit they are already making; this command is the same backfill with
 * nothing else attached.
 *
 * It is deliberately the smallest possible command:
 *
 *   - owner-only, for the same reason `rig maintainers add` is — only the
 *     owner's announcement is authoritative, so a non-owner republish would
 *     write that identity's own (ignored) announcement and pay for it;
 *   - it shows the exact tags it would add, change or drop before the confirm
 *     gate, so the owner sees what the fee buys;
 *   - it publishes NOTHING and pays NOTHING when the republish would change
 *     no tag — a no-op refresh is free, and says so;
 *   - same `--json` contract as `rig maintainers`: without `--yes` the
 *     envelope is a pure estimate and nothing is published.
 *
 * Every announcement it builds goes through `amendRepoAnnouncement`, so tags
 * rig does not model ride along verbatim (#154).
 */

import { parseArgs } from 'node:util';
import {
  amendRepoAnnouncement,
  conformanceEdits,
  describeAnnouncementDiff,
  diffAnnouncementTags,
} from '../repo-announcement.js';
import { fetchRemoteState } from '../remote-state.js';
import { serializeEventReceipt, type GitEventResponse } from '../routes.js';
import type { EventCommandDeps } from './events.js';
import { emitCliError, InvalidRelayUrlError } from './errors.js';
import {
  defaultLoadStandalone,
  identityReport,
  type IdentityReport,
} from './push.js';
import { feeLabel } from './render.js';
import { singleRelayRefusal } from './remote.js';
import {
  conformanceFactsFor,
  pickRepoCommandFlags,
  REPO_COMMAND_OPTIONS,
  resolveRepoContext,
  WS_URL_RE,
  type RepoCommandFlags,
} from './repo-command.js';
import type { StandaloneContext } from './standalone-context.js';

export const REFRESH_USAGE = `Usage: rig refresh [options]

Republish this repo's kind:30617 announcement with no field edit, refreshing
its NIP-34 conformance tags (#158) so other clients can find and group it:

  relays          the relay this repo publishes to — where its issues,
                  patches and state live
  web             the repo's rig-web viewer URL
  r <sha> euc     the earliest unique commit: the repo's fork identity.
                  Written only if the announcement has none — once declared it
                  never changes, so forks stay grouped

Every other tag rides along verbatim, including tags written by other NIP-34
clients. rig never writes a \`clone\` tag (it has no git-clonable URL) and never
removes one.

PAID: republishing the kind:30617 costs one event fee (permanent,
non-refundable). Nothing is published and nothing is paid when no tag would
change. Must run under the repo OWNER's identity — only the owner's
announcement is authoritative.

Options:
  --repo-id <id>       repository id / NIP-34 d-tag (default: git config)
  --owner <pubkey>     repository owner (npub or hex; default: git config)
  --remote <name>      publish/read via this configured git remote (default: origin)
  --relay <url>        ad-hoc relay override (exactly one)
  --yes                skip the fee confirmation (required when not a TTY)
  --json               machine-readable envelope
  -h, --help           show this help`;

interface RefreshJsonOutput {
  command: 'refresh';
  repoAddr: { ownerPubkey: string; repoId: string };
  identity: IdentityReport;
  executed: boolean;
  /** `null` when nothing would change — a no-op refresh costs nothing. */
  feeEstimate: string | null;
  /** Tags the republish would add, and tags it would drop. */
  changes: { added: string[][]; removed: string[][] };
  result?: GitEventResponse;
  hint?: string;
}

/** Run `rig refresh …`; returns the process exit code. */
export async function runRefresh(
  args: string[],
  deps: EventCommandDeps
): Promise<number> {
  const { io } = deps;

  let flags: RepoCommandFlags;
  try {
    const { values, positionals } = parseArgs({
      args,
      options: REPO_COMMAND_OPTIONS,
      allowPositionals: true,
    });
    flags = pickRepoCommandFlags(values);
    if (flags.help) {
      io.out(REFRESH_USAGE);
      return 0;
    }
    if (positionals.length > 0) {
      throw new Error('rig refresh takes no positional arguments');
    }
  } catch (err) {
    io.err(err instanceof Error ? err.message : String(err));
    io.err(REFRESH_USAGE);
    return 2;
  }

  let standaloneCtx: StandaloneContext | undefined;
  try {
    const ctx = await resolveRepoContext(flags, deps);
    // A single relay for a paid publish (mirrors maintainers/payout/push).
    if (ctx.relays.length > 1) {
      io.err(singleRelayRefusal(ctx.resolved, 'Nothing was published or paid.'));
      return 1;
    }
    const relayUrl = ctx.relays[0];
    if (relayUrl === undefined || !WS_URL_RE.test(relayUrl)) {
      throw new InvalidRelayUrlError(
        relayUrl ?? '',
        'a paid publish needs a ws:// or wss:// relay'
      );
    }

    // Standalone only: the daemon has no announcement route.
    const load = deps.loadStandalone ?? defaultLoadStandalone;
    standaloneCtx = await load({
      env: deps.env,
      cwd: deps.cwd,
      warn: (line) => io.err(line),
      relayUrl,
    });
    const identity = identityReport(standaloneCtx);

    if (identity.pubkey.toLowerCase() !== ctx.owner.toLowerCase()) {
      io.err(
        `rig: only the repo owner (${ctx.owner.slice(0, 8)}…) can refresh the ` +
          `announcement — the active identity is ${identity.pubkey.slice(0, 8)}…. ` +
          'A non-owner republish would write your own (ignored) announcement. ' +
          'Nothing was published or paid.'
      );
      return 1;
    }

    const remote = await fetchRemoteState({
      relayUrls: [relayUrl],
      ownerPubkey: ctx.owner,
      repoId: ctx.repoId,
      ...(deps.webSocketFactory
        ? { webSocketFactory: deps.webSocketFactory }
        : {}),
    });
    // Refuse on an unannounced repo, exactly as maintainers/payout do: a
    // republish here would MINT a phantom kind:30617 with a placeholder name,
    // for real money, and `rig push` would then never announce the real one.
    if (!remote.announced) {
      io.err(
        `rig: 30617:${ctx.owner.slice(0, 8)}…:${ctx.repoId} has no announcement ` +
          'yet — run `rig push` to publish the repo (with its real ' +
          'name/description) before refreshing it. Nothing was published or paid.'
      );
      return 1;
    }

    // No field edit: the ONLY changes are the conformance backfill (#158).
    const facts = await conformanceFactsFor({ ctx, relayUrl, deps });
    const event = amendRepoAnnouncement(remote.announceEvent, {
      repoId: ctx.repoId,
      ...conformanceEdits(remote.announceEvent, facts),
    });
    const diff = diffAnnouncementTags(remote.announceEvent, event);

    // Nothing to change → nothing to publish, and nothing to pay for.
    if (diff.unchanged) {
      const changes = { added: diff.added, removed: diff.removed };
      if (flags.json) {
        io.emitJson({
          command: 'refresh',
          repoAddr: { ownerPubkey: ctx.owner, repoId: ctx.repoId },
          identity,
          executed: false,
          feeEstimate: null,
          changes,
          hint: 'announcement is already up to date — nothing published, nothing paid',
        } satisfies RefreshJsonOutput);
        return 0;
      }
      io.out(
        `Announcement 30617:${ctx.owner}:${ctx.repoId} is already up to date — ` +
          'nothing to do (not published, nothing paid).'
      );
      return 0;
    }

    const fee = (await standaloneCtx.publisher.getFeeRates()).eventFee.toString();
    const changes = { added: diff.added, removed: diff.removed };

    // ── Confirm gate ────────────────────────────────────────────────────────
    if (!flags.json) {
      io.out('Republish kind:30617 announcement (refresh)');
      io.out(`Repo: 30617:${ctx.owner}:${ctx.repoId}`);
      io.out('Tags changed:');
      for (const line of describeAnnouncementDiff(diff)) io.out(line);
      io.out(`Fee: ${feeLabel(fee)}. Writes are permanent and non-refundable.`);
    }
    if (!flags.yes) {
      if (flags.json) {
        io.emitJson({
          command: 'refresh',
          repoAddr: { ownerPubkey: ctx.owner, repoId: ctx.repoId },
          identity,
          executed: false,
          feeEstimate: fee,
          changes,
          hint: 'estimate only — re-run with --yes to publish (permanent, non-refundable)',
        } satisfies RefreshJsonOutput);
        return 0;
      }
      if (!io.isInteractive) {
        io.err(
          'refusing to spend channel funds without confirmation in a non-interactive ' +
            'session — re-run with --yes (or use --json for an estimate)'
        );
        return 1;
      }
      const proceed = await io.confirm(
        `Proceed with paid republish (${feeLabel(fee)})? [y/N] `
      );
      if (!proceed) {
        io.err('aborted — nothing was published.');
        return 1;
      }
    }

    // ── Execute ─────────────────────────────────────────────────────────────
    const receipt = await standaloneCtx.publisher.publishEvent(event, [
      relayUrl,
    ]);
    const result = serializeEventReceipt(event.kind, receipt);

    if (flags.json) {
      io.emitJson({
        command: 'refresh',
        repoAddr: { ownerPubkey: ctx.owner, repoId: ctx.repoId },
        identity,
        executed: true,
        feeEstimate: fee,
        changes,
        result,
      } satisfies RefreshJsonOutput);
    } else {
      io.out(
        `Published kind:30617 refresh: ${result.eventId}  paid ${result.feePaid} base units`
      );
    }
    return 0;
  } catch (err) {
    return emitCliError(io, flags.json, 'refresh', err);
  } finally {
    if (standaloneCtx) {
      try {
        await standaloneCtx.stop();
      } catch {
        // best-effort teardown
      }
    }
  }
}
