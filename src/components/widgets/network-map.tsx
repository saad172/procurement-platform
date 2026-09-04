'use client';

/**
 * `network-map.tsx` — the ONLY file a page should import for the Network
 * diagram (ticket 05, network spec §8). Import `NetworkMap` (and, for props,
 * `NetworkMapProps`/`NetworkMapPath`/`NetworkMapEdge`/`NetworkMapRoot`/
 * `NetworkMapPathKind`) from here — never from `./network-map-inner`.
 *
 * ## Why two files
 *
 * `node_modules/next/dist/docs/01-app/02-guides/lazy-loading.md` is explicit:
 *
 * > `ssr: false` option is not supported in Server Components. You will see
 * > an error if you try to use it in Server Components. `ssr: false` is not
 * > allowed with `next/dynamic` in Server Components. Please move it into a
 * > Client Component.
 *
 * A page under `src/app` is a Server Component by default
 * (`05-server-and-client-components.md`). The real diagram
 * (`network-map-inner.tsx`) calls `cytoscape`, which touches `window` at
 * module-evaluation time, so it must never reach the server bundle at all —
 * which is exactly what `dynamic(..., { ssr: false })` buys. But that
 * `dynamic()` call has to live inside a file already marked `'use client'`,
 * so it cannot live in the Server Component page itself. THIS file is that
 * `'use client'` home for the `dynamic()` call; `network-map-inner.tsx` is
 * its target and never needs `ssr:false` itself, only `'use client'` (it
 * calls hooks and touches the DOM directly).
 *
 * A consuming page therefore does:
 *
 *     import { NetworkMap, type NetworkMapPath } from '@/components/widgets/network-map';
 *     // ...
 *     <NetworkMap roots={[{ id: profile.id, label: supplier.rosterName }]} paths={familyChain} programId={programId} />
 *
 * and never imports `network-map-inner.tsx` directly, from a Server or a
 * Client Component either one.
 */

import dynamic from 'next/dynamic';
import type { NetworkMapProps } from './network-map-inner';

export type {
  NetworkMapProps,
  NetworkMapPath,
  NetworkMapEdge,
  NetworkMapRoot,
  NetworkMapPathKind,
} from './network-map-inner';

/** The `loading` fallback while cytoscape's own chunk downloads — plain markup, no client-only API, so it costs nothing to keep in this file rather than the lazy-loaded one. */
export function NetworkMapSkeleton() {
  return (
    <div
      aria-hidden="true"
      style={{
        height: 420,
        background: 'var(--paper-2)',
        border: '1px solid var(--rule)',
        borderRadius: 'var(--radius)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <span className="note">Loading the network diagram…</span>
    </div>
  );
}

/**
 * The diagram, dynamically imported with `ssr: false` — no server render, no
 * cytoscape in the initial bundle. Fed stored Paths as JSON (network spec
 * §8): a page view of this component never spends an upstream credit, since
 * it renders whatever `paths` its caller already loaded from `graph_path`.
 */
export const NetworkMap = dynamic<NetworkMapProps>(() => import('./network-map-inner'), {
  ssr: false,
  loading: NetworkMapSkeleton,
});
