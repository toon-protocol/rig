import { useCallback, useEffect, useState } from 'react';
import { Check, ChevronDown, Code2, Copy } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Button } from '@/components/ui/button';
import { useRigConfig } from '@/hooks/use-rig-config';
import { configuredGateway } from '../arweave-client.js';
import { normalizeGateway } from '../arweave-gateway.js';
import type { RepoMetadata } from '../nip34-parsers.js';

/**
 * Where "how do I clone / fetch / push?" is documented — the
 * `@toon-protocol/rig` package README (install, the free read path, daemon vs
 * standalone payment modes for the paid write path).
 */
const RIG_CLI_DOCS_URL =
  'https://github.com/toon-protocol/toon-client/tree/main/packages/rig#readme';

/**
 * Best-effort synchronous copy via the legacy `document.execCommand('copy')`
 * over a hidden textarea. Same approach as the views copy-button: the async
 * Clipboard API rejects when the page is embedded without the
 * `clipboard-write` permission policy, while the legacy command still works.
 * Returns whether the copy succeeded.
 */
function legacyCopy(value: string): boolean {
  if (typeof document === 'undefined') return false;
  const ta = document.createElement('textarea');
  ta.value = value;
  ta.setAttribute('readonly', '');
  // Keep it off-screen and inert so selecting it doesn't scroll/flash the page.
  ta.style.position = 'fixed';
  ta.style.top = '0';
  ta.style.left = '0';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  ta.setSelectionRange(0, value.length);
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  document.body.removeChild(ta);
  return ok;
}

/**
 * Neutralize a value for interpolation into the copy-paste shell snippet.
 *
 * `repoId` is the kind:30617 `d` tag — raw, attacker-publishable event content
 * with no charset guarantee — and the snippet is pasted straight into a
 * terminal, so an embedded newline would smuggle an extra executable line
 * into the clipboard (command injection via paste). Control characters are
 * stripped outright (they are never legitimate in a repo id, pubkey, or relay
 * URL), and anything outside a conservative safe charset is single-quoted
 * with `'` → `'\''` escaping so the shell treats it as one literal word.
 */
