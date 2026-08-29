// Next.js loads `.env` itself; a plain Node entrypoint has to ask.
import 'dotenv/config';
import { loadEnv } from '@/config/env';
import { closeDirectDb, getDirectDb } from '@/db/client';
import * as t from '@/db/schema';
import { createUpstream } from '@/upstream';
import { matchStrengthValue } from '@/upstream/projections/sayari';
import { eq } from 'drizzle-orm';

/**
 * A live smoke check of the upstream layer: one call to each of the five
 * sources, against the real APIs.
 *
 * **It spends Sayari credits**, so it is a script rather than a test — the
 * suite runs keyless off cached bodies by design (SPEC §19.1), and adding a
 * live call to it would make CI depend on a credential and a network.
 *
 *   pnpm smoke:upstream
 *
 * Run it after changing anything in `src/upstream/`: the keyless suite proves
 * the bookkeeping, and this proves the endpoints still exist and still return
 * what the projections expect.
 */

const YAZAKI = 'LAtrDml3ulKGjNIIFGSNAg'; // measured during research

async function main(): Promise<void> {
  const env = loadEnv();
  const db = getDirectDb();

  // Every amount spent belongs to exactly one Run, so the smoke check opens one.
  const program = await db.query.program.findFirst();
  if (!program) throw new Error('Seed the database first: pnpm db:seed');
  const [run] = await db
    .insert(t.run)
    .values({ programId: program.id, state: 'running', trigger: 'smoke', subjectLabel: 'upstream smoke check' })
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

  const results: { name: string; ok: boolean; detail: string }[] = [];
  const check = async (name: string, fn: () => Promise<string>) => {
    const started = Date.now();
    try {
      const detail = await fn();
      results.push({ name, ok: true, detail: `${detail}  (${Date.now() - started}ms)` });
    } catch (error) {
      results.push({
        name,
        ok: false,
        detail: error instanceof Error ? error.message.split('\n')[0]! : String(error),
      });
    }
  };

  await check('sayari.getEntity', async () => {
    const r = await upstream.sayari.getEntity({ id: YAZAKI });
    const risk = Object.keys(r.data.risk ?? {}).length;
    return `${r.data.label} · risk factors ${risk} · psaCount ${r.data.psa_count ?? 0} · via ${r.via}${r.cacheHit ? ' (cached)' : ''}`;
  });

  await check('sayari.ownership (Corporate family)', async () => {
    const r = await upstream.sayari.ownership({ id: YAZAKI, limit: 50 });
    const members = new Set<string>();
    for (const path of r.data.data ?? []) {
      const last = path.path?.[path.path.length - 1]?.entity;
      if (last && typeof last === 'object' && 'id' in last && last.id !== YAZAKI) {
        members.add(String(last.id));
      }
    }
    return `${members.size} family members reachable in one call${r.cacheHit ? ' (cached)' : ''}`;
  });

  await check('sayari.resolve (the Bosch decoy)', async () => {
    const r = await upstream.sayari.resolve({
      body: {
        name: ['Robert Bosch GmbH'],
        address: ['Robert-Bosch-Platz 1 70839 Gerlingen'],
        country: ['DEU'],
      },
    });
    const top = r.data.data?.[0];
    return `top hit: ${top?.label} · strength ${matchStrengthValue(top?.match_strength) ?? '?'}`;
  });

  await check('gleif.joinLei', async () => {
    // Siemens AG — a large German company that certainly has an LEI, used only
    // to prove the exact join works. The roster's own LEIs come from Sayari.
    const r = await upstream.gleif.joinLei({ lei: 'W38RGI023J3WT1HWRP32' });
    return `${r.data.data?.attributes?.entity?.legalName?.name ?? 'no name'} · ${r.data.data?.attributes?.entity?.legalAddress?.city ?? '?'}`;
  });

  await check('worldbank.indicator (LPI, Germany)', async () => {
    const r = await upstream.worldbank.indicator({ country: 'DEU', indicator: 'LP.LPI.OVRL.XQ' });
    const rows = Array.isArray(r.data) && Array.isArray(r.data[1]) ? r.data[1] : [];
    const row = rows[0];
    return row ? `${row.date}: ${row.value}` : 'no rows (mrnev returned nothing)';
  });

  await check('usitc.tariff (HAR 8544.30)', async () => {
    const r = await upstream.usitc.tariff({ hsCode: '8544.30' });
    const rows = Array.isArray(r.data) ? r.data : [];
    const hit = rows.find((x) => x.htsno?.startsWith('8544.30'));
    return hit ? `${hit.htsno}: general ${hit.general}` : `${rows.length} rows, no 8544.30 line`;
  });

  await check('nominatim.geocode (Plant P1)', async () => {
    const r = await upstream.nominatim.geocode({ q: 'Spring Hill, Tennessee, USA' });
    const hit = r.data[0];
    return hit ? `${hit.lat},${hit.lon} · ${hit.addresstype ?? hit.type}` : 'no result';
  });

  console.log('\nUpstream smoke check\n' + '─'.repeat(72));
  for (const r of results) {
    console.log(`${r.ok ? '  ok  ' : ' FAIL '} ${r.name.padEnd(34)} ${r.detail}`);
  }

  const usage = await db.select().from(t.usageEvent).where(eq(t.usageEvent.runId, run!.id));
  const live = usage.filter((u) => !u.cacheHit).length;
  console.log('─'.repeat(72));
  console.log(`  ${usage.length} usage events · ${live} live outbound attempts · ${usage.length - live} served from cache`);
  console.log(`  Run ${run!.id}\n`);

  await db.update(t.run).set({ state: 'done', finishedAt: new Date() }).where(eq(t.run.id, run!.id));
  await closeDirectDb();
  process.exit(results.every((r) => r.ok) ? 0 : 1);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exit(1);
});
