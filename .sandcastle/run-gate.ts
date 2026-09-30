// The gate, run DETERMINISTICALLY by the runner, not asked of the agent.
//
// An agent's "I ran the tests" is a self-report. The runner runs CI's own
// commands instead, and a red gate never becomes a PR.
//
// The steps are the commands of ci.yml's `build` job, in the same order. A gate that
// runs something similar to CI teaches the agent the wrong lesson, so
// gate/run-gate.test.ts fails the build if this list and that job ever drift.
// The job's last step, the speed/performance no-regression guard, is left out on
// purpose: it compares the gate's wall-clock against a frozen baseline measured on a
// CI runner, which says nothing about a sandbox.
//
// Unlike a path-aware gate, this one is not filtered by what changed. rig has two
// packages that build together, and the correctness gate is repo-wide.

import type * as sandcastle from '@ai-hero/sandcastle';

type Sandbox = Awaited<ReturnType<typeof sandcastle.createSandbox>>;

export interface GateStep {
  readonly name: string;
  readonly command: string;
}

export interface GateFailure {
  readonly step: string;
  readonly command: string;
  readonly exitCode: number;
  /** Tail of combined output — enough for an agent to act on, bounded so it cannot blow a prompt. */
  readonly output: string;
}

export interface GateResult {
  readonly passed: boolean;
  readonly ran: readonly string[];
  readonly failure: GateFailure | null;
}

/** Keep fed-back output useful but bounded: a full build log is megabytes. */
const MAX_OUTPUT_CHARS = 12_000;

/**
 * ci.yml's `build` job, minus the wall-clock regression guard. `.sandcastle/gate/`
 * is rig's own gate, so it is called here and not re-implemented.
 */
export const GATE_STEPS: readonly GateStep[] = [
  { name: 'gate tests', command: 'npx tsx --test .sandcastle/gate/*.test.ts' },
  {
    name: 'correctness gate',
    command: 'npx tsx .sandcastle/gate/correctness.ts',
  },
  { name: 'build', command: 'pnpm -r build' },
  { name: 'test', command: 'pnpm -r test --if-present' },
];

/**
 * Run `steps` in order, stopping at the first failure.
 *
 * Failure is returned, not thrown, so the caller can decide between a fix
 * iteration and failing the job.
 */
export async function runGate(
  sandbox: Sandbox,
  steps: readonly GateStep[] = GATE_STEPS
): Promise<GateResult> {
  const ran: string[] = [];

  for (const step of steps) {
    console.log(`  [gate] ${step.name}: ${step.command}`);
    const lines: string[] = [];
    const result = await sandbox.exec(step.command, {
      onLine: (line) => {
        lines.push(line);
        // Stream sparingly: full build output would bury the runner log.
        if (lines.length <= 40) console.log(`    | ${line}`);
      },
    });
    ran.push(step.name);

    if (result.exitCode !== 0) {
      const combined = [result.stdout, result.stderr]
        .filter(Boolean)
        .join('\n');
      const output =
        combined.length > MAX_OUTPUT_CHARS
          ? `...(truncated to the last ${MAX_OUTPUT_CHARS} chars)...\n` +
            combined.slice(-MAX_OUTPUT_CHARS)
          : combined;

      console.log(`  [gate] FAILED at ${step.name} (exit ${result.exitCode}).`);
      return {
        passed: false,
        ran,
        failure: {
          step: step.name,
          command: step.command,
          exitCode: result.exitCode,
          output,
        },
      };
    }
  }

  console.log(
    `  [gate] PASSED (${ran.length} step(s): ${ran.join(', ') || 'none'}).`
  );
  return { passed: true, ran, failure: null };
}

/** The prompt handed to a fix iteration. Concrete failure, no room to reinterpret the task. */
export function fixPrompt(
  failure: GateFailure,
  attempt: number,
  maxAttempts: number
): string {
  return [
    `The repository gate is RED. This is fix attempt ${attempt} of ${maxAttempts}.`,
    '',
    `Failing step: ${failure.step}`,
    `Command:      ${failure.command}`,
    `Exit code:    ${failure.exitCode}`,
    '',
    'Output:',
    '```',
    failure.output,
    '```',
    '',
    'Fix the cause and commit. Rules:',
    `- Re-run \`${failure.command}\` yourself and confirm it passes before you finish.`,
    '- Fix the code. Do NOT weaken, skip, delete or `.skip` a test, and do not',
    '  loosen a lint to make this pass — if the test is genuinely wrong, say so',
    '  explicitly in the commit message and explain why.',
    '- Change only what this failure requires. Do not refactor beyond it.',
    '- If you cannot fix it, commit nothing and explain what is blocking you.',
  ].join('\n');
}