function shellQuote(value: string): string {
  // eslint-disable-next-line no-control-regex -- stripping control chars is the point
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, '');
  if (/^[A-Za-z0-9._:/@-]+$/.test(cleaned)) return cleaned;
  return `'${cleaned.replace(/'/g, `'\\''`)}'`;
}

/**
 * The ` --gateway <url>` suffix for a clone command, or `''` when this build
 * reads from the public gateway list.
 *
 * The page and the command it hands out have to agree about where objects
 * live (rig#185): when `VITE_ARWEAVE_GATEWAY` names a self-hosted store, the
 * tree the reader is looking at was fetched from THAT gateway, and a clone
 * aimed at `ar-io.dev` / `arweave.net` / `permagate.io` finds nothing there.
 * `rig clone` and `rig fetch` both take `--gateway` (rig#176), which tries the
 * named gateway first and keeps the public list behind it.
 *
 * The value goes through {@link normalizeGateway} — the same reduction the
 * fetch path applies — so the command names exactly the base URL the page
 * read from, and an unusable value (a typo, a non-http scheme) appends no
 * flag at all: the reader gets today's public-gateway command rather than one
 * that fails to parse.
 */
function gatewayFlag(
  gateway: string | undefined | null,
  quote: (value: string) => string,
): string {
  const configured = normalizeGateway(gateway);
  return configured ? ` --gateway ${quote(configured)}` : '';
}

/**
 * The paste-and-run command to clone a specific repo with the `rig` CLI:
 * `rig clone <relay-url> <owner>/<repo-id>`. Mirrors GitHub's clone box — just
 * the clone command, one copyable line (the `rig` install is covered by the
 * CLI docs link in the popover, not baked into the copied command).
 *
 * Cloning is entirely FREE — it reads the kind:30617/30618 state from the
 * relay and pulls objects from Arweave gateways; no payment, channel, or
 * funded identity is involved. The clone also writes the repo's `toon.*` git
 * config and adds the relay as `origin`, so `rig fetch` / `rig push` work from
 * the cloned folder immediately (that later push is the paid path).
 *
 * The owner + relay come from safe charsets (hex/npub pubkey, ws(s):// URL),
 * but `repoId` is attacker-publishable, so the whole `<owner>/<repo-id>`
 * argument is `shellQuote`d as one token to keep a hostile `d` tag from
 * smuggling extra shell words onto the paste (a stripped newline can never
 * become a second executable line).
 *
 * `gateway` is the store gateway this build reads objects through, when one is
 * configured; it is appended as `--gateway <url>` (see {@link gatewayFlag}) and
 * `shellQuote`d like the other arguments — it is build config rather than
 * attacker-publishable, but it takes the same treatment for the same reason.
 * Without one the command is byte-for-byte what it has always been.
 */
export function buildCloneCommand(
  repoId: string,
  ownerPubkey: string,
  relayUrl: string,
  gateway?: string | null,
): string {
  const base = `rig clone ${shellQuote(relayUrl)} ${shellQuote(`${ownerPubkey}/${repoId}`)}`;
  return `${base}${gatewayFlag(gateway, shellQuote)}`;
}

/**
 * Display-only rendering of the clone command with the 64-char owner pubkey
 * abbreviated (`dfbf0e5c…9a11`) so the one-line box stays readable — the copy
 * button always copies the FULL command from {@link buildCloneCommand} (and
 * the box's `title` carries it for hover/selection). Control characters are
 * stripped for the same reason as {@link shellQuote}, but no quoting is
 * applied: this string is only ever rendered as text, never pasted.
 *
 * Carries the same `--gateway` suffix as {@link buildCloneCommand}, unquoted —
 * the box must show the command the copy button puts on the clipboard.
 */
export function buildDisplayCommand(
  repoId: string,
  ownerPubkey: string,
  relayUrl: string,
  gateway?: string | null,
): string {
  // eslint-disable-next-line no-control-regex -- stripping control chars is the point
  const strip = (v: string) => v.replace(/[\u0000-\u001f\u007f]/g, '');
  const owner =
    ownerPubkey.length > 16
      ? `${ownerPubkey.slice(0, 8)}…${ownerPubkey.slice(-4)}`
      : ownerPubkey;
  const base = `rig clone ${strip(relayUrl)} ${strip(`${owner}/${repoId}`)}`;
  return `${base}${gatewayFlag(gateway, strip)}`;
}

/**
 * "Clone this repo" affordance: a compact GitHub-style popover with a copyable
 * `rig clone` command pre-filled from the repo's actual context (repoId from
 * the kind:30617 `d` tag, owner from the announcement pubkey, relay from the
 * rig's active relay config).
 *
 * This is the read path, so it's free and needs no identity — the popover is a
 * hand-off to the `rig` CLI on the reader's machine. No daemon probing or
 * payment happens from the browser. Modeled on GitHub's green "Code" button:
 * one clone command with a copy affordance.
 */
export function CloneInstructions({ metadata }: { metadata: RepoMetadata }) {
  const { relayUrl } = useRigConfig();
  // The gateway the app itself reads objects through — so the command the
  // reader pastes clones from the same store the page rendered from (rig#185).
  const gateway = configuredGateway();
  const command = buildCloneCommand(
    metadata.repoId,
    metadata.ownerPubkey,
    relayUrl,
    gateway,
  );
  const displayCommand = buildDisplayCommand(
    metadata.repoId,
    metadata.ownerPubkey,
    relayUrl,
    gateway,
  );

  const [copied, setCopied] = useState(false);
  const onCopy = useCallback(() => {
    const succeed = (): void => setCopied(true);
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      void navigator.clipboard.writeText(command).then(succeed, () => {
        // Permission policy blocked the async API — fall back to the legacy
        // command, which still copies from a restricted context.
        if (legacyCopy(command)) succeed();
      });
      return;
    }
    if (legacyCopy(command)) succeed();
  }, [command]);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="success" size="sm" className="gap-1.5">
          <Code2 aria-hidden="true" className="h-3.5 w-3.5" />
          Code
          <ChevronDown aria-hidden="true" className="ml-0.5 h-3 w-3 opacity-80" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[28rem] max-w-[calc(100vw-2rem)] p-4" align="end">
        <div className="space-y-3">
          <div className="space-y-1">
            <h3 className="text-sm font-semibold">Clone this repo</h3>
            <p className="text-xs text-muted-foreground">
              Reads on TOON are free — clone from your terminal with the{' '}
              <code className="font-mono">rig</code> CLI. No TOON identity needed.
            </p>
          </div>
          <div className="flex items-center rounded-md border bg-muted/50">
            <pre
              title={command}
              className="min-w-0 flex-1 overflow-x-auto p-3 font-mono text-xs leading-relaxed"
            >
              {displayCommand}
            </pre>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={copied ? 'Copy clone command — copied' : 'Copy clone command'}
              className="mx-1 shrink-0 text-muted-foreground hover:text-foreground"
              onClick={onCopy}
            >
              {copied ? (
                <Check aria-hidden="true" className="text-primary" />
              ) : (
                <Copy aria-hidden="true" />
              )}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            The clone sets up <code className="font-mono">origin</code> for you, so{' '}
            <code className="font-mono">rig push</code> works from the folder afterwards
            (that write is paid). See the{' '}
            <a
              href={RIG_CLI_DOCS_URL}
              target="_blank"
              rel="noreferrer"
              className="underline underline-offset-2 hover:text-foreground"
            >
              rig CLI docs
            </a>
            .
          </p>
        </div>
      </PopoverContent>
    </Popover>
  );
}
