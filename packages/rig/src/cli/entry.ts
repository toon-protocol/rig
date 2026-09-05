/**
 * `rig entry` — name the TOON connector rig pays.
 *
 * One URL is the whole network configuration since 4.0: a connector describes
 * itself on `GET /ilp` (addresses, prices, chains, sealing key — connector ADR
 * 0050), so there is nothing else to point rig at. This command records that
 * URL as `connectorUrl` in the shared client config, optionally with the
 * free-read relay (`--relay`) the same node serves, and shows what is in
 * effect and where it came from. Free: only the local config file is touched.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { emitCliError } from './errors.js';
import type { CliIo } from './output.js';

export const ENTRY_USAGE = `Usage: rig entry [<connector-url> | clear] [options]

Name the TOON connector rig pays. A connector describes itself on GET /ilp
(its addresses, routes and prices, settlement chains), so its URL is the
whole configuration. Free: only the local config file is touched.

  rig entry                    show the effective connector + relay and their source
  rig entry <connector-url>    record the node's client-edge URL (https://…);
                               pass --relay <wss-url> to also record its free-read relay
  rig entry clear              forget the recorded connector (and relay)

Existing payment channels are per node: after switching, the next paid
command opens or adopts a channel with the new node.

NOTE for repos: the relay a repo publishes to is its git \`origin\` remote,
which OVERRIDES the config relayUrl. After switching, point the repo too:
\`rig remote add origin <relay-url>\` (or use a fresh repo).

Options:
  --relay <url>        with <connector-url>: also record the relay URL (ws:// or wss://)
  --json               machine-readable envelope
  -h, --help           show this help`;

/** What `rig entry` needs from the command environment. */
export interface EntryDeps {
  io: CliIo;
  env: NodeJS.ProcessEnv;
}

/** The slice of the shared client config `rig entry` reads/writes. */
interface EntryConfigFile {
  connectorUrl?: string;
  relayUrl?: string;
  /** @deprecated pre-4.0 spellings, migrated away on write. */
  proxyUrl?: string;
  btpUrl?: string;
  [key: string]: unknown;
}

/** Where an effective endpoint value came from. */
export type EndpointSource =
  'env' | 'config' | 'legacy-env' | 'legacy-config' | null;

/** `--json` envelope. */
interface EntryJson {
  command: 'entry';
  connectorUrl: string | null;
  connectorSource: EndpointSource;
  relayUrl: string | null;
  relaySource: EndpointSource;
  /** What was written to config (mutations only). */
  wrote?: { connectorUrl: string | null; relayUrl: string | null };
  configPath: string;
  warnings?: string[];
}

/** Resolve the client config directory + path (mirrors `rig chain`). */
function configPathFor(env: NodeJS.ProcessEnv): string {
  const dir = env['TOON_CLIENT_HOME'] ?? join(homedir(), '.toon-client');
  return join(dir, 'config.json');
}

