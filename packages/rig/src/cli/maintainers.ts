/**
 * `rig maintainers list|add|remove <pubkey>` (#287) — manage the declared
 * maintainer set on a repo's kind:30617 announcement.
 *
 * Status authority is CONSUMER-side: rig and rig-web resolve an issue/PR's
 * state ONLY from kind:1630-1633 events signed by the repo owner ∪ its
 * declared maintainers. The owner is ALWAYS an implicit maintainer; this
 * command edits the EXPLICIT set carried by the `["maintainers", …]` tag.
 *
 *   list            FREE relay read — print owner + declared maintainers
 *   add <pubkey>    PAID — republish the 30617 with <pubkey> added
 *   remove <pubkey> PAID — republish the 30617 with <pubkey> removed
 *
 * add/remove republish the WHOLE announcement (a replaceable event keyed by
 * author + `d` tag), so they preserve the existing name/description and only
 * mutate the maintainers list. Because the 30617 is addressed by its author,
 * only the OWNER's republish is authoritative — running add/remove under a
 * non-owner identity writes that identity's own (irrelevant) announcement, so
 * we refuse it. The daemon has no announcement route, so this always runs the
 * embedded standalone publisher; the confirm gate matches every other paid
 * write (`--yes` skips; a non-TTY without it refuses; `--json` without `--yes`
 * is a pure estimate).
 */

import { parseArgs } from 'node:util';
import { parseMaintainers } from '../nip34-events.js';
import {
  amendRepoAnnouncement,
  conformanceEdits,
  diffAnnouncementTags,
} from '../repo-announcement.js';
import { ownerToHex } from '../npub.js';
import { fetchRemoteState } from '../remote-state.js';
import {
  serializeEventReceipt,
  type GitEventResponse,
} from '../routes.js';
import type { EventCommandDeps } from './events.js';
import { emitCliError, InvalidRelayUrlError } from './errors.js';
import type { IdentityReport } from './push.js';
import { describeAnnouncementDiff, feeLabel } from './render.js';
import {
  openAnnouncementRepublish,
  pickRepoCommandFlags,
  REPO_COMMAND_OPTIONS,
  resolveRepoContext,
  WS_URL_RE,
  type RepoCommandFlags,
} from './repo-command.js';
import type { StandaloneContext } from './standalone-context.js';

const HEX64_RE = /^[0-9a-f]{64}$/;

export const MAINTAINERS_USAGE = `Usage: rig maintainers <list|add|remove> [<pubkey>] [options]

Manage a repo's declared maintainers (#287). Status authority is consumer-side:
rig and rig-web honor an issue/PR status (kind:1630-1633) ONLY when its author
is the repo owner or a declared maintainer. The owner is always an implicit
maintainer; this command edits the explicit set on the kind:30617 announcement.

Subcommands:
  list             show the owner + declared maintainers — FREE (relay read)
  add <pubkey>     add a maintainer (npub or 64-char hex) — PAID: republishes
                   the kind:30617 (permanent, non-refundable)
  remove <pubkey>  remove a maintainer — PAID: republishes the kind:30617

add/remove must run under the repo OWNER's identity (only the owner's
announcement is authoritative).

Options:
  --repo-id <id>       repository id / NIP-34 d-tag (default: git config)
  --owner <pubkey>     repository owner (npub or hex; default: git config)
  --remote <name>      publish/read via this configured git remote (default: origin)
  --relay <url>        ad-hoc relay override (exactly one for add/remove)
  --yes                skip the fee confirmation (required when not a TTY)
  --json               machine-readable envelope
  -h, --help           show this help`;

/** Run `rig maintainers …`; returns the process exit code. */
export async function runMaintainers(
  args: string[],
  deps: EventCommandDeps
): Promise<number> {
  const { io } = deps;
  const [sub, ...rest] = args;
  switch (sub) {
    case 'list':
      return runList(rest, deps);
    case 'add':
      return runMutate('add', rest, deps);
    case 'remove':
      return runMutate('remove', rest, deps);
    case '--help':
    case '-h':
    case 'help':
      io.out(MAINTAINERS_USAGE);
      return 0;
    default:
      io.err(
        sub === undefined
          ? 'missing subcommand: rig maintainers <list|add|remove>'
          : `unknown rig maintainers subcommand: ${sub}`
      );
      io.err(MAINTAINERS_USAGE);
      return 2;
  }
}

