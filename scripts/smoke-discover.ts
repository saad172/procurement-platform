// Next.js loads `.env` itself; a plain Node entrypoint has to ask.
import 'dotenv/config';
import { eq } from 'drizzle-orm';
import { loadEnv } from '@/config/env';
import { closeDirectDb, getDirectDb } from '@/db/client';
import * as t from '@/db/schema';
import { createUpstream } from '@/upstream';
import { enqueueJob, openRun, runSpendUsd } from '@/jobs/runs';
import { discoverLeads } from '@/jobs/discover';

/**
 * Discover, against real Sayari trade data.
 *
 *   pnpm smoke:discover [CATEGORY_CODE]
 *
 * **It spends Sayari credits and Anthropic tokens.** It is the check that shows
 * the forwarder problem rather than describing it.
 */
async function main(): Promise<void> {
  const env = loadEnv();
  const db = getDirectDb();
  const code = process.argv[2] ?? 'BAT';

  const program = await db.query.program.findFirst();
  if (!program) throw new Error('Seed the database first: pnpm db:seed');
  const category = await db.query.category.findFirst({ where: eq(t.category.code, code) });
  if (!category) throw new Error(`No category "${code}"`);

  const runId = await openRun(db, {
    programId: program.id,
    trigger: 'discover',
    subjectLabel: `discover ${code}`,
    supplierCount: 1,
  });
  const jobId = await enqueueJob(db, {
    runId,
    kind: 'discover',
    subjectType: 'category',
    subjectId: category.id,
  });

  const upstream = createUpstream({
    db,
    runId,
    jobId,
    credentials: {
      sayariClientId: env.SAYARI_CLIENT_ID,
      sayariClientSecret: env.SAYARI_CLIENT_SECRET,
      nominatimUserAgent: env.NOMINATIM_USER_AGENT,
    },
  });
  const toolCtx = {
    db,
    upstream,
    meter: { addModelTokens: () => {} },
    runId,
    jobId,
    surface: 'job' as const,
  };

  console.log(`\nDiscover — ${code} ${category.name}\n` + '═'.repeat(78));

  const result = await discoverLeads(
    {
      db,
      upstream,
      toolCtx,
      modelCtx: { db, runId, jobId, credentials: { apiKey: env.ANTHROPIC_API_KEY } },
      jobId,
    },
    { programId: program.id, categoryId: category.id },
  );

  console.log(`  proposed ${result.proposed} · classified ${result.classified} · ${result.alreadyOnRoster} already on the roster\n`);

  const leads = await db
    .select({ lead: t.lead, entity: t.entity })
    .from(t.lead)
    .innerJoin(t.entity, eq(t.entity.id, t.lead.entityId))
    .where(eq(t.lead.categoryId, category.id));

  const counts = new Map<string, number>();
  for (const { lead } of leads) {
    counts.set(lead.classification ?? 'none', (counts.get(lead.classification ?? 'none') ?? 0) + 1);
  }

  for (const { lead, entity } of leads.slice(0, 14)) {
    console.log(
      `  ${(lead.classification ?? '—').padEnd(24)} ${entity.label.slice(0, 42).padEnd(44)} ` +
        `${String(lead.shipmentCount ?? '—').padStart(7)} shipments  ${lead.latestShipmentDate ?? 'no date'}`,
    );
  }

  console.log('\n' + '─'.repeat(78));
  console.log('  ' + [...counts.entries()].map(([k, n]) => `${k}: ${n}`).join(' · '));
  const noDate = leads.filter((l) => !l.lead.latestShipmentDate).length;
  console.log(`  ${noDate} of ${leads.length} carry no latest-shipment date — which is why it is a column, not a filter.`);
  console.log(`  cost $${(await runSpendUsd(db, runId)).toFixed(4)}`);
  console.log('═'.repeat(78) + '\n');

  await db.update(t.job).set({ state: 'done' }).where(eq(t.job.id, jobId));
  await db.update(t.run).set({ state: 'done', finishedAt: new Date() }).where(eq(t.run.id, runId));
  await closeDirectDb();
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exit(1);
});
