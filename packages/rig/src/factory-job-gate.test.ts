import { describe, it, expect } from 'vitest';
import { gatePassed, type GateResult } from './factory-job-gate.js';

const COMMIT = 'a'.repeat(40);

describe('gatePassed', () => {
  it('is true when every check passed', () => {
    const gate: GateResult = {
      commit: COMMIT,
      toolchain: { node: '20.11.0', pnpm: '9.1.0' },
      checks: [
        { name: 'lint', command: 'eslint .', pass: true },
        { name: 'typecheck', command: 'pnpm run typecheck', pass: true },
      ],
    };

    expect(gatePassed(gate)).toBe(true);
  });

  it('is false when any check failed', () => {
    const gate: GateResult = {
      commit: COMMIT,
      toolchain: { node: '20.11.0', pnpm: '9.1.0' },
      checks: [
        { name: 'lint', command: 'eslint .', pass: true },
        { name: 'test', command: 'pnpm -r test --if-present', pass: false },
      ],
    };

    expect(gatePassed(gate)).toBe(false);
  });

  it('is true for zero checks (vacuous — callers reject empty checks separately)', () => {
    const gate: GateResult = { commit: COMMIT, toolchain: {}, checks: [] };

    expect(gatePassed(gate)).toBe(true);
  });
});
