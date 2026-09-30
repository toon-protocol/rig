// The runner's gate must be CI's `build` job, not something similar to it. This reads
// ci.yml and compares, so the two cannot drift apart unnoticed.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from './paths.ts';
import { fixPrompt, GATE_STEPS, runGate } from '../run-gate.ts';

/** The `run:` commands of ci.yml's `build` job, in order, minus the regression guard. */
function buildJobCommands(): string[] {
  const yml = readFileSync(
    path.join(REPO_ROOT, '.github', 'workflows', 'ci.yml'),
    'utf8'
  );
  const job = /^ {2}build:\n([\s\S]*?)(?=^ {2}\S)/m.exec(yml);
  assert.ok(job, 'ci.yml has no `build` job');
  return [...job[1]!.matchAll(/^ {6}- run: (.+)$/gm)].map((m) => m[1]!.trim());
}

describe('GATE_STEPS', () => {
  it("runs the commands of ci.yml's build job, in the same order", () => {
    assert.deepEqual(
      GATE_STEPS.map((s) => s.command),
      buildJobCommands()
    );
  });
});

type Exec = (
  cmd: string
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

function sandboxWith(exec: Exec) {
  return { exec } as unknown as Parameters<typeof runGate>[0];
}

describe('runGate', () => {
  it('runs every step and passes when all exit zero', async () => {
    const seen: string[] = [];
    const result = await runGate(
      sandboxWith(async (cmd) => {
        seen.push(cmd);
        return { exitCode: 0, stdout: '', stderr: '' };
      })
    );
    assert.equal(result.passed, true);
    assert.deepEqual(
      seen,
      GATE_STEPS.map((s) => s.command)
    );
  });

  it('stops at the first red step and reports it', async () => {
    const seen: string[] = [];
    const result = await runGate(
      sandboxWith(async (cmd) => {
        seen.push(cmd);
        return cmd === 'pnpm -r build'
          ? { exitCode: 2, stdout: 'boom', stderr: '' }
          : { exitCode: 0, stdout: '', stderr: '' };
      })
    );
    assert.equal(result.passed, false);
    assert.equal(result.failure?.command, 'pnpm -r build');
    assert.equal(result.failure?.exitCode, 2);
    assert.equal(seen.at(-1), 'pnpm -r build');
  });
});

describe('fixPrompt', () => {
  it('names the failing command and forbids weakening a test', () => {
    const text = fixPrompt(
      { step: 'build', command: 'pnpm -r build', exitCode: 2, output: 'boom' },
      1,
      2
    );
    assert.match(text, /pnpm -r build/);
    assert.match(text, /Do NOT weaken/);
  });
});
