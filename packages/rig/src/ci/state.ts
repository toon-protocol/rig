/**
 * Coordinator state on disk (#125): what `rig ci serve` must remember across
 * restarts so a relay blip or a process restart never loses or repeats a run.
 *
 *   <stateDir>/cursor.json   per served repo: the last processed event, the
 *                            ref map the last 30618 left behind (push
 *                            triggers are diffs against it), and a bounded
 *                            list of already-processed trigger ids; plus the
 *                            coordinator inbox's own cursor (9840 / 29846).
 *   <stateDir>/secrets.json  per served repo: the accepted secret inventory
 *                            (../ci/secrets.ts's SecretInventory).
 *
 * Secret VALUES are stored in plaintext here, under the coordinator's own
 * config directory — the #125 spec allows exactly that ("keeps the decrypted
 * inventory in memory and on disk under its config directory"). What is
 * NEVER persisted is the NIP-44 recipient key (the advertised `secrets-key`):
 * it lives only in the running process and is regenerated at every start, as
 * NIP-C1 requires, so an update encrypted to a previous process cannot be
 * opened by this one — maintainers re-send after a restart, the inventory
 * already accepted survives.
 *
 * Files are written atomically (temp file + rename) so a crash mid-write
 * leaves the previous state intact. `stateDir` defaults to
 * `<TOON_CLIENT_HOME|~/.toon-client>/rig-ci/<coordinator-pubkey>`.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { SecretInventory } from './secrets.js';

/** Where one served repo's trigger processing stands. */
export interface RepoCursor {
  /** `created_at` of the newest trigger event processed for this repo. */
  lastCreatedAt: number;
  /** Id of that event (tie-breaker / audit). */
  lastEventId: string;
  /** Ref map (`refname → sha`) of the last kind:30618 seen — push diffs use it. */
  refs: Record<string, string>;
  /** Ids of trigger events already handled (bounded, newest last). */
  processed: string[];
}

/** The coordinator inbox (`#p` = coordinator) cursor: 9840 + 29846. */
export interface InboxCursor {
  lastCreatedAt?: number;
  processed: string[];
}

/** Repo address → its cursor. */
export type CoordinatorCursor = Record<string, RepoCursor>;

/** Repo address → its accepted secret inventory. */
export type CoordinatorSecrets = Record<string, SecretInventory>;

export interface CoordinatorState {
  cursor: CoordinatorCursor;
  inbox: InboxCursor;
  secrets: CoordinatorSecrets;
}

/** Processed-id lists are capped at this many entries (newest kept). */
export const MAX_PROCESSED_IDS = 1000;

export function cursorPath(stateDir: string): string {
  return join(stateDir, 'cursor.json');
}

export function secretsPath(stateDir: string): string {
  return join(stateDir, 'secrets.json');
}

/** `<TOON_CLIENT_HOME|~/.toon-client>/rig-ci/<coordinator-pubkey>` */
export function defaultCoordinatorStateDir(
  env: NodeJS.ProcessEnv,
  coordinatorPubkey: string
): string {
  const home = env['TOON_CLIENT_HOME'] ?? join(homedir(), '.toon-client');
  return join(home, 'rig-ci', coordinatorPubkey.toLowerCase());
}

/** Keep the newest {@link MAX_PROCESSED_IDS} ids. */
export function boundProcessed(ids: string[]): string[] {
  return ids.length > MAX_PROCESSED_IDS
    ? ids.slice(ids.length - MAX_PROCESSED_IDS)
    : ids;
}

interface CursorFile {
  repos: CoordinatorCursor;
  inbox: InboxCursor;
}

async function readJson<T>(path: string): Promise<T | undefined> {
  let text: string;
  try {
    text = await readFile(path, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
  try {
    return JSON.parse(text) as T;
  } catch (err) {
    throw new Error(
      `coordinator state file ${path} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  await writeFile(tmp, JSON.stringify(value, null, 2) + '\n', 'utf-8');
  await rename(tmp, path);
}

/** Load both files; a missing file (or directory) is an empty state. */
export async function loadCoordinatorState(
  stateDir: string
): Promise<CoordinatorState> {
  const cursorFile = await readJson<CursorFile>(cursorPath(stateDir));
  const secrets =
    (await readJson<CoordinatorSecrets>(secretsPath(stateDir))) ?? {};
  const cursor: CoordinatorCursor = {};
  for (const [addr, repo] of Object.entries(cursorFile?.repos ?? {})) {
    cursor[addr] = { ...repo, processed: boundProcessed(repo.processed ?? []) };
  }
  const inbox: InboxCursor = {
    ...(cursorFile?.inbox?.lastCreatedAt !== undefined
      ? { lastCreatedAt: cursorFile.inbox.lastCreatedAt }
      : {}),
    processed: boundProcessed(cursorFile?.inbox?.processed ?? []),
  };
  return { cursor, inbox, secrets };
}

/** Persist the repo cursors + inbox cursor (processed lists bounded). */
export async function saveCursor(
  stateDir: string,
  cursor: CoordinatorCursor,
  inbox: InboxCursor
): Promise<void> {
  const repos: CoordinatorCursor = {};
  for (const [addr, repo] of Object.entries(cursor)) {
    repos[addr] = { ...repo, processed: boundProcessed(repo.processed) };
  }
  const file: CursorFile = {
    repos,
    inbox: { ...inbox, processed: boundProcessed(inbox.processed) },
  };
  await writeJsonAtomic(cursorPath(stateDir), file);
}

/** Persist the secret inventories. */
export async function saveSecrets(
  stateDir: string,
  secrets: CoordinatorSecrets
): Promise<void> {
  await writeJsonAtomic(secretsPath(stateDir), secrets);
}