// ---------------------------------------------------------------------------
// list (FREE)
// ---------------------------------------------------------------------------

async function runList(
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
    if (positionals.length > 0) {
      throw new Error('rig maintainers list takes no positional arguments');
    }
    flags = pickRepoCommandFlags(values);
  } catch (err) {
    io.err(err instanceof Error ? err.message : String(err));
    io.err(MAINTAINERS_USAGE);
    return 2;
  }
  if (flags.help) {
    io.out(MAINTAINERS_USAGE);
    return 0;
  }

  try {
    const ctx = await resolveRepoContext(flags, deps);
    const wsRelays = ctx.relays.filter((url) => WS_URL_RE.test(url));
    if (wsRelays.length === 0) {
      throw new InvalidRelayUrlError(
        ctx.relays[0] ?? '',
        'reads need a ws:// or wss:// relay'
      );
    }
    const remote = await fetchRemoteState({
      relayUrls: wsRelays,
      ownerPubkey: ctx.owner,
      repoId: ctx.repoId,
      ...(deps.webSocketFactory
        ? { webSocketFactory: deps.webSocketFactory }
        : {}),
    });
    const maintainers = remote.maintainers;
    if (flags.json) {
      io.emitJson({
        command: 'maintainers list',
        repoAddr: { ownerPubkey: ctx.owner, repoId: ctx.repoId },
        announced: remote.announced,
        owner: ctx.owner,
        maintainers,
      });
      return 0;
    }
    io.out(`Repo:    30617:${ctx.owner}:${ctx.repoId}`);
    io.out(`Owner:   ${ctx.owner}  (implicit maintainer)`);
    if (!remote.announced) {
      io.out('No kind:30617 announcement found — owner-only authority.');
      return 0;
    }
    if (maintainers.length === 0) {
      io.out('Maintainers: (none declared — owner-only authority)');
    } else {
      io.out(`Maintainers (${maintainers.length}):`);
      for (const m of maintainers) io.out(`  ${m}`);
    }
    return 0;
  } catch (err) {
    return emitCliError(io, flags.json, 'maintainers list', err);
  }
}

// ---------------------------------------------------------------------------
// add / remove (PAID — republish the 30617 under the owner's identity)
// ---------------------------------------------------------------------------

interface MaintJsonOutput {
  command: 'maintainers add' | 'maintainers remove';
  repoAddr: { ownerPubkey: string; repoId: string };
  identity: IdentityReport;
  executed: boolean;
  feeEstimate: string | null;
  maintainers: string[];
  /**
   * Every tag the republish adds and drops (#158) — the maintainers edit plus
   * the conformance backfill. A `--json` consumer sees exactly what the fee
   * buys, the same as the human confirmation does.
   */
  changes: { added: string[][]; removed: string[][] };
  result?: GitEventResponse;
  hint?: string;
}

