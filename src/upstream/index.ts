import { call } from './call';
import * as endpoints from './endpoints';
import type { UpstreamContext, UpstreamResult } from './types';

/**
 * The public surface of the upstream layer.
 *
 * Handlers never import their dependencies — `ctx.upstream` is **built by the
 * adapter** (SPEC §15.1), because the worker is one process that would
 * otherwise need both a pooled and a direct connection at import time, and
 * import-time env reading breaks outright.
 *
 * Every method here is a thin, typed wrapper over `call()`. There is no other
 * way out of this process to a third party.
 */

export type Upstream = ReturnType<typeof createUpstream>;

export function createUpstream(ctx: UpstreamContext) {
  const run =
    <P extends Record<string, unknown>, T>(def: Parameters<typeof call<P, T>>[0]) =>
    (params: P): Promise<UpstreamResult<T>> =>
      call(def, params, ctx);

  return {
    /** The context these calls are charged to, for a handler that needs to say so. */
    ctx,

    sayari: {
      getEntity: run(endpoints.sayariGetEntity),
      /** Cheaper than `getEntity`, no `relationships` block (SPEC §9 renames row 5). */
      entitySummary: run(endpoints.sayariEntitySummary),
      getRecord: run(endpoints.sayariGetRecord),
      resolve: run(endpoints.sayariResolve),
      searchEntity: run(endpoints.sayariSearchEntity),
      /** The Corporate family: one call, `limit: 50`, truncation recorded. */
      ownership: run(endpoints.sayariTraversalOwnership),
      /** The upward walk, reached only by a Deep Traversal (SPEC §8.5). */
      ubo: run(endpoints.sayariTraversalUbo),
      /** Paths to Listed entities, in either direction (network spec §4.1). */
      watchlist: run(endpoints.sayariTraversalWatchlist),
      traversal: run(endpoints.sayariTraversal),
      /** `entities: [source, target]` — Concentration at submission (network spec §4.2, §7). */
      shortestPath: run(endpoints.sayariTraversalShortestPath),
      /** Slow (7–15 s) and barred from chat. Input is the resolved legal name. */
      negativeNews: run(endpoints.sayariNegativeNews),
      /** Slow (3.6–13.4 s) and barred from chat. Discover's mechanism, and
       * — widened for `filter.supplierId` — the trade Job's first call
       * (network spec §4.3, ticket 05). */
      tradeSearchSuppliers: run(endpoints.sayariTradeSearchSuppliers),
      /** The trade Job's second call: the customer list, with risk and country. */
      tradeSearchBuyers: run(endpoints.sayariTradeSearchBuyers),
      /** The trade Job's third call: dated, citable sample shipment rows. */
      tradeSearchShipments: run(endpoints.sayariTradeSearchShipments),
      /** The trade Job's fourth call: upstream tiers, raw path (SDK request-
       * encoding bug — see the endpoint's own doc comment). */
      upstreamTradeTraversal: run(endpoints.sayariSupplyChainUpstreamTradeTraversal),
      // No `usage` wrapper: `info.getUsage` had no caller anywhere in the app
      // and was removed rather than wired (ticket 01 item D; A8; S7).
    },

    gleif: {
      /** The decisive exact join, and the auto-accept gate's second witness. */
      joinLei: run(endpoints.gleifJoinLei),
      /** A witness only: it hits the native-script primary name alone. */
      searchByName: run(endpoints.gleifSearchByName),
    },

    worldbank: { indicator: run(endpoints.worldBankIndicator) },
    usitc: { tariff: run(endpoints.usitcTariff) },
    nominatim: { geocode: run(endpoints.nominatimGeocode) },
  };
}

/**
 * The boot call (SPEC §16.7).
 *
 * Runs on start, **non-blocking**, logs its classification, and **gates
 * nothing** — credential *presence* is already the boot zod tier and still
 * refuses to boot. Its whole purpose is that one line of routing turns
 * emergency-only code into a path that runs every time. The raw-fetch fallback
 * is insurance CI never exercises; this is what keeps it warm.
 */
export async function probeUpstreamOnBoot(ctx: UpstreamContext): Promise<void> {
  if (!ctx.credentials) return;
  try {
    const result = await call(endpoints.sayariMetadataRaw, {}, ctx);
    console.warn(
      `[upstream] boot probe ok — Sayari metadata over the raw path (${result.cacheHit ? 'cached' : 'live'}).`,
    );
  } catch (error) {
    // Deliberately a warning, not a throw. A failed probe tells us the raw path
    // is cold; it does not tell us the app cannot run.
    console.warn(
      `[upstream] boot probe failed — the raw-fetch fallback may not work when it is needed: ` +
        (error instanceof Error ? error.message : String(error)),
    );
  }
}

export { call } from './call';
export { classify } from './classify';
export { UpstreamCacheMissError, UpstreamError, OBJECTIONABLE_KINDS } from './errors';
export type { UpstreamErrorKind } from './errors';
export { canonicalJson, hashBody, hashParams } from './hash';
export { paginateTraversal } from './paginate';
export type { PaginateBounds, TraversalStop, TraversalWalk } from './paginate';
export { ENDPOINTS } from './endpoints';
export type {
  EndpointDef,
  UpstreamContext,
  UpstreamCredentials,
  UpstreamResult,
  UpstreamSource,
  UpstreamVia,
} from './types';
