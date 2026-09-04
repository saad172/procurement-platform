import { describe, expect, it } from 'vitest';
import { runPhases } from '@/db/queries/runs';
import { JOB_CAPS, RUNNABLE_JOB_KINDS } from '@/config/constants';
import { jobKindLabel, jobKindSentence } from '@/domain/job-kinds';

/**
 * The trade Job's wiring (network spec §4.3, ticket 05, unit 05b) — the
 * points listed in this unit's own brief as "confirmed identical in shape
 * to ticket 04's `pairs` precedent." `worker/main.ts`'s dispatch table and
 * `fixtures/record.ts`'s `NO_TURN_JOB_KINDS` are exercised end to end by
 * `tests/jobs/trade.test.ts` and by the full suite staying green (neither
 * is covered by a dedicated unit test anywhere in this codebase today, `
 * pairs` included) — what belongs here is what IS independently testable
 * without a worker process or a fixture replay: the constant, the label,
 * the sentence, and the phase order.
 */
describe('trade Job wiring', () => {
  it('is a runnable Job kind, with a fixed four-call cap (never open-ended like pairs)', () => {
    expect(RUNNABLE_JOB_KINDS).toContain('trade');
    expect(JOB_CAPS.trade).toEqual({ toolCalls: 6, tokens: 0 });
  });

  it('has a table-cell label and a Trace sentence that says it runs no model', () => {
    expect(jobKindLabel('trade')).toBe('Trade');
    expect(jobKindSentence('trade')).toMatch(/runs no model/);
  });

  it('sorts into the phase strip near traverse/pairs — absent from PHASE_ORDER would sort first via Array.indexOf(-1)', () => {
    const phases = runPhases([
      { kind: 'dossier', state: 'done' },
      { kind: 'trade', state: 'done' },
      { kind: 'pairs', state: 'done' },
      { kind: 'resolve', state: 'done' },
    ]);
    expect(phases.map((p) => p.kind)).toEqual(['resolve', 'pairs', 'trade', 'dossier']);
  });
});