async function runMutate(
  op: 'add' | 'remove',
  args: string[],
  deps: EventCommandDeps
): Promise<number> {
  const { io } = deps;
  const command = `maintainers ${op}` as
    | 'maintainers add'
    | 'maintainers remove';

  let flags: RepoCommandFlags;
  let pubkey: string;
  try {
    const { values, positionals } = parseArgs({
      args,
      options: REPO_COMMAND_OPTIONS,
      allowPositionals: true,
    });
    flags = pickRepoCommandFlags(values);
    if (flags.help) {
      io.out(MAINTAINERS_USAGE);
      return 0;
    }
    if (positionals.length !== 1) {
      throw new Error(`expected exactly one <pubkey> to ${op}`);
    }
    pubkey = ownerToHex(positionals[0] as string).toLowerCase();
    if (!HEX64_RE.test(pubkey)) {
      throw new Error(`<pubkey> must resolve to 64-char hex (got ${JSON.stringify(positionals[0])})`);
    }
  } catch (err) {
    io.err(err instanceof Error ? err.message : String(err));
    io.err(MAINTAINERS_USAGE);
    return 2;
  }

  let standaloneCtx: StandaloneContext | undefined;
  try {
    // Every money-safety refusal a paid republish must clear — one relay, the
    // embedded publisher, owner-only, and no phantom 30617 on an unannounced
    // repo — lives in ./repo-command.ts, shared with payout and refresh.
    const opened = await openAnnouncementRepublish({
      deps,
      flags,
      what: 'change the maintainer set',
      before: 'before managing maintainers',
    });
    standaloneCtx = opened.standalone;
    if (!opened.ok) return opened.exitCode;
    const { ctx, relayUrl, identity, remote, facts } = opened;

    const current = remote.announceEvent
      ? parseMaintainers(remote.announceEvent.tags)
      : [];
    const currentSet = new Set(current);
    if (op === 'add' && currentSet.has(pubkey)) {
      io.err(
        `rig: ${pubkey.slice(0, 8)}… is already a maintainer — nothing to do (not published).`
      );
      return 0;
    }
    if (op === 'remove' && !currentSet.has(pubkey)) {
      io.err(
        `rig: ${pubkey.slice(0, 8)}… is not a declared maintainer — nothing to do (not published).`
      );
      return 0;
    }
    const next =
      op === 'add'
        ? [...current, pubkey]
        : current.filter((m) => m !== pubkey);

    // Amend rather than rebuild (#154): `maintainers` is the ONLY field this
    // command edits, so name, description, the payout pointer (rig#92) and
    // every tag rig does not model — another client's role tags, `clone`,
    // `blossoms`, … — ride along verbatim instead of being wiped by the
    // replaceable write. Passing a field here would rewrite it.
    // #158: an owner-initiated republish also BACKFILLS the conformance tags
    // (`relays`, `web`, and the `euc` when the announcement has none), so a
    // repo announced before #158 becomes conformant without a special step.
    const event = amendRepoAnnouncement(remote.announceEvent, {
      repoId: ctx.repoId,
      maintainers: next,
      ...conformanceEdits(remote.announceEvent, facts),
    });
    const diff = diffAnnouncementTags(remote.announceEvent, event);
    const changes = { added: diff.added, removed: diff.removed };
    const fee = (
      await opened.standalone.publisher.getFeeRates()
    ).eventFee.toString();
    const action = `kind:30617 maintainers ${op} ${pubkey.slice(0, 8)}…`;

    // ── Confirm gate ────────────────────────────────────────────────────────
    if (!flags.json) {
      io.out(`Republish ${action}`);
      io.out(`Repo: 30617:${ctx.owner}:${ctx.repoId}`);
      io.out(`Maintainers after: ${next.length === 0 ? '(none)' : next.join(', ')}`);
      if (!diff.unchanged) {
        io.out('Tags changed:');
        for (const line of describeAnnouncementDiff(diff)) io.out(line);
      }
      io.out(`Fee: ${feeLabel(fee)}. Writes are permanent and non-refundable.`);
    }
    if (!flags.yes) {
      if (flags.json) {
        io.emitJson({
          command,
          repoAddr: { ownerPubkey: ctx.owner, repoId: ctx.repoId },
          identity,
          executed: false,
          feeEstimate: fee,
          maintainers: next,
          changes,
          hint: 'estimate only — re-run with --yes to publish (permanent, non-refundable)',
        } satisfies MaintJsonOutput);
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

    // ── Execute ───────────────────────────────────────────────────────────────
    const receipt = await opened.standalone.publisher.publishEvent(event, [
      relayUrl,
    ]);
    const result = serializeEventReceipt(event.kind, receipt);

    if (flags.json) {
      io.emitJson({
        command,
        repoAddr: { ownerPubkey: ctx.owner, repoId: ctx.repoId },
        identity,
        executed: true,
        feeEstimate: fee,
        maintainers: next,
        changes,
        result,
      } satisfies MaintJsonOutput);
    } else {
      io.out(
        `Published ${action}: ${result.eventId}  paid ${result.feePaid} base units`
      );
    }
    return 0;
  } catch (err) {
    return emitCliError(io, flags.json, command, err);
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