function readEntryConfig(configPath: string): EntryConfigFile {
  try {
    return JSON.parse(readFileSync(configPath, 'utf8')) as EntryConfigFile;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new Error(
      `failed to read client config at ${configPath}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/** Read-merge-write: preserve every other field. */
function writeEntryConfig(configPath: string, file: EntryConfigFile): void {
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, `${JSON.stringify(file, null, 2)}\n`, 'utf8');
}

/** The effective connector and relay, with the precedence the paid path uses. */
export function effectiveEntry(
  env: NodeJS.ProcessEnv,
  file: EntryConfigFile
): {
  connectorUrl: string | null;
  connectorSource: EndpointSource;
  relayUrl: string | null;
  relaySource: EndpointSource;
} {
  let connectorUrl: string | null = null;
  let connectorSource: EndpointSource = null;
  if (env['TOON_CONNECTOR']) {
    connectorUrl = env['TOON_CONNECTOR'];
    connectorSource = 'env';
  } else if (env['TOON_CLIENT_PROXY_URL']) {
    connectorUrl = env['TOON_CLIENT_PROXY_URL'];
    connectorSource = 'legacy-env';
  } else if (file.connectorUrl) {
    connectorUrl = file.connectorUrl;
    connectorSource = 'config';
  } else if (file.proxyUrl) {
    connectorUrl = file.proxyUrl;
    connectorSource = 'legacy-config';
  }
  const relayUrl = env['TOON_CLIENT_RELAY_URL'] ?? file.relayUrl ?? null;
  const relaySource: EndpointSource = env['TOON_CLIENT_RELAY_URL']
    ? 'env'
    : file.relayUrl
      ? 'config'
      : null;
  return { connectorUrl, connectorSource, relayUrl, relaySource };
}

const HTTP_URL = /^https?:\/\/.+/i;
const WS_URL = /^wss?:\/\/.+/i;

/** Run `rig entry`; returns the process exit code. */
export async function runEntry(
  args: string[],
  deps: EntryDeps
): Promise<number> {
  const { io, env } = deps;

  let positionals: string[];
  let relayFlag: string | undefined;
  let json = false;
  try {
    const parsed = parseArgs({
      args,
      allowPositionals: true,
      options: {
        relay: { type: 'string' },
        json: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
    });
    if (parsed.values.help) {
      io.out(ENTRY_USAGE);
      return 0;
    }
    positionals = parsed.positionals;
    relayFlag = parsed.values.relay;
    json = parsed.values.json ?? false;
  } catch (err) {
    io.err(err instanceof Error ? err.message : String(err));
    io.err(ENTRY_USAGE);
    return 2;
  }

  if (positionals.length > 1) {
    io.err(
      `rig entry takes at most one argument, got ${String(positionals.length)}: ${positionals.join(' ')}`
    );
    io.err(ENTRY_USAGE);
    return 2;
  }
  const target = positionals[0];

  // Usage-validate the target OUTSIDE the runtime-error wrapper (exit 2).
  let mutation:
    | { kind: 'clear' }
    | { kind: 'url'; connectorUrl: string; relayUrl?: string }
    | undefined;
  if (target !== undefined) {
    if (target === 'clear') {
      if (relayFlag !== undefined) {
        io.err('--relay only applies to a <connector-url> entry');
        io.err(ENTRY_USAGE);
        return 2;
      }
      mutation = { kind: 'clear' };
    } else if (HTTP_URL.test(target)) {
      if (relayFlag !== undefined && !WS_URL.test(relayFlag)) {
        io.err(`--relay must be a ws(s) URL, got ${JSON.stringify(relayFlag)}`);
        io.err(ENTRY_USAGE);
        return 2;
      }
      mutation = {
        kind: 'url',
        connectorUrl: target.replace(/\/+$/, ''),
        ...(relayFlag !== undefined ? { relayUrl: relayFlag } : {}),
      };
    } else if (WS_URL.test(target)) {
      io.err(
        `${JSON.stringify(target)} is a WebSocket URL — the entry is the connector's http(s) URL ` +
          '(the one whose GET /ilp describes it); pass the relay with --relay'
      );
      io.err(ENTRY_USAGE);
      return 2;
    } else {
      io.err(
        `unknown entry ${JSON.stringify(target)} — expected a connector http(s):// URL or \`clear\``
      );
      io.err(ENTRY_USAGE);
      return 2;
    }
  }

  try {
    const configPath = configPathFor(env);
    const file = readEntryConfig(configPath);

    const label = (source: EndpointSource): string =>
      source === 'env'
        ? 'env'
        : source === 'legacy-env'
          ? 'env (TOON_CLIENT_PROXY_URL, pre-4.0 spelling — set TOON_CONNECTOR)'
          : source === 'config'
            ? `config (${configPath})`
            : source === 'legacy-config'
              ? `config proxyUrl (${configPath}, pre-4.0 spelling)`
              : 'not configured';

    // ── show (no argument) ─────────────────────────────────────────────────
    if (mutation === undefined) {
      const state = effectiveEntry(env, file);
      if (json) {
        io.emitJson({
          command: 'entry',
          ...state,
          configPath,
        } satisfies EntryJson);
        return 0;
      }
      io.out(
        `Connector  ${state.connectorUrl ?? '(none)'}  [${label(state.connectorSource)}]`
      );
      io.out(
        `Relay      ${state.relayUrl ?? '(none)'}  [${label(state.relaySource)}]`
      );
      if (!state.connectorUrl) {
        io.out(
          'Set one with `rig entry <connector-url>` (or export TOON_CONNECTOR).'
        );
      }
      return 0;
    }

    // ── mutations ──────────────────────────────────────────────────────────
    const warnings: string[] = [];
    const next: EntryConfigFile = { ...file };
    // The pre-4.0 spellings are retired on any write: a stale `proxyUrl`
    // would otherwise keep outranking nothing, and `btpUrl` is ignored.
    if (file.proxyUrl !== undefined || file.btpUrl !== undefined) {
      delete next.proxyUrl;
      delete next.btpUrl;
      warnings.push(
        'removed the pre-4.0 proxyUrl/btpUrl fields (the connector URL replaces both)'
      );
    }
    if (mutation.kind === 'clear') {
      delete next.connectorUrl;
      delete next.relayUrl;
    } else {
      next.connectorUrl = mutation.connectorUrl;
      if (mutation.relayUrl !== undefined) next.relayUrl = mutation.relayUrl;
    }
    if (env['TOON_CONNECTOR'] || env['TOON_CLIENT_PROXY_URL']) {
      warnings.push(
        'TOON_CONNECTOR / TOON_CLIENT_PROXY_URL is set in this shell and outranks the config file'
      );
    }
    writeEntryConfig(configPath, next);
    const wrote = {
      connectorUrl: next.connectorUrl ?? null,
      relayUrl: next.relayUrl ?? null,
    };
    const state = effectiveEntry(env, next);

    if (json) {
      io.emitJson({
        command: 'entry',
        ...state,
        wrote,
        configPath,
        ...(warnings.length > 0 ? { warnings } : {}),
      } satisfies EntryJson);
      return 0;
    }
    if (mutation.kind === 'clear') {
      io.out(`Cleared the recorded connector in ${configPath}.`);
    } else {
      io.out(`Recorded connector ${mutation.connectorUrl} in ${configPath}.`);
      if (mutation.relayUrl !== undefined)
        io.out(`Recorded relay ${mutation.relayUrl}.`);
    }
    for (const w of warnings) io.out(`warning: ${w}`);
    io.out(
      `Effective connector: ${state.connectorUrl ?? '(none)'}  [${label(state.connectorSource)}]`
    );
    return 0;
  } catch (err) {
    return emitCliError(io, json, 'entry', err);
  }
}
