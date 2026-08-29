// Next.js loads `.env` itself; a plain Node entrypoint has to ask.
import 'dotenv/config';
import { desc, eq } from 'drizzle-orm';
import { loadEnv } from '@/config/env';
import { closeDirectDb, getDirectDb } from '@/db/client';
import * as t from '@/db/schema';
import { createUpstream } from '@/upstream';
import { enqueueJob, openRun, runSpendUsd } from '@/jobs/runs';
import { assessSupplier } from '@/jobs/assess';
import { JOB_CAPS } from '@/config/constants';

/**
 * The full assess loop: proposer → code checks → evaluator → publish.
 *
 *   pnpm smoke:assess [rosterName]
 *
 * **It spends Anthropic tokens and possibly Sayari credits.** It is the first
 * check that exercises every layer at once — registry, model chokepoint, the
 * eight code checks, and the transactional publish — against real data.
 */

async function main(): Promise<void> {
  const env = loadEnv();
  const db = getDirectDb();
  const rosterName = process.argv[2] ?? 'Yazaki';

  const program = await db.query.program.findFirst();
  if (!program) throw new Error('Seed the database first: pnpm db:seed');
  const supplier = await db.query.supplier.findFirst({ where: eq(t.supplier.rosterName, rosterName) });
  if (!supplier) throw new Error(`No roster row named "${rosterName}"`);

  const match = await db.query.match.findFirst({ where: eq(t.match.supplierId, supplier.id) });
  if (match?.status !== 'accepted') {
    throw new Error(`${rosterName} has no accepted match — run pnpm smoke:enrich ${rosterName} <entityId> first.`);
  }

  const runId = await openRun(db, {
    programId: program.id,
    trigger: 'reassess',
    subjectLabel: `assess ${rosterName}`,
    supplierCount: 1,
  });
  const jobId = await enqueueJob(db, {
    runId,
    kind: 'assess',
    subjectType: 'supplier',
    subjectId: supplier.id,
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

  console.log(`\nAssessing "${rosterName}"\n` + '═'.repeat(78));
  console.log(`  caps: ${JOB_CAPS.assess.toolCalls} tool calls, ${JOB_CAPS.assess.tokens.toLocaleString('en-US')} tokens\n`);

  const result = await assessSupplier(
    {
      db,
      toolCtx: {
        db,
        upstream,
        meter: { addModelTokens: () => {} },
        runId,
        jobId,
        surface: 'job',
      },
      modelCtx: { db, runId, jobId, credentials: { apiKey: env.ANTHROPIC_API_KEY } },
      jobId,
    },
    { supplierId: supplier.id, programId: program.id },
  );

  console.log(`  version ${result.n} · ${result.evaluatorOutcome} · ${result.roundsUsed} round(s)\n`);

  const sentences = await db
    .select()
    .from(t.sentence)
    .where(eq(t.sentence.assessmentVersionId, result.versionId))
    .orderBy(t.sentence.section, t.sentence.ordinal);

  let section = '';
  for (const s of sentences) {
    if (s.section !== section) {
      section = s.section;
      console.log(`  ── ${section.toUpperCase()} ──`);
    }
    const citations = await db.select().from(t.citation).where(eq(t.citation.sentenceId, s.id));
    console.log(`    ${s.text}`);
    console.log(`      ❡ ${citations.length} citation(s)`);
  }

  const rounds = await db
    .select()
    .from(t.round)
    .where(eq(t.round.assessmentVersionId, result.versionId))
    .orderBy(desc(t.round.n));
  const codeRejections = rounds.filter((r) => r.source === 'code' && r.role === 'evaluator');

  console.log('\n' + '─'.repeat(78));
  console.log(`  sentences        ${sentences.length}`);
  console.log(`  rounds           ${rounds.length} · ${codeRejections.length} spent on code rejections`);
  for (const rejection of codeRejections) {
    console.log(`    ✗ ${rejection.objection?.split('\n')[0]}`);
  }
  console.log(`  cost             $${(await runSpendUsd(db, runId)).toFixed(4)}`);
  console.log('═'.repeat(78) + '\n');

  await db.update(t.job).set({ state: 'done' }).where(eq(t.job.id, jobId));
  await db.update(t.run).set({ state: 'done', finishedAt: new Date() }).where(eq(t.run.id, runId));
  await closeDirectDb();
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exit(1);
});
