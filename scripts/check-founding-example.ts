// Next.js loads `.env` itself; a plain Node entrypoint has to ask.
import 'dotenv/config';
import { loadEnv } from '@/config/env';
import { closeDirectDb, getDirectDb } from '@/db/client';
import * as t from '@/db/schema';
import { createUpstream } from '@/upstream';
import { matchStrengthValue } from '@/upstream/projections/sayari';

/**
 * Re-measures the example this whole application is built around.
 *
 *   pnpm check:founding-example
 *
 * SPEC §1.1 goal 1 says: *row 1 of the roster resolves to the divested
 * Syntegon as Sayari's top hit at `matchStrength: weak`. Accepting a top hit
 * produces a confident, sourced, wrong answer.*
 *
 * That was measured during research against a live graph which has since moved,
 * so this script exists to say what is true **now** rather than to assert what
 * was true then. It is a script and not a test for the same reason
 * `smoke-upstream` is: it spends Sayari credits, and the suite runs keyless.
 *
 * The claim has three parts, and they have aged differently — see the
 * commentary printed at the end.
 */

const ROSTER_ROW = {
  name: 'Bosch',
  address: 'Robert-Bosch-Platz 1 70839 Gerlingen',
  country: 'DEU',
};

async function main(): Promise<void> {
  const env = loadEnv();
  const db = getDirectDb();
  const program = await db.query.program.findFirst();
  if (!program) throw new Error('Seed the database first: pnpm db:seed');
  const [run] = await db
    .insert(t.run)
    .values({ programId: program.id, state: 'running', trigger: 'check', subjectLabel: 'founding example' })
    .returning({ id: t.run.id });

  const upstream = createUpstream({
    db,
    runId: run!.id,
    credentials: {
      sayariClientId: env.SAYARI_CLIENT_ID,
      sayariClientSecret: env.SAYARI_CLIENT_SECRET,
      nominatimUserAgent: env.NOMINATIM_USER_AGENT,
    },
  });

  const queries = [
    { label: 'the roster row as imported (trade name only)', body: { name: [ROSTER_ROW.name] } },
    {
      label: 'the roster row with its address and country — what the pre-pass sends',
      body: { name: [ROSTER_ROW.name], address: [ROSTER_ROW.address], country: [ROSTER_ROW.country] },
    },
    { label: 'the legal name alone', body: { name: ['Robert Bosch GmbH'] } },
  ];

  console.log('\nThe founding example, re-measured\n' + '═'.repeat(78));
  for (const q of queries) {
    const r = await upstream.sayari.resolve({ body: q.body });
    const rows = (r.data.data ?? []).slice(0, 5);
    console.log(`\n${q.label}${r.cacheHit ? '  (cached)' : ''}`);
    rows.forEach((c, i) => {
      console.log(
        `  ${i + 1}. ${(c.label ?? '?').padEnd(46)} ${(matchStrengthValue(c.match_strength) ?? '?').padEnd(8)} score ${c.score?.toFixed(1) ?? '?'}`,
      );
    });
    const syntegon = rows.findIndex((c) => /syntegon/i.test(c.label ?? ''));
    if (syntegon >= 0) console.log(`     → Syntegon appears at rank ${syntegon + 1}`);
  }

  // The second half of the claim: the real Robert Bosch GmbH has no LEI, so it
  // can never clear the auto-accept gate's second witness (SPEC §6.3).
  console.log('\n' + '─'.repeat(78));
  const resolved = await upstream.sayari.resolve({
    body: { name: [ROSTER_ROW.name], address: [ROSTER_ROW.address], country: [ROSTER_ROW.country] },
  });
  const top = resolved.data.data?.[0];
  if (top?.entity_id) {
    const entity = await upstream.sayari.getEntity({ id: top.entity_id });
    const identifiers = JSON.stringify(entity.data.identifiers ?? []);
    const hasLei = /lei/i.test(identifiers);
    console.log(`  Top hit ${entity.data.label} (${top.entity_id})`);
    console.log(`  Carries an LEI: ${hasLei ? 'YES' : 'NO'}`);
    console.log(
      hasLei
        ? '  → it could clear the auto-accept gate, if it also passes all eight Discriminators.'
        : '  → it can NEVER be auto-accepted: the gate requires a GLEIF exact-LEI join as a\n' +
          '    second witness, and that is the safe direction of failure (SPEC §6.3).',
    );
  }

  console.log('\n' + '═'.repeat(78));
  console.log(`  Run ${run!.id}\n`);
  await closeDirectDb();
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exit(1);
});
