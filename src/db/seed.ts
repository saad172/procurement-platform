// Next.js loads `.env` itself; a plain Node entrypoint has to ask.
import 'dotenv/config';
import { eq } from 'drizzle-orm';
import { loadEnv } from '@/config/env';
import { closeDirectDb, getDirectDb, type Database } from './client';
import * as t from './schema';
import { CATEGORIES, CRITERIA, PLANTS, PROGRAM, TARIFF_FLAGS } from './seed-data/program';
import { ROSTER } from './seed-data/roster';
import { SEED_CREATED_AT, seedId } from './seed-data/ids';

/**
 * The seed (SPEC §3.1, §4.3, §20).
 *
 * Writes **only** the authored tables. Nothing else in the app writes to them,
 * and this file writes to nothing else — that convention is what the
 * authored/derived split buys, and it is worth more than two Postgres schemas
 * would have been.
 *
 * **Idempotent**: it keys on natural keys — the Program's name, a Plant's code,
 * a Category's code, a Supplier's roster index — so running it twice leaves the
 * database in the same state as running it once. It seeds at boot, which is why
 * that matters: the reviewer's first action is *Run*, not an import.
 *
 * It deliberately does not delete. A run that has happened is a derived row
 * hanging off these, and re-seeding must not discard it.
 *
 * **Ids are derived from those same natural keys** (`seed-data/ids.ts`), not
 * minted at random. Two databases seeded from this file therefore agree on the
 * ids as well as the columns — which is what makes a replay fixture portable
 * between them, and what stops a re-seed from silently renumbering a row that
 * a derived row already points at.
 */

async function seedProgram(db: Database): Promise<string> {
  const existing = await db.query.program.findFirst({
    where: eq(t.program.name, PROGRAM.name),
  });
  if (existing) return existing.id;

  const [row] = await db
    .insert(t.program)
    .values({
      id: seedId('program', PROGRAM.name),
      createdAt: SEED_CREATED_AT,
      name: PROGRAM.name,
      importingCountry: PROGRAM.importingCountry,
      vehicleClass: PROGRAM.vehicleClass,
      sourcingHorizon: PROGRAM.sourcingHorizon,
    })
    .returning({ id: t.program.id });
  return row!.id;
}

async function seedPlants(db: Database, programId: string): Promise<number> {
  await db
    .insert(t.plant)
    .values(
      PLANTS.map((p) => ({
        id: seedId('plant', p.code),
        createdAt: SEED_CREATED_AT,
        programId,
        code: p.code,
        role: p.role,
        city: p.city,
        country: p.country,
        lat: p.lat,
        lon: p.lon,
        // Authored, never geocoded. Every seeded Plant is a city centroid, and
        // the UI must say so rather than imply a surveyed point.
        precision: 'city' as const,
      })),
    )
    .onConflictDoNothing({ target: [t.plant.programId, t.plant.code] });
  return PLANTS.length;
}

async function seedCategories(db: Database, programId: string): Promise<Map<string, string>> {
  await db
    .insert(t.category)
    .values(
      CATEGORIES.map((c) => ({
        id: seedId('category', c.code),
        createdAt: SEED_CREATED_AT,
        programId,
        code: c.code,
        name: c.name,
        note: c.note,
      })),
    )
    .onConflictDoNothing({ target: [t.category.programId, t.category.code] });

  const rows = await db.query.category.findMany({ where: eq(t.category.programId, programId) });
  const byCode = new Map(rows.map((r) => [r.code, r.id]));

  for (const c of CATEGORIES) {
    const categoryId = byCode.get(c.code);
    if (!categoryId) continue;
    await db
      .insert(t.categoryHsLine)
      .values(
        c.hsLines.map((line) => ({
          id: seedId('category_hs_line', `${c.code}:${line.hsCode}`),
          createdAt: SEED_CREATED_AT,
          categoryId,
          hsCode: line.hsCode,
          label: line.label,
          // `numeric` round-trips as a string in postgres.js; 3.4 must stay 3.4.
          rate: line.rate.toFixed(3),
          isDefault: line.isDefault,
          note: 'note' in line ? line.note : null,
        })),
      )
      .onConflictDoNothing({ target: [t.categoryHsLine.categoryId, t.categoryHsLine.hsCode] });
  }
  return byCode;
}

