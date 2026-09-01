import { eq } from 'drizzle-orm';
import * as t from './schema';
import type { Database } from './client';
import { SEED_CREATED_AT, seedId } from './seed-data/ids';
import { TEST_CATEGORY, TEST_PROGRAM, TEST_SUPPLIERS } from './seed-data/test-program';

/**
 * Seeds the test-only Program (SPEC §19.3).
 *
 * Separate from `seed.ts` on purpose: that file writes the **approved** seed and
 * nothing else, and `seed-facts.test.ts` asserts three published findings about
 * exactly those fifty rows. This is called by the fixture recorder and by the
 * tests that replay against it, never at boot.
 *
 * Idempotent and deterministically keyed, like the real seed.
 */
export async function seedTestProgram(db: Database): Promise<string> {
  await db
    .insert(t.program)
    .values({
      id: TEST_PROGRAM.id,
      name: TEST_PROGRAM.name,
      importingCountry: TEST_PROGRAM.importingCountry,
      vehicleClass: TEST_PROGRAM.vehicleClass,
      sourcingHorizon: TEST_PROGRAM.sourcingHorizon,
      createdAt: SEED_CREATED_AT,
    })
    .onConflictDoNothing({ target: t.program.id });

  await db
    .insert(t.category)
    .values({
      id: TEST_CATEGORY.id,
      programId: TEST_PROGRAM.id,
      code: TEST_CATEGORY.code,
      name: TEST_CATEGORY.name,
      note: TEST_CATEGORY.note,
      createdAt: SEED_CREATED_AT,
    })
    .onConflictDoNothing({ target: [t.category.programId, t.category.code] });

  await db
    .insert(t.categoryHsLine)
    .values(
      TEST_CATEGORY.hsLines.map((line) => ({
        id: seedId('category_hs_line', `${TEST_CATEGORY.code}:${line.hsCode}`),
        categoryId: TEST_CATEGORY.id,
        hsCode: line.hsCode,
        label: line.label,
        // `numeric` round-trips as a string in postgres.js.
        rate: line.rate.toFixed(3),
        isDefault: line.isDefault,
        createdAt: SEED_CREATED_AT,
      })),
    )
    .onConflictDoNothing({ target: [t.categoryHsLine.categoryId, t.categoryHsLine.hsCode] });

  await db
    .insert(t.supplier)
    .values(
      TEST_SUPPLIERS.map((row) => ({
        id: seedId('supplier', `FIXTURE:${row.index}`),
        programId: TEST_PROGRAM.id,
        origin: 'imported' as const,
        rosterIndex: row.index,
        rosterName: row.name,
        rosterAddress: row.address,
        rosterCountry: row.country,
        createdAt: SEED_CREATED_AT,
      })),
    )
    .onConflictDoNothing({ target: [t.supplier.programId, t.supplier.rosterIndex] });

  const suppliers = await db.query.supplier.findMany({ where: eq(t.supplier.programId, TEST_PROGRAM.id) });
  const links = suppliers
    .filter((row) => row.rosterIndex != null)
    .map((row) => ({ supplierId: row.id, categoryId: TEST_CATEGORY.id }));
  if (links.length > 0) {
    await db.insert(t.supplierCategory).values(links).onConflictDoNothing();
  }

  return TEST_PROGRAM.id;
}
