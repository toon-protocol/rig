import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  countEslintViolations,
  countTypecheckErrors,
  evaluateCorrectness,
} from './correctness.ts';

describe('countEslintViolations', () => {
  it('sums errorCount/warningCount across the eslint JSON report', () => {
    const json = JSON.stringify([
      { filePath: 'a.ts', errorCount: 2, warningCount: 1 },
      { filePath: 'b.ts', errorCount: 0, warningCount: 5 },
    ]);
    assert.deepEqual(countEslintViolations(json), { errors: 2, warnings: 6 });
  });

  it('returns zero counts for an empty report', () => {
    assert.deepEqual(countEslintViolations('[]'), { errors: 0, warnings: 0 });
  });
});

describe('countTypecheckErrors', () => {
  it('counts one match per "error TSxxxx:" occurrence', () => {
    const output = [
      'packages/rig typecheck$ tsc --noEmit',
      'src/cli/output.ts(281,45): error TS2345: Argument of type mismatch.',
      'src/foo.ts(10,1): error TS2322: Type mismatch.',
      'packages/rig typecheck: Failed',
    ].join('\n');
    assert.equal(countTypecheckErrors(output), 2);
  });

  it('returns 0 when there is no error output (typecheck passed)', () => {
    assert.equal(countTypecheckErrors('packages/rig typecheck$ tsc --noEmit\n'), 0);
  });
});

describe('evaluateCorrectness', () => {
  const baseline = {
    correctness: { eslintErrors: 4, eslintWarnings: 356, typecheckErrors: 1 },
  };

  it('passes when counts match the frozen baseline exactly', () => {
    const result = evaluateCorrectness(
      { eslintErrors: 4, eslintWarnings: 356, typecheckErrors: 1 },
      baseline,
    );
    assert.equal(result.pass, true);
    assert.deepEqual(result.violations, []);
  });

  it('passes when counts are below the frozen baseline (debt paid down)', () => {
    const result = evaluateCorrectness(
      { eslintErrors: 0, eslintWarnings: 0, typecheckErrors: 0 },
      baseline,
    );
    assert.equal(result.pass, true);
  });

  it('fails on a new eslint error beyond the frozen allowlist', () => {
    const result = evaluateCorrectness(
      { eslintErrors: 5, eslintWarnings: 356, typecheckErrors: 1 },
      baseline,
    );
    assert.equal(result.pass, false);
    assert.equal(result.violations.length, 1);
    assert.match(result.violations[0], /eslint errors 5 > baseline 4/);
  });

  it('fails on a new typecheck error beyond the frozen allowlist', () => {
    const result = evaluateCorrectness(
      { eslintErrors: 4, eslintWarnings: 356, typecheckErrors: 2 },
      baseline,
    );
    assert.equal(result.pass, false);
    assert.match(result.violations[0], /typecheck errors 2 > baseline 1/);
  });

  it('reports every violated dimension, not just the first', () => {
    const result = evaluateCorrectness(
      { eslintErrors: 5, eslintWarnings: 400, typecheckErrors: 2 },
      baseline,
    );
    assert.equal(result.violations.length, 3);
  });
});
