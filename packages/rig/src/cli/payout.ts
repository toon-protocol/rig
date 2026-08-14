/**
 * `rig payout set|clear|show` (rig#92, part of the payout epic
 * toon-protocol/toon-meta#391) — manage the declared payout pointer on a
 * repo's kind:30617 announcement.
 *
 * The payout pointer is the ONLY thing that turns on a serving node's
 * node-declared `ownerFeeShare` split on repo-scoped paid writes
 * (toon-meta#391 decision 2): no pointer on the announcement → no split, the
 * node keeps 100%. v1 accepts exactly one chain, `evm` — the payout accrual
 * ledger is EVM-only today (`crates/connector-client-edge/src/btp.rs:270-272`)
 * — but the tag shape (`['payout', '<chain>', '<address>']`) carries the
 * chain label so nothing re-shapes later.
 *
 *   show           FREE relay read — print the pointer or "none"
 *   set <address>  PAID — republish the 30617 with the payout tag set to
 *                  `evm <checksummed address>`
 *   clear          PAID — republish the 30617 with the payout tag removed
 *
 * set/clear republish the WHOLE announcement (a replaceable event keyed by
 * author + `d` tag), so they preserve the existing name/description/
 * maintainers and only mutate the payout pointer — mirrors `rig maintainers`
 * exactly (`./maintainers.ts:1-23`). Because the 30617 is addressed by its
 * author, only the OWNER's republish is authoritative, so a non-owner
 * republish is refused (same shape as maintainers.ts:344-351), as is a
 * republish on an unannounced repo (maintainers.ts:369-377). The daemon has
 * no announcement route, so this always runs the embedded standalone
 * publisher; the confirm gate matches every other paid write (`--yes` skips;
 * a non-TTY without it refuses; `--json` without `--yes` is a pure
 * estimate).
 */

import { parseArgs } from 'node:util';
import { getAddress } from 'viem';
import {
  buildRepoAnnouncement,
  isValidEvmPayoutAddress,
  type PayoutPointer,
} from '../nip34-events.js';
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
  pickRepoCommandFlags,
  REPO_COMMAND_OPTIONS,
  resolveRepoContext,
  WS_URL_RE,
  type RepoCommandFlags,
} from './repo-command.js';
import type { StandaloneContext } from './standalone-context.js';

export const PAYOUT_USAGE = `Usage: rig payout <set|clear|show> [<address>] [options]

Manage a repo's declared payout pointer (rig#92, part of the payout epic
toon-protocol/toon-meta#391). No pointer on the kind:30617 announcement means
a serving node keeps 100% of repo-scoped write fees; a pointer opts the repo
into that node's declared ownerFeeShare split.

Subcommands:
  show             show the declared payout pointer — FREE (relay read)
  set <address>    declare the payout pointer (EVM address, EIP-55
                   checksummed or all-lowercase) — PAID: republishes the
                   kind:30617 (permanent, non-refundable). v1 accepts evm
                   addresses only.
  clear            remove the payout pointer — PAID: republishes the
                   kind:30617

set/clear must run under the repo OWNER's identity (only the owner's
announcement is authoritative).

Options:
  --repo-id <id>       repository id / NIP-34 d-tag (default: git config)
  --owner <pubkey>     repository owner (npub or hex; default: git config)
  --remote <name>      publish/read via this configured git remote (default: origin)
  --relay <url>        ad-hoc relay override (exactly one for set/clear)
  --yes                skip the fee confirmation (required when not a TTY)
  --json               machine-readable envelope
  -h, --help           show this help`;

/** Run `rig payout …`; returns the process exit code. */
export async function runPayout(
  args: string[],
  deps: EventCommandDeps
): Promise<number> {
  const { io } = deps;
  const [sub, ...rest] = args;
  switch (sub) {
    case 'show':
      return runShow(rest, deps);
    case 'set':
      return runMutate('set', rest, deps);
    case 'clear':
      return runMutate('clear', rest, deps);
    case '--help':
    case '-h':
    case 'help':
      io.out(PAYOUT_USAGE);
      return 0;
    default:
      io.err(
        sub === undefined
          ? 'missing subcommand: rig payout <set|clear|show>'
          : `unknown rig payout subcommand: ${sub}`
      );
      io.err(PAYOUT_USAGE);
      return 2;
  }
}

// ---------------------------------------------------------------------------
// show (FREE)
// ---------------------------------------------------------------------------

async function runShow(
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
      throw new Error('rig payout show takes no positional arguments');
    }
    flags = pickRepoCommandFlags(values);
  } catch (err) {
    io.err(err instanceof Error ? err.message : String(err));
    io.err(PAYOUT_USAGE);
    return 2;
  }
  if (flags.help) {
    io.out(PAYOUT_USAGE);
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
    const payout = remote.payout;
    if (flags.json) {
      io.emitJson({
        command: 'payout show',
        repoAddr: { ownerPubkey: ctx.owner, repoId: ctx.repoId },
        announced: remote.announced,
        payout,
      });
      return 0;
    }
    io.out(`Repo:   30617:${ctx.owner}:${ctx.repoId}`);
    if (!remote.announced) {
      io.out('No kind:30617 announcement found — no payout pointer.');
      return 0;
    }
    io.out(
      payout === null
        ? 'Payout: none (the serving node keeps 100% of repo-scoped write fees)'
        : `Payout: ${payout.chain} ${payout.address}`
    );
    return 0;
  } catch (err) {
    return emitCliError(io, flags.json, 'payout show', err);
  }
}

