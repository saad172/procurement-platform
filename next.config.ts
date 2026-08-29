import type { NextConfig } from 'next';

/**
 * The web process serves pages, the chat route handler and cheap inline reads
 * (SPEC §2.2). Everything that spends a credit or runs a loop lives in the
 * worker, so this config stays deliberately small.
 */
const nextConfig: NextConfig = {
  // `postgres` and the Sayari SDK are Node-only; keep them out of any bundle
  // the Edge runtime or the browser would try to trace.
  serverExternalPackages: ['postgres', '@sayari/sdk'],

  typedRoutes: true,
};

export default nextConfig;
