// Next.js loads `.env` itself; a plain Node entrypoint has to ask.
import 'dotenv/config';
import { eq } from 'drizzle-orm';
import { loadEnv } from '@/config/env';
import { closeDirectDb, getDirectDb } from '@/db/client';
import * as t from '@/db/schema';
import { PROGRAM } from '@/db/seed-data/program';
import { createUpstream } from '@/upstream';
import { openRun } from '@/jobs/runs';
import { prepassCandidateIds, resolveSupplier } from '@/jobs/resolve';
import { runDiscriminators } from '@/domain/match/discriminators';
import { toCandidateFacts, toGleifWitness } from '@/jobs/resolve';

/**
 * The deterministic half of the resolve loop, against the real Sayari graph.
 *
 *   pnpm smoke:resolve [rosterName]
 *
 * **It spends Sayari credits.** It runs the batch pre-pass, the eight
 * Discriminators and the auto-accept gate — but no agent Round, because the
 * point is to see what CODE decides before any model is involved. That number —
 * how many rows plain code can settle, at zero tokens — is one of the results
 * the write-up reports.
 */

async function main(): Promise<void> {
  const env = loadEnv();
  const db = getDirectDb();
  const rosterName = process.argv[2] ?? 'Bosch';

  const program = await db.query.program.findFirst({ where: eq(t.program.name, PROGRAM.name) });
  if (!program) throw new Error('Seed the database first: pnpm db:seed');
  const supplier = await db.query.supplier.findFirst({
    where: eq(t.supplier.rosterName, rosterName),
  });
  if (!supplier) throw new Error(`No roster row named "${rosterName}"`);

  const runId = await openRun(db, {
    programId: program.id,
    trigger: 'full',
    subjectLabel: `resolve ${rosterName}`,
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

  console.log(`\nResolving "${rosterName}"\n` + '═'.repeat(78));
  console.log(
    `  roster: ${supplier.rosterName} · ${supplier.rosterAddress} · ${supplier.rosterCountry}`,
  );

  // Rung R1: the batch pre-pass. One call carries every row; here it carries one.
  const prepass = await upstream.sayari.resolve({
    body: {
      name: [supplier.rosterName!],
      address: [supplier.rosterAddress!],
      country: [supplier.rosterCountry!],
    },
  });
  const candidateIds = prepassCandidateIds(prepass.data).slice(0, 5);
  console.log(
    `\n  Pre-pass returned ${candidateIds.length} candidates${prepass.cacheHit ? ' (cached)' : ''}:`,
  );

  const roster = {
    name: supplier.rosterName!,
    address: supplier.rosterAddress,
    country: supplier.rosterCountry,
    hasCategory: true,
  };

  // Show every discriminator for every candidate — this is the Needs Review view.
  for (const { entityId } of candidateIds) {
    const fetched = await upstream.sayari.getEntity({ id: entityId });
    const facts = toCandidateFacts(fetched.data);
    if (facts.lei) {
      try {
        const g = await upstream.gleif.joinLei({ lei: facts.lei });
        facts.gleif = toGleifWitness(g.data.data?.attributes?.entity);
      } catch {
        /* absence is not evidence */
      }
    }
    const verdicts = runDiscriminators(roster, facts);
    const summary = verdicts
      .map(
        (v) => `${v.verdict === 'pass' ? '✓' : v.verdict === 'fail' ? '✗' : '·'}${v.discriminator}`,
      )
      .join(' ');
    const cities = facts.addresses.map((a) => a.city).filter(Boolean);
    console.log(
      `\n  ${facts.label}  (${facts.country ?? '?'}, ${facts.addresses.length} addresses: ${cities.slice(0, 4).join(', ')}${cities.length > 4 ? '…' : ''})  LEI ${facts.lei ?? 'none'}`,
    );
    console.log(`    ${summary}`);
    for (const v of verdicts.filter((x) => x.verdict === 'fail')) {
      console.log(`    ✗ ${v.discriminator}: ${v.reasoning}`);
    }
  }

  const outcome = await resolveSupplier(
    { db, upstream },
    {
      supplierId: supplier.id,
      roster,
      prepassCandidates: candidateIds,
    },
  );

  console.log('\n' + '─'.repeat(78));
  console.log(
    `  OUTCOME: ${outcome.status}  (settled by ${outcome.settledBy}, ${outcome.rounds} rounds, 0 tokens)`,
  );
  console.log(`  ${outcome.reason}`);
  console.log('═'.repeat(78));

  const usage = await db.select().from(t.usageEvent).where(eq(t.usageEvent.runId, runId));
  const live = usage.filter((u) => !u.cacheHit).length;
  console.log(`  ${usage.length} upstream events · ${live} live · ${usage.length - live} cached\n`);

  await db.update(t.run).set({ state: 'done', finishedAt: new Date() }).where(eq(t.run.id, runId));
  await closeDirectDb();
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exit(1);
});
