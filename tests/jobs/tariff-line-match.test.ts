import { describe, expect, it } from 'vitest';
import * as t from '@/db/schema';
import { getTestDb, testDatabaseIsUp } from '../support/test-db';
import { resetDerived } from '../support/reset';
import { buildAssessableSupplier } from '../support/pipeline';

/**
 * **The tariff row says which HTS line its rate came from** (SPEC §7.1).
 *
 * `chooseHtsLine` is tested on its own in `tests/domain/hs-code.test.ts`; what
 * this pins is that the Enrichment writes down what it chose. The rate for the
 * wire-harness Category is asked for as the six-digit `8544.30` and answered
 * by the ten-digit `8544.30.00.00`, and until now the row recorded only the
 * question and the number — so *"5% on 8544.30"* and *"5% on 8544.30.00.00,
 * asked as 8544.30"* were stored identically, and a widening that reached a
 * different product would have looked exactly the same.
 */

const ROSTER_NAME = 'Yazaki';

describe('the tariff Enrichment records the line it read the rate from', () => {
  it('stores the answering HTS line and that it sits beneath the code asked for', async () => {
    if (!(await testDatabaseIsUp())) return;
    const db = await getTestDb();

    await resetDerived(db);
    await buildAssessableSupplier(db, ROSTER_NAME);

    const rows = await db.select().from(t.tariffLine);
    expect(rows.length, 'the fan-out should have written a tariff line').toBeGreaterThan(0);

    const har = rows.find((row) => row.hsCode === '8544.30');
    expect(har, "the Yazaki fixture's Category is the wire-harness line").toBeTruthy();
    expect(har!.matchedHtsno).toBe('8544.30.00.00');
    expect(har!.matchedBy).toBe('sub_line');
    // And the rate is unchanged by preferring the exact line first: the source
    // returns no `8544.30` row, so the sub-line is still the one that answers.
    expect(har!.mfnRate).toBe('5.000');
  });
});