async function seedCriteria(db: Database, programId: string): Promise<void> {
  await db
    .insert(t.criterion)
    .values(
      CRITERIA.map((c, i) => ({
        id: seedId('criterion', c.key),
        createdAt: SEED_CREATED_AT,
        key: c.key,
        label: c.label,
        blurb: c.blurb,
        isWeighted: c.isWeighted,
        sortOrder: i,
      })),
    )
    .onConflictDoNothing({ target: t.criterion.key });

  // Only the six weighted Criteria get a weight row. Data confidence is a
  // badge: giving it a row of 0 would invite someone to raise it.
  await db
    .insert(t.programCriterionWeight)
    .values(
      CRITERIA.filter((c) => c.isWeighted).map((c) => ({
        programId,
        criterionKey: c.key,
        weight: c.weight.toFixed(3),
      })),
    )
    .onConflictDoNothing({
      target: [t.programCriterionWeight.programId, t.programCriterionWeight.criterionKey],
    });
}

async function seedFlags(
  db: Database,
  categoriesByCode: Map<string, string>,
): Promise<void> {
  await db
    .insert(t.tariffFlag)
    .values(
      TARIFF_FLAGS.map((f, i) => ({
        id: seedId('tariff_flag', f.key),
        createdAt: SEED_CREATED_AT,
        key: f.key,
        label: f.label,
        whyNotARate: f.whyNotARate,
        sortOrder: i,
      })),
    )
    .onConflictDoNothing({ target: t.tariffFlag.key });

  const categoryLinks: { categoryId: string; flagKey: string }[] = [];
  const countryLinks: { country: string; flagKey: string }[] = [];

  for (const flag of TARIFF_FLAGS) {
    const codes =
      'appliesToAllCategories' in flag && flag.appliesToAllCategories
        ? CATEGORIES.map((c) => c.code)
        : 'categories' in flag
          ? [...flag.categories]
          : [];
    for (const code of codes) {
      const id = categoriesByCode.get(code);
      if (id) categoryLinks.push({ categoryId: id, flagKey: flag.key });
    }
    if ('countries' in flag) {
      for (const country of flag.countries) countryLinks.push({ country, flagKey: flag.key });
    }
  }

  if (categoryLinks.length > 0) {
    await db.insert(t.categoryFlag).values(categoryLinks).onConflictDoNothing();
  }
  if (countryLinks.length > 0) {
    await db.insert(t.countryFlag).values(countryLinks).onConflictDoNothing();
  }
}

async function seedSuppliers(
  db: Database,
  programId: string,
  categoriesByCode: Map<string, string>,
): Promise<{ suppliers: number; links: number }> {
  await db
    .insert(t.supplier)
    .values(
      ROSTER.map((row) => ({
        id: seedId('supplier', String(row.index)),
        createdAt: SEED_CREATED_AT,
        programId,
        origin: 'imported' as const,
        rosterIndex: row.index,
        rosterName: row.name,
        rosterAddress: row.address,
        rosterCountry: row.country,
      })),
    )
    .onConflictDoNothing({ target: [t.supplier.programId, t.supplier.rosterIndex] });

  const rows = await db.query.supplier.findMany({ where: eq(t.supplier.programId, programId) });
  const byIndex = new Map(rows.filter((r) => r.rosterIndex != null).map((r) => [r.rosterIndex!, r.id]));

  const links: { supplierId: string; categoryId: string }[] = [];
  for (const row of ROSTER) {
    const supplierId = byIndex.get(row.index);
    if (!supplierId) continue;
    for (const code of row.categories) {
      const categoryId = categoriesByCode.get(code);
      if (categoryId) links.push({ supplierId, categoryId });
    }
  }
  if (links.length > 0) {
    await db.insert(t.supplierCategory).values(links).onConflictDoNothing();
  }
  return { suppliers: ROSTER.length, links: links.length };
}

/** Runs every step. Exported so a boot hook and a test can both call it. */
export async function seed(db: Database): Promise<void> {
  const programId = await seedProgram(db);
  const plants = await seedPlants(db, programId);
  const categoriesByCode = await seedCategories(db, programId);
  await seedCriteria(db, programId);
  await seedFlags(db, categoriesByCode);
  const { suppliers, links } = await seedSuppliers(db, programId, categoriesByCode);

  const uncategorised = ROSTER.filter((r) => r.categories.length === 0).length;
  console.log(
    `Seeded "${PROGRAM.name}": ${plants} plants · ${categoriesByCode.size} categories · ` +
      `${suppliers} suppliers (${suppliers - uncategorised} mapped, ${uncategorised} deliberately uncategorised) · ` +
      `${links} supplier-category links.`,
  );
}

async function main(): Promise<void> {
  loadEnv();
  await seed(getDirectDb());
  await closeDirectDb();
}

// Only run when invoked directly, so importing `seed` from a test does not
// open a connection to the development database.
if (process.argv[1]?.includes('seed')) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
