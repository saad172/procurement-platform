// Next.js loads `.env` itself; a plain Node entrypoint has to ask.
import 'dotenv/config';
import { and, eq } from 'drizzle-orm';
import { loadEnv } from '@/config/env';
import { closeDirectDb, getDirectDb, type Database } from '@/db/client';
import * as t from '@/db/schema';
import { PROGRAM } from '@/db/seed-data/program';
import { createUpstream } from '@/upstream';
import { openRun } from '@/jobs/runs';
import { enrichSupplier } from '@/jobs/enrich-supplier';
import { unionRiskFactors } from '@/domain/family';
import { effectiveLevel } from '@/domain/scoring/risk-factors';
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
    await upsertEntity(db, fetched.data, fetched.upstreamResponseId, 'getEntity');
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
  if (match?.entityId) await printFamilyRisk(db, match.entityId);

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

/**
 * The family read's own findings, plus the Profile's own risk factors —
 * split out of `main` only to keep it under the lint's line cap. No more
 * standalone Family exposure badge (network spec §5, ticket 03 unit 03b): a
 * member's own risk now scores inside Network exposure (`networkExposure`,
 * `src/domain/scoring/criteria.ts`), printed among `CRITERION VALUES` below;
 * this just lists what the family read found.
 */
async function printFamilyRisk(db: Database, rootEntityId: string): Promise<void> {
  // `family_member` migrated into `graph_path` rows of kind `family`
  // (network spec §6): `graph_path.explored_count` is what
  // `family_member.reachable_count` used to be — the envelope's own figure.
  const members = await db
    .select()
    .from(t.graphPath)
    .where(and(eq(t.graphPath.rootEntityId, rootEntityId), eq(t.graphPath.kind, 'family')));
  const memberEntities = await Promise.all(
    members.map(async (m) => db.query.entity.findFirst({ where: eq(t.entity.id, m.terminalEntityId) })),
  );
  const byId = new Map(members.map((m) => [m.terminalEntityId, m]));
  const reachable = members[0]?.exploredCount ?? null;
  const partial = members.some((m) => m.truncated);
  console.log(
    `\n  FAMILY: ${members.length}${reachable != null ? ` of ${reachable} nodes explored` : partial ? ' explored to the cap' : ' explored'}`,
  );
  const withRisk = memberEntities
    .filter((e): e is NonNullable<typeof e> => e != null)
    .map((e) => ({
      entity: e,
      factors: unionRiskFactors([{ source: 'getEntity', risk: e.risk }]).map((u) => u.factor),
      hopDepth: byId.get(e.id)?.hopDepth ?? 1,
    }))
    .filter(({ factors }) => factors.some((f) => effectiveLevel(f)))
    .slice(0, 5);
  for (const m of withRisk) {
    console.log(`    hop${m.hopDepth}   ${m.entity.label}`);
    console.log(
      `              ${m.factors
        .filter((f) => effectiveLevel(f))
        .slice(0, 3)
        .map((f) => `${effectiveLevel(f)}:${f.name}`)
        .join(', ')}`,
    );
  }

  const profile = await db.query.entity.findFirst({ where: eq(t.entity.id, rootEntityId) });
  const own = parseRiskObject(profile?.risk);
  console.log(`\n  The parent itself carries ${own.length} risk factors:`);
  for (const f of own.slice(0, 8)) console.log(`    ${(f.level ?? '?').padEnd(9)} ${f.name}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exit(1);
});
