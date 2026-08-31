// Next.js loads `.env` itself; a plain Node entrypoint has to ask.
import 'dotenv/config';
import { and, eq, sql } from 'drizzle-orm';
import { closeDirectDb, getDirectDb } from '@/db/client';
import * as t from '@/db/schema';
import { parseRelationships } from '@/domain/parse-relationships';
import { storeRelationships } from '@/jobs/enrich';
import { asc } from 'drizzle-orm';

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
 * It does two repairs, both from the same cache:
 *
 * 1. **The relationship graph**, which was empty.
 * 2. **`entity.upstream_response_id`**, which is new — every company that was
 *    fetched on its own gets a link to the body it was projected from, so the
 *    Profile page can show a reader what the figures were computed against.
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

  // ── 2. Provenance: link each entity to its own fetched body ──────────────
  const linked = dryRun ? 0 : await backfillProvenance(db);

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
  console.log(`${linked} entit(ies) linked to the body they were projected from`);
  if (dryRun) console.log('dry run — nothing written');

  await closeDirectDb();
}

/**
 * Sets `entity.upstream_response_id` for every company fetched on its own.
 *
 * **Only `entity.getEntity` bodies qualify.** A search or traversal response
 * contains many companies and is nobody's own payload; pointing an entity at
 * one would answer *what was this projected from* with a body about somebody
 * else. Those rows stay null, and the page says so in words.
 *
 * Oldest first, so the newest fetch wins the row — the same latest-wins rule
 * the cache read itself uses.
 */
async function backfillProvenance(db: ReturnType<typeof getDirectDb>): Promise<number> {
  const bodies = await db
    .select({ id: t.upstreamResponse.id, body: t.upstreamResponse.body })
    .from(t.upstreamResponse)
    .where(
      and(
        eq(t.upstreamResponse.source, 'sayari'),
        eq(t.upstreamResponse.endpoint, 'entity.getEntity'),
      ),
    )
    .orderBy(asc(t.upstreamResponse.fetchedAt));

  let linked = 0;
  for (const row of bodies) {
    const body = row.body as { data?: { id?: unknown }; id?: unknown };
    const entityId = typeof body?.data?.id === 'string' ? body.data.id
      : typeof body?.id === 'string' ? body.id
      : null;
    if (!entityId) continue;

    const updated = await db
      .update(t.entity)
      .set({ upstreamResponseId: row.id })
      .where(eq(t.entity.id, entityId))
      .returning({ id: t.entity.id });
    linked += updated.length;
  }
  return linked;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
