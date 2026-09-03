import { z } from 'zod/v4';

/**
 * The widened, optional `TraversalWalkParams` a person can ask for on a Deep
 * Traversal (network spec §4.4, ticket 02): `relationships`, `riskCategories`,
 * `countries`, `minShares`, `sanctioned`, `pep`, `excludeClosedEntities`.
 *
 * **Lives in `src/domain/`, not beside `TraversalWalkParams` itself
 * (`src/upstream/endpoints.ts`), on purpose.** `enqueue_deep_traversal`
 * (`src/tools/catalog/enqueues.ts`) needs this exact shape to validate its own
 * input, and no file under `src/tools/**` may import a module that pulls in
 * `@sayari/sdk` (SPEC §2.4 — enforced by `eslint.config.mjs`'s
 * `no-restricted-imports` on the literal specifier, but the deeper reason is
 * transitive: `src/upstream/index.ts` builds the whole `sayari` client at
 * module scope, and `endpoints.ts` imports the SDK's own request types to
 * declare `TraversalWalkParams`). This file has neither import, so both
 * `enqueues.ts` and `src/jobs/traverse.ts` can share one schema without either
 * pulling the SDK into the tools layer.
 */
export const deepTraversalParamsSchema = z
  .object({
    relationships: z.array(z.string()),
    riskCategories: z.array(z.string()),
    countries: z.array(z.string()),
    minShares: z.number(),
    sanctioned: z.boolean(),
    pep: z.boolean(),
    excludeClosedEntities: z.boolean(),
  })
  .partial();

export type DeepTraversalParams = z.infer<typeof deepTraversalParamsSchema>;

/**
 * Reads `job.params` back into `DeepTraversalParams`, tolerantly — a `null`
 * column, a malformed row, or an unrecognised key all fall back to `{}`,
 * which is exactly the unfiltered walk `traverse.ts` sent before these inputs
 * existed. `job.params` is a loosely-typed jsonb bag (`src/db/schema/
 * runs.ts`), so this is the one place its shape is actually checked before it
 * reaches an upstream call.
 */
export function readDeepTraversalParams(raw: unknown): DeepTraversalParams {
  const parsed = deepTraversalParamsSchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : {};
}
