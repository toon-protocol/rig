// Speed/performance no-regression guard (ADR-0001): fails the gate when the
// gate's wall-clock or derived runner-minutes regress beyond a tolerance of
// the frozen baseline in .sandcastle/gate-baseline.json. Reads only the
// frozen baseline numbers (never a live/recomputed threshold) so the same
// commit always earns the same verdict.
import { readFileSync } from 'node:fs';
import { BASELINE_PATH } from './paths.ts';

// How far above the frozen baseline a run may drift before it's a regression.
export const TOLERANCE = 0.2;

export interface RegressionInputs {
  wallClockSeconds: number;
}

export interface RegressionBaseline {
  speed: { gateWallClockSeconds: number };
  performance: {
    runnerMinutes: number;
    dockerImageSizeBytes: number | null;
    cacheHitRatePercent: number | null;
  };
}

export function loadBaseline(baselinePath: string = BASELINE_PATH): RegressionBaseline {
  return JSON.parse(readFileSync(baselinePath, 'utf8')) as RegressionBaseline;
}

export function evaluateRegression(
  inputs: RegressionInputs,
  baseline: RegressionBaseline,
): { pass: boolean; violations: string[]; runnerMinutes: number } {
  const violations: string[] = [];

  const wallClockLimit = baseline.speed.gateWallClockSeconds * (1 + TOLERANCE);
  if (inputs.wallClockSeconds > wallClockLimit) {
    violations.push(
      `gate wall-clock ${inputs.wallClockSeconds}s > ${wallClockLimit}s ` +
        `(baseline ${baseline.speed.gateWallClockSeconds}s + ${TOLERANCE * 100}% tolerance)`,
    );
  }

  const runnerMinutes = Math.ceil(inputs.wallClockSeconds / 60);
  // runnerMinutes is itself ceil()'d to whole billable minutes, so the limit
  // must be too -- otherwise rounding makes the tolerance far stricter than
  // intended (e.g. a 2-minute baseline would reject any 3rd minute at all).
  const runnerMinutesLimit = Math.ceil(baseline.performance.runnerMinutes * (1 + TOLERANCE));
  if (runnerMinutes > runnerMinutesLimit) {
    violations.push(
      `runner-minutes ${runnerMinutes} > ${runnerMinutesLimit} ` +
        `(baseline ${baseline.performance.runnerMinutes} + ${TOLERANCE * 100}% tolerance)`,
    );
  }

  // dockerImageSizeBytes / cacheHitRatePercent are frozen as null (N/A) for
  // this repo's gate (no Docker build / remote cache in ci.yml) — nothing to
  // compare against, so they're intentionally skipped rather than defaulted.

  return { pass: violations.length === 0, violations, runnerMinutes };
}

function main(): void {
  const raw = process.env.GATE_WALL_CLOCK_SECONDS;
  if (!raw || Number.isNaN(Number(raw))) {
    console.error(
      'regression guard FAILED: GATE_WALL_CLOCK_SECONDS is not set to a number ' +
        '(the CI step must measure and pass the actual wall-clock)',
    );
    process.exit(1);
  }

  const baseline = loadBaseline();
  const inputs: RegressionInputs = { wallClockSeconds: Number(raw) };
  const { pass, violations, runnerMinutes } = evaluateRegression(inputs, baseline);

  console.log(
    `regression guard: wall-clock ${inputs.wallClockSeconds}s, runner-minutes ${runnerMinutes} ` +
      `(baseline: ${baseline.speed.gateWallClockSeconds}s, ${baseline.performance.runnerMinutes}m, ` +
      `+${TOLERANCE * 100}% tolerance)`,
  );

  if (!pass) {
    console.error('regression guard FAILED: gate speed/performance regressed beyond the frozen baseline');
    for (const v of violations) console.error(`  - ${v}`);
    process.exit(1);
  }
  console.log('regression guard PASSED (no speed/performance regression)');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
