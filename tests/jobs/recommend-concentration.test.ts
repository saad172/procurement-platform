import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResolvedEvidence } from '@/domain/validation/submit-checks';
import { findConcentrations, type RecommendDraft } from '@/jobs/recommend';
import { findAndWriteShortestPath } from '@/jobs/shortest-path';

/**
 * The recommend Job's wiring to `findAndWriteShortestPath` (network spec
 * §4.2, §7; ticket 04c) — the award against each `second_source` Pick, at
 * submission.
 *
 * `findAndWriteShortestPath` is mocked at the module boundary rather than
 * called live: it is 04b's own function with its own test coverage
 * (`tests/jobs/shortest-path.test.ts`), and what this file needs to prove is
 * the CALL, not the read — which pairs it is asked about, in what order,
 * how many times, and what a `Path`/`no Path` answer turns into.
 */
vi.mock('@/jobs/shortest-path', () => ({ findAndWriteShortestPath: vi.fn() }));

const mockFind = vi.mocked(findAndWriteShortestPath);

/** A `ResolvedEvidence` carrying only what `findConcentrations` reads: names and entity ids. */
function evidenceOf(entries: Record<string, string | null>): ResolvedEvidence {
  const suppliers: ResolvedEvidence['suppliers'] = new Map();
  for (const [supplierId, entityId] of Object.entries(entries)) {
    suppliers.set(supplierId, {
      name: supplierId,
      matchAccepted: true,
      entityId,
      categoryIds: ['cat-1'],
      categoriesWithScore: ['cat-1'],
      disqualifying: false,
      publishedWithObjections: false,
      onShortlist: true,
    });
  }
  return {
    rowsByCitation: new Map(),
    frozenInputs: {},
    suppliers,
    unknownCriteria: [],
    mandatoryCaveats: [],
  };
}

/**
 * A `RecommendRoundContext`-shaped fixture with only the fields
 * `findConcentrations` actually reads populated for real — `db` and
 * `upstream` are never touched because `findAndWriteShortestPath` is mocked
 * out, so they stand in as opaque placeholders, same as
 * `tests/jobs/shortest-path.test.ts`'s own `as never` upstream stub.
 */
function ctxWith(jobId?: string) {
  return {
    db: {} as never,
    deps: {
      db: {} as never,
      toolCtx: { upstream: {} as never } as never,
      modelCtx: {} as never,
      jobId,
    },
    args: { programId: 'program-1', categoryId: 'cat-1' },
    program: undefined,
    category: {} as never,
    brief: '',
    leadTools: [],
    frozenInputs: {} as never,
    supplierIds: [],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

beforeEach(() => {
  mockFind.mockReset();
});

describe('findConcentrations — the recommend Job’s call to shortestPath (§4.2, §7)', () => {
  it('calls the award against each second-source pick, and skips every other role', async () => {
    mockFind.mockResolvedValue({ terminalEntityId: 'entity-parent' });

    const draft: RecommendDraft = {
      picks: [
        { supplierId: 'award-co', role: 'award', rank: 1 },
        { supplierId: 'second-co', role: 'second_source', rank: 2 },
        { supplierId: 'develop-co', role: 'develop', rank: 3 },
      ],
      sentences: [],
    };
    const evidence = evidenceOf({
      'award-co': 'entity-award',
      'second-co': 'entity-second',
      'develop-co': 'entity-develop',
    });

    const pairs = await findConcentrations(ctxWith('job-1'), draft, evidence);

    expect(mockFind).toHaveBeenCalledTimes(1);
    expect(mockFind).toHaveBeenCalledWith(expect.anything(), {
      rootEntityId: 'entity-award',
      targetEntityId: 'entity-second',
      discoveredByJob: 'job-1',
    });
    expect(pairs).toEqual([
      { awardSupplierId: 'award-co', secondSourceSupplierId: 'second-co', terminalEntityId: 'entity-parent' },
    ]);
  });

  it('makes at most two calls in practice — one award against up to two second sources', async () => {
    // `checkPickLegality` caps a Recommendation at three picks with exactly
    // one award, so three picks total is the largest legal draft this
    // function will ever see.
    mockFind.mockResolvedValue({ terminalEntityId: 'entity-parent' });

    const draft: RecommendDraft = {
      picks: [
        { supplierId: 'award-co', role: 'award', rank: 1 },
        { supplierId: 'second-a', role: 'second_source', rank: 2 },
        { supplierId: 'second-b', role: 'second_source', rank: 3 },
      ],
      sentences: [],
    };
    const evidence = evidenceOf({
      'award-co': 'entity-award',
      'second-a': 'entity-second-a',
      'second-b': 'entity-second-b',
    });

    const pairs = await findConcentrations(ctxWith(), draft, evidence);

    expect(mockFind).toHaveBeenCalledTimes(2);
    expect(pairs).toHaveLength(2);
  });

  it('drops a pick findAndWriteShortestPath found no Path for', async () => {
    mockFind.mockResolvedValue(undefined);

    const draft: RecommendDraft = {
      picks: [
        { supplierId: 'award-co', role: 'award', rank: 1 },
        { supplierId: 'second-co', role: 'second_source', rank: 2 },
      ],
      sentences: [],
    };
    const evidence = evidenceOf({ 'award-co': 'entity-award', 'second-co': 'entity-second' });

    const pairs = await findConcentrations(ctxWith(), draft, evidence);

    expect(mockFind).toHaveBeenCalledTimes(1);
    expect(pairs).toEqual([]);
  });

  it('calls nothing with no award pick', async () => {
    const draft: RecommendDraft = {
      picks: [{ supplierId: 'second-co', role: 'second_source', rank: 1 }],
      sentences: [],
    };
    const evidence = evidenceOf({ 'second-co': 'entity-second' });

    const pairs = await findConcentrations(ctxWith(), draft, evidence);

    expect(mockFind).not.toHaveBeenCalled();
    expect(pairs).toEqual([]);
  });

  it('calls nothing for a pick with no accepted Profile — no entity id to call with', async () => {
    const draft: RecommendDraft = {
      picks: [
        { supplierId: 'award-co', role: 'award', rank: 1 },
        { supplierId: 'second-co', role: 'second_source', rank: 2 },
      ],
      sentences: [],
    };
    const evidence = evidenceOf({ 'award-co': 'entity-award', 'second-co': null });

    const pairs = await findConcentrations(ctxWith(), draft, evidence);

    expect(mockFind).not.toHaveBeenCalled();
    expect(pairs).toEqual([]);
  });

  it('passes discoveredByJob: null with no jobId, rather than undefined', async () => {
    mockFind.mockResolvedValue({ terminalEntityId: 'entity-parent' });

    const draft: RecommendDraft = {
      picks: [
        { supplierId: 'award-co', role: 'award', rank: 1 },
        { supplierId: 'second-co', role: 'second_source', rank: 2 },
      ],
      sentences: [],
    };
    const evidence = evidenceOf({ 'award-co': 'entity-award', 'second-co': 'entity-second' });

    await findConcentrations(ctxWith(undefined), draft, evidence);

    expect(mockFind).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ discoveredByJob: null }),
    );
  });
});
