/**
 * Coordinator state persistence (#125): the cursor + secret inventory files
 * under the coordinator's state directory survive a restart, are written
 * atomically, and a missing directory is an empty state, not an error.
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  cursorPath,
  defaultCoordinatorStateDir,
  loadCoordinatorState,
  saveCursor,
  saveSecrets,
  secretsPath,
} from './state.js';

const cleanups: string[] = [];
afterEach(() => {
  for (const dir of cleanups.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rig-ci-state-'));
  cleanups.push(dir);
  return join(dir, 'nested', 'state'); // does not exist yet — must be created
}

const ADDR = `30617:${'ab'.repeat(32)}:demo`;

describe('coordinator state', () => {
  it('loads an empty state when nothing was ever saved', async () => {
    const dir = tempDir();
    const state = await loadCoordinatorState(dir);
    expect(state.cursor).toEqual({});
    expect(state.secrets).toEqual({});
    expect(state.inbox).toEqual({ processed: [] });
  });

  it('round-trips the cursor and secrets through disk', async () => {
    const dir = tempDir();
    const cursor = {
      [ADDR]: {
        lastCreatedAt: 1234,
        lastEventId: 'e1'.repeat(32),
        refs: { 'refs/heads/main': 'a'.repeat(40) },
        processed: ['e1'.repeat(32)],
      },
    };
    const secrets = {
      [ADDR]: {
        TOKEN: {
          value: 'hunter2',
          createdAt: 10,
          eventId: 'f1'.repeat(32),
          origin: 'cd'.repeat(32),
        },
      },
    };
    await saveCursor(dir, cursor, {
      lastCreatedAt: 99,
      processed: ['aa'.repeat(32)],
    });
    await saveSecrets(dir, secrets);

    const state = await loadCoordinatorState(dir);
    expect(state.cursor).toEqual(cursor);
    expect(state.secrets).toEqual(secrets);
    expect(state.inbox).toEqual({
      lastCreatedAt: 99,
      processed: ['aa'.repeat(32)],
    });
    // Written atomically: no temp files linger next to the real ones.
    expect(readdirSync(dir).sort()).toEqual(['cursor.json', 'secrets.json']);
    expect(existsSync(cursorPath(dir))).toBe(true);
    expect(existsSync(secretsPath(dir))).toBe(true);
  });

  it('treats a corrupt file as an error rather than silently starting over', async () => {
    const dir = tempDir();
    await saveCursor(dir, {}, { processed: [] });
    writeFileSync(cursorPath(dir), '{not json');
    await expect(loadCoordinatorState(dir)).rejects.toThrow(/cursor\.json/);
  });

  it('bounds the processed-id lists it writes', async () => {
    const dir = tempDir();
    const processed = Array.from({ length: 3000 }, (_, i) =>
      String(i).padStart(64, '0')
    );
    await saveCursor(
      dir,
      { [ADDR]: { lastCreatedAt: 1, lastEventId: '', refs: {}, processed } },
      {
        processed,
      }
    );
    const state = await loadCoordinatorState(dir);
    const kept = state.cursor[ADDR]?.processed ?? [];
    expect(kept.length).toBeLessThanOrEqual(1000);
    // The NEWEST ids survive (the tail of the list).
    expect(kept[kept.length - 1]).toBe(processed[processed.length - 1]);
    expect(state.inbox.processed.length).toBeLessThanOrEqual(1000);
    expect(JSON.parse(readFileSync(cursorPath(dir), 'utf-8'))).toHaveProperty(
      'repos'
    );
  });

  it('derives the default state dir from TOON_CLIENT_HOME and the coordinator pubkey', () => {
    const pk = 'ab'.repeat(32);
    expect(
      defaultCoordinatorStateDir({ TOON_CLIENT_HOME: '/x/home' }, pk)
    ).toBe(join('/x/home', 'rig-ci', pk));
  });
});
