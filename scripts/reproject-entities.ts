// Next.js loads `.env` itself; a plain Node entrypoint has to ask.
import 'dotenv/config';
import { asc, eq } from 'drizzle-orm';
import { closeDirectDb, getDirectDb } from '@/db/client';
import * as t from '@/db/schema';
import { upsertEntity } from '@/jobs/resolve';
import { entitySchema, type SayariEntity } from '@/upstream/projections/sayari';

/**
 * Replays every stored `entity.getEntity` body through the corrected
 * `upsertEntity`.
 *
 *     pnpm reproject:entities [--dry-run]
 *
 * `upsertEntity` used to lose data in two directions, and the rows it damaged
 * are still on disk. It wrote `psaCount`, `relationshipCount` and `risk`
 * unconditionally in its conflict branch, so a later partial sighting blanked
 * what a full one had established — **73 entities hold `psaCount` and
 * `relationshipCount` in their own stored payload while the row says null**.
 * And it wrote every other column only on insert, so a first partial sighting
 * stranded one for ever — **11 entities have `sourceCount` stranded**.
 *
 * The payloads were fetched, paid for and cached at the time, so this spends
 * **no Sayari credits at all**: it walks `upstream_response` and re-runs the
 * corrected projection over what is already there.
 *
 * Oldest body first, so where an entity was fetched more than once the newest
 * sighting still wins on the fields it states — the same order the original
 * writes happened in.
 *
 * It is a script rather than a Job because it is a one-off repair of a defect,
 * not work a Run should be able to trigger. Re-runnable, and idempotent: a
 * second pass writes the same values and moves only `fetched_at`.
 */

const dryRun = process.argv.includes('--dry-run');

async function main() {
  const db = getDirectDb();

  const rows = await db
    .select({
      id: t.upstreamResponse.id,
      params: t.upstreamResponse.params,
      body: t.upstreamResponse.body,
    })
    .from(t.upstreamResponse)
    .where(eq(t.upstreamResponse.endpoint, 'entity.getEntity'))
    .orderBy(asc(t.upstreamResponse.fetchedAt));

  /** What the rows looked like before, so the repair can be counted. */
  const before = new Map(
    (
      await db
        .select({
          id: t.entity.id,
          psaCount: t.entity.psaCount,
          relationshipCount: t.entity.relationshipCount,
          sourceCount: t.entity.sourceCount,
          country: t.entity.country,
          lei: t.entity.lei,
        })
        .from(t.entity)
    ).map((row) => [row.id, row]),
  );

  let projected = 0;
  let unparseable = 0;
  const repaired = { psaCount: 0, relationshipCount: 0, sourceCount: 0, country: 0, lei: 0 };

  for (const row of rows) {
    let entity: SayariEntity;
    try {
      entity = entitySchema.parse(row.body) as SayariEntity;
    } catch {
      unparseable += 1;
      continue;
    }
    // A body whose id does not match what was asked for is not this entity's
    // own payload, and passing it as one would misattribute the provenance.
    const asked = (row.params as { id?: unknown } | null)?.id;
    const own = typeof asked === 'string' && asked === entity.id;

    if (!dryRun) await upsertEntity(db, entity, own ? row.id : null);
    projected += 1;

    const was = before.get(entity.id);
    if (!was) continue;
    if (was.psaCount == null && entity.psa_count != null) repaired.psaCount += 1;
    if (was.relationshipCount == null && entity.relationship_count != null)
      repaired.relationshipCount += 1;
    if (was.sourceCount == null && entity.source_count != null) repaired.sourceCount += 1;
    if (was.country == null && entity.attributes?.address?.data?.[0]?.properties?.country != null) {
      repaired.country += 1;
    }
    if (
      was.lei == null &&
      entity.identifiers?.some((i) => /lei/i.test(String((i as { type?: unknown })?.type)))
    ) {
      repaired.lei += 1;
    }
  }

  await closeDirectDb();

  console.log(
    `${dryRun ? 'would re-project' : 're-projected'} ${projected} stored getEntity bodies`,
  );
  if (unparseable > 0) console.log(`  ${unparseable} did not parse and were skipped`);
  console.log(`\ncolumns that were null and the payload can fill:`);
  for (const [column, n] of Object.entries(repaired)) {
    console.log(`  ${column.padEnd(20)} ${n}`);
  }
  if (dryRun) console.log(`\nnothing was written — drop --dry-run to apply.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
