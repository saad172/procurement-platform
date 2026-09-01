// Next.js loads `.env` itself; a plain Node entrypoint has to ask.
import 'dotenv/config';
import { and, eq } from 'drizzle-orm';
import { loadEnv } from '@/config/env';
import { closeDirectDb, getDirectDb } from '@/db/client';
import * as t from '@/db/schema';
import { PROGRAM } from '@/db/seed-data/program';
import { createUpstream } from '@/upstream';
import { openRun } from '@/jobs/runs';
import { enrichSupplier } from '@/jobs/enrich-supplier';
import { computeFamilyExposure, describeFamilyExposure, unionRiskFactors } from '@/domain/family';
import { settleMatch } from '@/domain/match/settle-match';
import { parseRiskObject } from '@/domain/scoring/risk-factors';

/**
 * The enrichment fan-out and the Corporate family, against the real graph.
 *
 *   pnpm smoke:enrich [rosterName] [sayariEntityId]
 *
 * **It spends Sayari credits.** Supplying an entity id settles the Match by
 * hand first, so the fan-out can be exercised on a Supplier the resolve loop
 * has not yet reached — which is what a person does on the Needs Review page.
 */

async function main(): Promise<void> {
  const env = loadEnv();
  const db = getDirectDb();
  const rosterName = process.argv[2] ?? 'Yazaki';
  const forceEntityId = process.argv[3];

  const program = await db.query.program.findFirst({ where: eq(t.program.name, PROGRAM.name) });
  if (!program) throw new Error('Seed the database first: pnpm db:seed');
  const supplier = await db.query.supplier.findFirst({
    where: eq(t.supplier.rosterName, rosterName),
  });
  if (!supplier) throw new Error(`No roster row named "${rosterName}"`);

  const runId = await openRun(db, {
    programId: program.id,
    trigger: 'full',
    subjectLabel: `enrich ${rosterName}`,
    supplierCount: 1,
  });
  const upstream = createUpstream({
    db,
    runId,
    credentials: {
      sayariClientId: env.SAYARI_CLIENT_ID,
      sayariClientSecret: env.SAYARI_CLIENT_SECRET,
      nominatimUserAgent: env.NOMINATIM_USER_AGENT,
    },
  });

  if (forceEntityId) {
    const fetched = await upstream.sayari.getEntity({ id: forceEntityId });
    const { upsertEntity } = await import('@/jobs/resolve');
    await upsertEntity(db, fetched.data);
    await settleMatch(db, {
      supplierId: supplier.id,
      status: 'accepted',
      entityId: forceEntityId,
      settledBy: 'human',
      note: 'Settled by hand for the enrichment smoke check.',
    });
    console.log(`\n  Settled ${rosterName} on ${fetched.data.label} (${forceEntityId})`);
  }

  console.log(`\nEnriching "${rosterName}"\n` + '═'.repeat(78));
  const result = await enrichSupplier(
    { db, upstream },
    { supplierId: supplier.id, programId: program.id },
  );

  console.log(`  enrichments written   ${result.enrichmentsWritten.length}`);
  console.log(`  criterion values      ${result.criterionValuesWritten}`);
  console.log(`  family members        ${result.familyMembers}`);
  if (result.skipped) console.log(`  note                  ${result.skipped}`);

  const match = await db.query.match.findFirst({ where: eq(t.match.supplierId, supplier.id) });
  if (match?.entityId) {
    const members = await db
      .select()
      .from(t.familyMember)
      .where(eq(t.familyMember.rootEntityId, match.entityId));
    const memberEntities = await Promise.all(
      members.map(async (m) =>
        db.query.entity.findFirst({ where: eq(t.entity.id, m.memberEntityId) }),
      ),
    );
    const exposure = computeFamilyExposure(
      memberEntities.filter(Boolean).map((e) => ({
        entityId: e!.id,
        label: e!.label,
        country: e!.country,
        factors: unionRiskFactors([{ source: 'getEntity', risk: e!.risk }]).map((u) => u.factor),
        fromDeepTraversal: false,
      })),
      { explored: members.length, reachable: null },
    );
    console.log(`\n  FAMILY EXPOSURE: ${describeFamilyExposure(exposure)}`);
    if (exposure.state === 'exposure_found') {
      for (const m of exposure.members.slice(0, 5)) {
        console.log(`    ${m.level.padEnd(9)} ${m.label}`);
        console.log(`              ${m.factors.slice(0, 3).join(', ')}`);
      }
    }

    const profile = await db.query.entity.findFirst({ where: eq(t.entity.id, match.entityId) });
    const own = parseRiskObject(profile?.risk);
    console.log(`\n  The parent itself carries ${own.length} risk factors:`);
    for (const f of own.slice(0, 8)) console.log(`    ${(f.level ?? '?').padEnd(9)} ${f.name}`);
  }

  const values = await db
    .select()
    .from(t.criterionValue)
    .where(and(eq(t.criterionValue.supplierId, supplier.id), eq(t.criterionValue.isCurrent, true)));
  console.log(`\n  CRITERION VALUES`);
  for (const v of values) {
    const shown =
      v.value == null ? `unknown — ${v.unknownReason?.slice(0, 70)}` : v.value.toFixed(1);
    console.log(`    ${v.criterionKey.padEnd(20)} ${shown}`);
  }

  const usage = await db.select().from(t.usageEvent).where(eq(t.usageEvent.runId, runId));
  console.log('\n' + '═'.repeat(78));
  console.log(
    `  ${usage.length} upstream events · ${usage.filter((u) => !u.cacheHit).length} live\n`,
  );

  await db.update(t.run).set({ state: 'done', finishedAt: new Date() }).where(eq(t.run.id, runId));
  await closeDirectDb();
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exit(1);
});
