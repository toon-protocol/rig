import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateRegression, TOLERANCE } from './regression.ts';

describe('evaluateRegression', () => {
  const baseline = {
    speed: { gateWallClockSeconds: 103 },
    performance: {
      runnerMinutes: 2,
      dockerImageSizeBytes: null,
      cacheHitRatePercent: null,
    },
  };

  it('passes when wall-clock matches the frozen baseline exactly', () => {
    const result = evaluateRegression({ wallClockSeconds: 103 }, baseline);
    assert.equal(result.pass, true);
    assert.deepEqual(result.violations, []);
  });

  it('passes when wall-clock is faster than the baseline', () => {
    const result = evaluateRegression({ wallClockSeconds: 50 }, baseline);
    assert.equal(result.pass, true);
  });

  it('passes within tolerance above the baseline', () => {
    const withinTolerance = Math.floor(103 * (1 + TOLERANCE));
    const result = evaluateRegression({ wallClockSeconds: withinTolerance }, baseline);
    assert.equal(result.pass, true);
  });

  it('fails wall-clock regression beyond the tolerance', () => {
    const beyondTolerance = Math.ceil(103 * (1 + TOLERANCE)) + 1;
    const result = evaluateRegression({ wallClockSeconds: beyondTolerance }, baseline);
    assert.equal(result.pass, false);
    assert.match(result.violations[0], /gate wall-clock/);
  });

  it('fails runner-minutes regression beyond the tolerance', () => {
    // 103s baseline -> 2 runner-minutes; 500s -> ceil(500/60) = 9 minutes, way past 2 * 1.2
    const result = evaluateRegression({ wallClockSeconds: 500 }, baseline);
    assert.equal(result.pass, false);
    assert.ok(result.violations.some((v) => /runner-minutes/.test(v)));
  });

  it('derives runnerMinutes as ceil(wallClockSeconds / 60)', () => {
    const result = evaluateRegression({ wallClockSeconds: 61 }, baseline);
    assert.equal(result.runnerMinutes, 2);
  });

  it('skips dockerImageSize/cacheHitRate checks when baseline records them as null (N/A)', () => {
    const result = evaluateRegression({ wallClockSeconds: 103 }, baseline);
    assert.equal(result.pass, true);
    assert.deepEqual(result.violations, []);
  });

  it('is deterministic: the same inputs against the same baseline always produce the same verdict', () => {
    const a = evaluateRegression({ wallClockSeconds: 200 }, baseline);
    const b = evaluateRegression({ wallClockSeconds: 200 }, baseline);
    assert.deepEqual(a, b);
  });
});
