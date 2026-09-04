import { describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import * as t from '@/db/schema';
import { runPairsCheck } from '@/jobs/pairs';
import type { EnrichContext } from '@/jobs/enrich';
import { getTestDb, testDatabaseIsUp, testSql } from '../support/test-db';
import { resetDerived } from '../support/reset';
import { seededProgram } from '../support/seeded-program';

/**
 * KNOWN GAP, stated plainly rather than left to a source comment:
 * `foundBody`/`noPathBody` below are hand-authored stand-in envelopes for
 * `traversal.shortestPath`, NOT a replayed real fixture. Sayari's own
 * `traversal.shortestPath` endpoint has a confirmed, ongoing outage,
 * independently verified two ways — this project's own calls all return a
 * real, well-formed `408 Timeout Error` body rather than any success, and a
 * completely separate client (Sayari's own official Python SDK, sharing no
 * code with this project) hit the same endpoint directly and failed the
 * same way on every attempt — so there is currently no way to capture a
 * real body for this pair-sweep to replay. Do not fabricate one, and do not
 * delete or weaken this stub: it is the best available coverage until the
 * endpoint recovers, at which point it should be replaced by a real
 * recording (this project's own fixture-recording tooling, e.g. run a live
 * `pairs` Job and `pnpm fixtures:record`), and this note removed.
 *
 * The `pairs` Job's own runner (network spec §7; ticket 04, unit 04e).
 *
 * `findAndWriteShortestPath` itself is already covered end-to-end by
 * `tests/jobs/shortest-path.test.ts` (unit 04b) — what belongs to THIS unit
 * is the orchestration around it: which Suppliers a Category's sweep
 * considers, how it turns them into unordered pairs, and what it counts. So
 * these tests stub the upstream boundary exactly the way
 * `shortest-path.test.ts` does (no live call, no credential) and let the
 * real `findAndWriteShortestPath` run underneath, rather than mocking that
 * function out — the same house style every other job test in this repo
 * uses.
 *
 * `PWR` is the seed roster's widest Category (13 bidders, `src/db/seed-data/
 * roster.ts`'s own comment) — real, authored rows this suite never writes to,
 * only reads. Every Match and Entity these tests create is derived, so
 * `resetDerived` clears it between tests without touching the roster.
 */

/** Deterministic path body: `a` finds `terminal` through `a → terminal`. */
function foundBody(root: string, terminal: string) {
  return {
    entities: [root, terminal],
    data: [
      {
        source: root,
        target: { id: terminal, label: `${terminal} label` },
        path: [
          {
            field: 'shareholder_of',
            entity: { id: terminal, label: `${terminal} label` },
            relationships: {
              shareholder_of: {
                values: [{ record: `rec-${root}-${terminal}`, from_date: '2020-01-01', to_date: null }],
              },
            },
          },
        ],
      },
    ],
  };
}

function noPathBody(root: string, target: string) {
  return { entities: [root, target], data: [] };
}

/**
 * A stub keyed on the unordered pair, order-independent — `runPairsCheck`'s
 * own pair order follows an un-ordered-by-anything query, so a test that
 * assumed `[a, b]` order over `[b, a]` would be asserting an accident.
 */
function stubShortestPath(responses: Map<string, { found: boolean; terminal?: string }>) {
  const calls: [string, string][] = [];
  const fn = async (params: { entities: [string, string] }) => {
    const [root, target] = params.entities;
    calls.push([root, target]);
    const key = [root, target].sort().join('|');
    const response = responses.get(key);
    const body =
      response?.found && response.terminal
        ? foundBody(root, response.terminal)
        : noPathBody(root, target);
    // `findAndWriteShortestPath` writes `enrichment.upstream_response_id` as a
    // real, non-null FK — only when a Path is found (spec §4.2: "no Path, no
    // further cost", `recordEnrichment` is never called for an empty result).
    // A real call's `call()` chokepoint always writes this row; stubbing the
    // upstream boundary out means this test has to write it in `call()`'s
    // place, the same way `tests/jobs/shortest-path.test.ts` does.
    const upstreamResponseId = body.data.length > 0 ? await insertUpstreamResponse(params) : null;
    return {
      data: body,
      cacheHit: false,
      via: 'sdk' as const,
      fetchedAt: new Date(),
      upstreamResponseId: upstreamResponseId as unknown as string,
      bodyHash: 'pairs-test-fixture',
    };
  };
  return { fn, calls };
}

async function insertUpstreamResponse(params: unknown): Promise<string> {
  const [row] = await testSql()`
    INSERT INTO upstream_response (source, endpoint, params_hash, params, body, body_hash, via)
    VALUES ('sayari', 'traversal.shortestPath', ${'pairs-test-fixture:' + JSON.stringify(params)}, ${JSON.stringify(params)}::jsonb, '{}'::jsonb, 'pairs-test-fixture', 'sdk')
    RETURNING id`;
  return row!.id as string;
}

async function buildCtx(
  db: Awaited<ReturnType<typeof getTestDb>>,
  responses: Map<string, { found: boolean; terminal?: string }>,
  jobId?: string,
) {
  const { fn, calls } = stubShortestPath(responses);
  const ctx: EnrichContext = {
    db,
    upstream: { sayari: { shortestPath: fn } } as never,
    jobId,
  };
  return { ctx, calls };
}

/** The seeded `PWR` Category and every Supplier id bidding it (13 on the roster). */
async function pwrCategory(db: Awaited<ReturnType<typeof getTestDb>>) {
  const program = await seededProgram(db);
  const category = await db.query.category.findFirst({
    where: (row, { and: allOf, eq: equals }) =>
      allOf(equals(row.programId, program.id), equals(row.code, 'PWR')),
  });
  if (!category) throw new Error('seed roster no longer carries a PWR category');
  const bidders = await db
    .select({ supplierId: t.supplierCategory.supplierId })
    .from(t.supplierCategory)
    .where(eq(t.supplierCategory.categoryId, category.id));
  return { categoryId: category.id, supplierIds: bidders.map((b) => b.supplierId) };
}

async function acceptSupplier(
  db: Awaited<ReturnType<typeof getTestDb>>,
  args: { supplierId: string; entityId: string; status?: 'accepted' | 'needs_review' },
): Promise<void> {
  await db
    .insert(t.entity)
    .values({ id: args.entityId, label: args.entityId })
    .onConflictDoNothing();
  await db.insert(t.match).values({
    supplierId: args.supplierId,
    status: args.status ?? 'accepted',
    entityId: (args.status ?? 'accepted') === 'accepted' ? args.entityId : null,
    settledBy: 'human',
  });
}

describe('runPairsCheck: the pairs Job runner', () => {
  it('runs findAndWriteShortestPath once per unordered pair, and skips a pair settled on the same Profile', async () => {
    if (!(await testDatabaseIsUp())) return;
    const db = await getTestDb();
    await resetDerived(db);
    const { categoryId, supplierIds } = await pwrCategory(db);
    expect(supplierIds.length).toBeGreaterThanOrEqual(4);
    const [s1, s2, s3, s4] = supplierIds;

    // s1 and s4 settle on the SAME Profile — the one pair that must be skipped.
    await acceptSupplier(db, { supplierId: s1!, entityId: 'pairs-ent-1' });
    await acceptSupplier(db, { supplierId: s2!, entityId: 'pairs-ent-2' });
    await acceptSupplier(db, { supplierId: s3!, entityId: 'pairs-ent-3' });
    await acceptSupplier(db, { supplierId: s4!, entityId: 'pairs-ent-1' });

    const { ctx, calls } = await buildCtx(db, new Map());
    const result = await runPairsCheck(ctx, { categoryId });

    expect(result.suppliersConsidered).toBe(4);
    // C(4,2) = 6 unordered pairs total, minus the one same-Profile pair.
    expect(result.pairsChecked).toBe(5);
    expect(result.skippedSamePair).toBe(1);
    expect(calls).toHaveLength(5);

    // The same-Profile pair (ent-1, ent-1) was never sent upstream at all.
    const sentPairs = new Set(calls.map(([a, b]) => [a, b].sort().join('|')));
    expect(sentPairs.has('pairs-ent-1|pairs-ent-1')).toBe(false);
    expect(sentPairs.has('pairs-ent-1|pairs-ent-2')).toBe(true);
    expect(sentPairs.has('pairs-ent-2|pairs-ent-3')).toBe(true);
  });

  it('counts a found Path and writes graph_path rows for it, one row per pair with a Path', async () => {
    if (!(await testDatabaseIsUp())) return;
    const db = await getTestDb();
    await resetDerived(db);
    const { categoryId, supplierIds } = await pwrCategory(db);
    const [s1, s2, s3] = supplierIds;

    await acceptSupplier(db, { supplierId: s1!, entityId: 'pairs-found-1' });
    await acceptSupplier(db, { supplierId: s2!, entityId: 'pairs-found-2' });
    await acceptSupplier(db, { supplierId: s3!, entityId: 'pairs-found-3' });

    const responses = new Map<string, { found: boolean; terminal?: string }>([
      [
        ['pairs-found-1', 'pairs-found-2'].sort().join('|'),
        { found: true, terminal: 'pairs-found-shared-parent' },
      ],
    ]);
    const { ctx } = await buildCtx(db, responses);
    const result = await runPairsCheck(ctx, { categoryId });

    expect(result.pairsChecked).toBe(3);
    expect(result.pathsFound).toBe(1);

    const rows = await db
      .select()
      .from(t.graphPath)
      .where(
        inArray(t.graphPath.rootEntityId, ['pairs-found-1', 'pairs-found-2', 'pairs-found-3']),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe('shortest_path');
    expect(rows[0]!.terminalEntityId).toBe('pairs-found-shared-parent');
  });

  it('considers only accepted Suppliers — a Supplier still in Needs Review has no Profile to check', async () => {
    if (!(await testDatabaseIsUp())) return;
    const db = await getTestDb();
    await resetDerived(db);
    const { categoryId, supplierIds } = await pwrCategory(db);
    const [s1, s2] = supplierIds;

    await acceptSupplier(db, { supplierId: s1!, entityId: 'pairs-accepted-only' });
    await acceptSupplier(db, { supplierId: s2!, status: 'needs_review', entityId: 'unused' });

    const { ctx, calls } = await buildCtx(db, new Map());
    const result = await runPairsCheck(ctx, { categoryId });

    expect(result.suppliersConsidered).toBe(1);
    expect(result.pairsChecked).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it('scopes to the one Category — an accepted Supplier bidding a different Category is not swept in', async () => {
    if (!(await testDatabaseIsUp())) return;
    const db = await getTestDb();
    await resetDerived(db);
    const { categoryId, supplierIds } = await pwrCategory(db);

    const program = await seededProgram(db);
    const otherCategory = await db.query.category.findFirst({
      where: (row, { and: allOf, eq: equals, ne: notEqual }) =>
        allOf(equals(row.programId, program.id), notEqual(row.code, 'PWR')),
    });
    expect(otherCategory).toBeTruthy();
    const otherBidders = await db
      .select({ supplierId: t.supplierCategory.supplierId })
      .from(t.supplierCategory)
      .where(eq(t.supplierCategory.categoryId, otherCategory!.id));
    const outsider = otherBidders.map((b) => b.supplierId).find((id) => !supplierIds.includes(id));
    expect(outsider).toBeTruthy();

    await acceptSupplier(db, { supplierId: supplierIds[0]!, entityId: 'pairs-inside' });
    await acceptSupplier(db, { supplierId: outsider!, entityId: 'pairs-outside' });

    const { ctx, calls } = await buildCtx(db, new Map());
    const result = await runPairsCheck(ctx, { categoryId });

    expect(result.suppliersConsidered).toBe(1);
    expect(calls).toHaveLength(0);
  });
});
