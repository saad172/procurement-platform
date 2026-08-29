import { describe, expect, it } from 'vitest';
import { WEIGHTED_CRITERIA, WEIGHT_PRESETS, assertPresetsAreLegal } from '@/domain/score';

/**
 * SPEC §13.4 and §15.5 — the refuse-to-boot idiom.
 *
 * The test asserts that the validator **rejects**, not that each preset is
 * fine: a test that re-checks the constants would go stale beside them, while a
 * test that proves the guard works stays true however the constants change.
 */
describe('boot validation of the weight presets', () => {
  it('accepts the shipped presets', () => {
    expect(() => assertPresetsAreLegal()).not.toThrow();
  });

  it('rejects a preset that does not sum to 100', () => {
    const original = WEIGHT_PRESETS.balanced!;
    try {
      WEIGHT_PRESETS.balanced = { ...original, compliance_risk: original.compliance_risk + 1 };
      expect(() => assertPresetsAreLegal()).toThrow(/sums to 101, not 100/);
    } finally {
      WEIGHT_PRESETS.balanced = original;
    }
  });

  it('rejects a preset that has drifted away from the Criterion list', () => {
    // This is the exact failure that motivated presets being code constants: the
    // seed's presets summed to 101 and 112 after a Criterion was dropped, and a
    // stored row would have survived it silently.
    const original = WEIGHT_PRESETS.balanced!;
    try {
      const { proximity: _dropped, ...missingOne } = original;
      WEIGHT_PRESETS.balanced = missingOne as typeof original;
      expect(() => assertPresetsAreLegal()).toThrow(/does not quantify over exactly the six/);
    } finally {
      WEIGHT_PRESETS.balanced = original;
    }
  });

  it('quantifies over exactly the six weighted Criteria', () => {
    expect(WEIGHTED_CRITERIA).toHaveLength(6);
    expect(WEIGHTED_CRITERIA).not.toContain('data_confidence');
  });
});