// ---------------------------------------------------------------------------
// set / clear (PAID — republish the 30617 under the owner's identity)
// ---------------------------------------------------------------------------

interface PayoutJsonOutput {
  command: 'payout set' | 'payout clear';
  repoAddr: { ownerPubkey: string; repoId: string };
  identity: IdentityReport;
  executed: boolean;
  feeEstimate: string | null;
  payout: PayoutPointer | null;
  result?: GitEventResponse;
  hint?: string;
}

async function runMutate(
  op: 'set' | 'clear',
  args: string[],
  deps: EventCommandDeps
): Promise<number> {
  const { io } = deps;
  const command = `payout ${op}` as 'payout set' | 'payout clear';

  let flags: RepoCommandFlags;
  /** The pointer this run publishes: validated for `set`, `null` for `clear`. */
  let nextPayout: PayoutPointer | null = null;
  try {
    const { values, positionals } = parseArgs({
      args,
      options: REPO_COMMAND_OPTIONS,
      allowPositionals: true,
    });
    flags = pickRepoCommandFlags(values);
    if (flags.help) {
      io.out(PAYOUT_USAGE);
      return 0;
    }
    if (op === 'set') {
      if (positionals.length !== 1) {
        throw new Error('expected exactly one <address> to set');
      }
      const raw = positionals[0] as string;
      if (!isValidEvmPayoutAddress(raw)) {
        throw new Error(
          `<address> must be a valid EVM address (0x + 40 hex chars, ` +
            `correctly EIP-55 checksummed if mixed-case) — got ` +
            `${JSON.stringify(raw)}. See toon-meta#391 (payout epic): v1 ` +
            'accepts evm addresses only.'
        );
      }
      nextPayout = { chain: 'evm', address: getAddress(raw) };
    } else if (positionals.length !== 0) {
      throw new Error('rig payout clear takes no positional arguments');
    }
  } catch (err) {
    io.err(err instanceof Error ? err.message : String(err));
    io.err(PAYOUT_USAGE);
    return 2;
  }

  let standaloneCtx: StandaloneContext | undefined;
  try {
    const ctx = await resolveRepoContext(flags, deps);
    // A single relay for a paid publish (mirror push/events guard).
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

    // Only the owner's 30617 is authoritative — refuse a non-owner republish.
    if (identity.pubkey.toLowerCase() !== ctx.owner.toLowerCase()) {
      io.err(
        `rig: only the repo owner (${ctx.owner.slice(0, 8)}…) can change the ` +
          `payout pointer — the active identity is ${identity.pubkey.slice(0, 8)}…. ` +
          'A non-owner republish would write your own (ignored) announcement. ' +
          'Nothing was published or paid.'
      );
      return 1;
    }

    // Read the current announcement to preserve name/description/maintainers.
    const remote = await fetchRemoteState({
      relayUrls: [relayUrl],
      ownerPubkey: ctx.owner,
      repoId: ctx.repoId,
      ...(deps.webSocketFactory
        ? { webSocketFactory: deps.webSocketFactory }
        : {}),
    });
    // Refuse on an unannounced repo: republishing here would MINT a phantom
    // kind:30617 with a placeholder name (= repoId) and empty description, for
    // real money (mirrors rig maintainers, maintainers.ts:363-377).
    if (!remote.announced) {
      io.err(
        `rig: 30617:${ctx.owner.slice(0, 8)}…:${ctx.repoId} has no announcement ` +
          'yet — run `rig push` to publish the repo (with its real ' +
          'name/description) before managing the payout pointer. Nothing was ' +
          'published or paid.'
      );
      return 1;
    }

    const current = remote.payout;
    if (
      nextPayout !== null &&
      current !== null &&
      current.chain === nextPayout.chain &&
      current.address === nextPayout.address
    ) {
      io.err(
        `rig: payout is already set to ${current.chain} ${current.address} — nothing to do (not published).`
      );
      return 0;
    }
    if (op === 'clear' && current === null) {
      io.err('rig: no payout pointer is set — nothing to do (not published).');
      return 0;
    }

    const name = remote.name ?? ctx.repoId;
    const description = remote.description ?? '';
    const event = buildRepoAnnouncement(
      ctx.repoId,
      name,
      description,
      remote.maintainers,
      nextPayout
    );
    const fee = (await standaloneCtx.publisher.getFeeRates()).eventFee.toString();
    const action = nextPayout
      ? `kind:30617 payout set ${nextPayout.chain} ${nextPayout.address}`
      : 'kind:30617 payout clear';

    // ── Confirm gate ────────────────────────────────────────────────────────
    if (!flags.json) {
      io.out(`Republish ${action}`);
      io.out(`Repo: 30617:${ctx.owner}:${ctx.repoId}`);
      io.out(
        `Payout after: ${nextPayout ? `${nextPayout.chain} ${nextPayout.address}` : '(none)'}`
      );
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
          payout: nextPayout,
          hint: 'estimate only — re-run with --yes to publish (permanent, non-refundable)',
        } satisfies PayoutJsonOutput);
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
    const receipt = await standaloneCtx.publisher.publishEvent(event, [
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
        payout: nextPayout,
        result,
      } satisfies PayoutJsonOutput);
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
