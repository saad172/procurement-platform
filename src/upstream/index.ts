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
      getRecord: run(endpoints.sayariGetRecord),
      resolve: run(endpoints.sayariResolve),
      searchEntity: run(endpoints.sayariSearchEntity),
      /** The Corporate family: one call, `limit: 50`, truncation recorded. */
      ownership: run(endpoints.sayariTraversalOwnership),
      traversal: run(endpoints.sayariTraversal),
      /** Slow (7–15 s) and barred from chat. Input is the resolved legal name. */
      negativeNews: run(endpoints.sayariNegativeNews),
      /** Slow (3.6–13.4 s) and barred from chat. Discover's mechanism. */
      tradeSearchSuppliers: run(endpoints.sayariTradeSearchSuppliers),
      usage: run(endpoints.sayariUsage),
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
export { ENDPOINTS } from './endpoints';
export type {
  EndpointDef,
  UpstreamContext,
  UpstreamCredentials,
  UpstreamResult,
  UpstreamSource,
  UpstreamVia,
} from './types';
