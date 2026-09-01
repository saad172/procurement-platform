/**
 * Measures the name-based forwarder prefilter against Sayari's own
 * `logisticsEntity` flag, over the cached BAT trade page.
 */
import { config } from 'dotenv';
config({ path: '.env', quiet: true });
import postgres from 'postgres';
import { prefilterScore } from '../src/jobs/discover';

async function main() {
  const sql = postgres(process.env.DATABASE_URL!);
  const [row] = await sql`
    select body from upstream_response
    where endpoint ilike '%trade%' order by fetched_at desc limit 1`;
  await sql.end();

  if (!row) throw new Error('No cached trade response — run `pnpm smoke:discover BAT` first.');

  const rows = ((row.body as { data?: unknown[] }).data ?? []) as {
    label: string;
    logisticsEntity?: boolean;
    metadata: { shipments: number };
  }[];
  const byShipments = [...rows].sort((a, b) => b.metadata.shipments - a.metadata.shipments);

  let tp = 0,
    fp = 0,
    fn = 0,
    tn = 0;
  for (const r of rows) {
    const flagged = prefilterScore(r.label) < 0;
    const truth = r.logisticsEntity === true;
    if (flagged && truth) tp++;
    else if (flagged && !truth) fp++;
    else if (!flagged && truth) fn++;
    else tn++;
  }
  console.log(`rows ${rows.length}`);
  console.log(`logisticsEntity true: ${tp + fn}`);
  console.log(
    `name heuristic caught ${tp}, missed ${fn}, false-flagged ${fp}, correctly ignored ${tn}`,
  );
  console.log(`\ntop 25 by shipments — logisticsEntity:`);
  const top = byShipments.slice(0, 25);
  console.log(`  ${top.filter((r) => r.logisticsEntity).length} of 25 are logistics entities`);
  for (const r of top.filter((r) => r.logisticsEntity)) {
    console.log(
      `    ${r.metadata.shipments.toString().padStart(6)}  ${r.label}  ${prefilterScore(r.label) < 0 ? '(name-caught)' : '(NAME MISSED)'}`,
    );
  }
  console.log(`\n  false-flagged by name:`);
  for (const r of rows.filter((r) => prefilterScore(r.label) < 0 && !r.logisticsEntity)) {
    console.log(`    ${r.metadata.shipments.toString().padStart(6)}  ${r.label}`);
  }
}
void main();
