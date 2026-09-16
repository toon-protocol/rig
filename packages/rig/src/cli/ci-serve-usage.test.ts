/**
 * `rig ci serve` usage (#133 — CI 8): the operational defaults an operator
 * relies on are documented in the CLI help, and the help quotes the
 * coordinator's own constants so the two cannot drift apart.
 */

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_CONCURRENCY,
  DEFAULT_RUN_TIMEOUT_MS,
} from '../ci/coordinator.js';
import { CI_SERVE_USAGE } from './ci-serve.js';

describe('rig ci serve usage: operational defaults', () => {
  it('documents the concurrency and wall-clock defaults as the coordinator defines them', () => {
    expect(DEFAULT_CONCURRENCY).toBe(1);
    expect(DEFAULT_RUN_TIMEOUT_MS).toBe(1800 * 1000);
    expect(CI_SERVE_USAGE).toMatch(
      new RegExp(
        String.raw`--concurrency <n>\s+runs executed at once \(default ${DEFAULT_CONCURRENCY}\); more queue`
      )
    );
    expect(CI_SERVE_USAGE).toMatch(
      new RegExp(
        String.raw`--timeout <seconds>\s+wall-clock budget per run → timed_out\s+\(default ${DEFAULT_RUN_TIMEOUT_MS / 1000}\)`
      )
    );
  });
});
