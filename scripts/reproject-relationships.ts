// Next.js loads `.env` itself; a plain Node entrypoint has to ask.
import 'dotenv/config';
import { eq, sql } from 'drizzle-orm';
import { closeDirectDb, getDirectDb } from '@/db/client';
import * as t from '@/db/schema';
import { parseRelationships } from '@/domain/parse-relationships';
import { storeRelationships } from '@/jobs/enrich';

/**
 * Re-projects the relationship graph out of the responses already stored.
 *
 *     pnpm reproject:relationships [--dry-run]
 *
 * `entity_relationship` was empty because the projection read `edge.type` where
 * the payload carries `types`. The edges were never missing from the data — the
 * bodies that contain them were fetched, paid for and cached at the time. So
 * this spends **no Sayari credits at all**: it walks `upstream_response` and
 * runs the corrected parser over what is already there.
 *
 * It is a script rather than a Job because it is a one-off repair of a defect,
 * not work a Run should be able to trigger. Nothing here is a spend, so nothing
 * here needs a budget.
 *
 * Re-runnable: every write is `onConflictDoNothing` against the edge's unique
 * key, and `first_seen_at` is left for the database to set once.
 */

/** Pulls the entity object out of whatever wrapper an endpoint uses. */
function entitiesIn(body: unknown): Record<string, unknown>[] {
  const found: Record<string, unknown>[] = [];
  const seen = new Set<unknown>();

  const walk = (node: unknown, depth: number): void => {
    if (!node || typeof node !== 'object' || depth > 6 || seen.has(node)) return;
    seen.add(node);
    const object = node as Record<string, unknown>;

    // An entity is anything carrying an id and its own relationships block.
    if (typeof object['id'] === 'string' && object['relationships']) found.push(object);

    for (const value of Object.values(object)) {
      if (Array.isArray(value)) value.forEach((item) => walk(item, depth + 1));
      else if (value && typeof value === 'object') walk(value, depth + 1);
    }
  };

  walk(body, 0);
  return found;
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const db = getDirectDb();

  const [{ before }] = (await db
    .select({ before: sql<number>`count(*)::int` })
    .from(t.entityRelationship)) as [{ before: number }];

  const bodies = await db
    .select({ id: t.upstreamResponse.id, body: t.upstreamResponse.body })
    .from(t.upstreamResponse)
    .where(eq(t.upstreamResponse.source, 'sayari'));

  console.log(`${bodies.length} stored Sayari responses · ${before} edges before`);

  let parsed = 0;
  let written = 0;
  let skippedNoEntityRow = 0;
  const unclassified = new Set<string>();
  /**
   * An edge whose `to` company has no row yet cannot be written — the table
   * references `entity` on both ends. The subject is upserted by whatever
   * fetched it; the target is upserted here. A target that arrived as a bare
   * id has nothing to upsert, and is counted rather than invented.
   */
  const known = new Set(
    (await db.select({ id: t.entity.id }).from(t.entity)).map((row) => row.id),
  );

  for (const row of bodies) {
    for (const entity of entitiesIn(row.body)) {
      const subjectId = entity['id'] as string;
      if (!known.has(subjectId)) {
        skippedNoEntityRow += 1;
        continue;
      }
      const result = parseRelationships(entity, subjectId);
      result.unclassified.forEach((type) => unclassified.add(type));
      parsed += result.edges.length;
      if (dryRun) continue;
      written += await storeRelationships(db, result.edges);
    }
  }

  const [{ after }] = (await db
    .select({ after: sql<number>`count(*)::int` })
    .from(t.entityRelationship)) as [{ after: number }];

  console.log(
    `${parsed} edges parsed · ${written} written · ${after - before} new rows · ` +
      `${skippedNoEntityRow} subject(s) skipped for having no entity row`,
  );
  if (unclassified.size > 0) {
    console.log(`unclassified types (stored, excluded from ownership): ${[...unclassified].join(', ')}`);
  }
  if (dryRun) console.log('dry run — nothing written');

  await closeDirectDb();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
