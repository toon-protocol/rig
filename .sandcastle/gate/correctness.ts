// Correctness gate (ADR-0001 baseline-freeze): eslint + typecheck violation
// counts must not exceed the frozen allowlist in .sandcastle/gate-baseline.json.
// Pre-existing debt passes; only NEW violations fail the gate.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { BASELINE_PATH, REPO_ROOT } from './paths.ts';

export interface CorrectnessCounts {
  eslintErrors: number;
  eslintWarnings: number;
  typecheckErrors: number;
}

export interface CorrectnessBaseline {
  correctness: {
    eslintErrors: number;
    eslintWarnings: number;
    typecheckErrors: number;
  };
}

interface EslintFileResult {
  errorCount: number;
  warningCount: number;
}

export function loadBaseline(baselinePath: string = BASELINE_PATH): CorrectnessBaseline {
  return JSON.parse(readFileSync(baselinePath, 'utf8')) as CorrectnessBaseline;
}

export function countEslintViolations(json: string): { errors: number; warnings: number } {
  const results = JSON.parse(json) as EslintFileResult[];
  return results.reduce(
    (acc, file) => ({
      errors: acc.errors + file.errorCount,
      warnings: acc.warnings + file.warningCount,
    }),
    { errors: 0, warnings: 0 },
  );
}

export function countTypecheckErrors(output: string): number {
  const matches = output.match(/error TS\d+:/g);
  return matches ? matches.length : 0;
}

export function evaluateCorrectness(
  counts: CorrectnessCounts,
  baseline: CorrectnessBaseline,
): { pass: boolean; violations: string[] } {
  const violations: string[] = [];
  if (counts.eslintErrors > baseline.correctness.eslintErrors) {
    violations.push(
      `eslint errors ${counts.eslintErrors} > baseline ${baseline.correctness.eslintErrors}`,
    );
  }
  if (counts.eslintWarnings > baseline.correctness.eslintWarnings) {
    violations.push(
      `eslint warnings ${counts.eslintWarnings} > baseline ${baseline.correctness.eslintWarnings}`,
    );
  }
  if (counts.typecheckErrors > baseline.correctness.typecheckErrors) {
    violations.push(
      `typecheck errors ${counts.typecheckErrors} > baseline ${baseline.correctness.typecheckErrors}`,
    );
  }
  return { pass: violations.length === 0, violations };
}

function runEslint(cwd: string): { errors: number; warnings: number } {
  let json: string;
  try {
    json = execFileSync('npx', ['eslint', '.', '-f', 'json'], { cwd, encoding: 'utf8' });
  } catch (err) {
    // eslint exits 1 when there are lint errors; stdout still carries the JSON report.
    const stdout = (err as { stdout?: string }).stdout;
    if (!stdout) throw err;
    json = stdout;
  }
  return countEslintViolations(json);
}

function runTypecheck(cwd: string): number {
  try {
    execFileSync('pnpm', ['run', 'typecheck'], { cwd, encoding: 'utf8' });
    return 0;
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    return countTypecheckErrors(`${e.stdout ?? ''}\n${e.stderr ?? ''}`);
  }
}

function main(): void {
  const baseline = loadBaseline();
  const eslint = runEslint(REPO_ROOT);
  const typecheckErrors = runTypecheck(REPO_ROOT);
  const counts: CorrectnessCounts = {
    eslintErrors: eslint.errors,
    eslintWarnings: eslint.warnings,
    typecheckErrors,
  };
  const { pass, violations } = evaluateCorrectness(counts, baseline);

  console.log(
    `correctness gate: eslint ${counts.eslintErrors}e/${counts.eslintWarnings}w, ` +
      `typecheck ${counts.typecheckErrors}e ` +
      `(baseline: ${baseline.correctness.eslintErrors}e/${baseline.correctness.eslintWarnings}w, ` +
      `${baseline.correctness.typecheckErrors}e)`,
  );

  if (!pass) {
    console.error('correctness gate FAILED: new violations beyond the frozen baseline');
    for (const v of violations) console.error(`  - ${v}`);
    process.exit(1);
  }
  console.log('correctness gate PASSED (no new violations)');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
