'use client';

import { useState } from 'react';
import { ConfirmGatePanel } from '@/components/confirm-gate-panel';
import { NetworkMap, type NetworkMapProps } from './network-map';

/**
 * **Expand** (network spec §8: *"Expand enqueues a Deep Traversal through the
 * existing confirm gate with its estimate; the diagram fills in when the Job
 * lands"*) — ticket 05, unit 05g.
 *
 * `NetworkMap` (`./network-map.tsx`, unit 05d) already draws the "Expand"
 * badge on a tapped node and calls `onExpand(entityId)` when it is pressed —
 * that prop **must be supplied from a Client Component**, which a Server
 * Component page cannot do directly (05d's own finding: passing a function
 * prop across the RSC boundary throws). `NetworkMapWithExpand` below is that
 * Client Component: it owns the `onExpand` wiring so a page never has to.
 *
 * ## The two pieces
 *
 * - `ExpandNodePanel` — `enqueue_deep_traversal`'s own confirm-gate UI for
 *   one tapped entity, built on the fully generic
 *   `ConfirmGatePanel`/`estimateJobStart`/`runConfirmedJobStart`
 *   (`src/components/confirm-gate-panel.tsx`, `./confirm-gate-actions.ts` —
 *   read that file's own doc comment for the full design). Everything
 *   Deep-Traversal-specific lives HERE — the tool name, the `{ entityId,
 *   programId }` input shape, the panel's title — not in the generic pieces,
 *   so THEY stay reusable for a different job-start tool with no change.
 * - `NetworkMapWithExpand` — `NetworkMap`, wired: a page imports this INSTEAD
 *   of `NetworkMap` and gets Expand for free, with no local state of its own.
 *   A page that does not want Expand keeps importing bare `NetworkMap`
 *   exactly as today (`network-map.tsx`'s own doc comment) — this file adds
 *   an option, it does not change the existing one.
 *
 * **Reusable past this ticket's two pages on purpose.** Network spec §8's own
 * Display table names Expand for the Entity page only, and the Supplier
 * page's Network section (unit 05e, built in parallel with this one) may or
 * may not adopt it — this component does not know or care which pages use
 * it. Swapping `<NetworkMap ...>` for `<NetworkMapWithExpand ...>` (same
 * props, minus `onExpand`) is the whole integration cost for a future page
 * that wants it.
 */

/** `enqueue_deep_traversal`'s own input shape (`src/tools/catalog/enqueues.ts`) narrowed to what a diagram tap can supply — the walk's optional filters (`relationships`, `riskCategories`, …) are a chat-only refinement this affordance does not expose; omitting them is the unfiltered walk the tool already treats as its default. */
export type ExpandNodePanelProps = {
  entityId: string;
  programId: string;
  onCancel?: () => void;
};

/** `enqueue_deep_traversal`'s confirm gate for one entity — the tool name and input shape live here, once. */
export function ExpandNodePanel({ entityId, programId, onCancel }: ExpandNodePanelProps) {
  return (
    <ConfirmGatePanel
      // Keyed on the entity, not left to `ConfirmGatePanel`'s own effect to
      // reset: React's own "reset state with a key" pattern, and exactly
      // what that component's own doc comment asks its callers to do —
      // tapping a second node must not show the FIRST node's estimate while
      // the second one's is still loading.
      key={entityId}
      toolName="enqueue_deep_traversal"
      input={{ entityId, programId }}
      programId={programId}
      title={`Expand from ${entityId}`}
      onCancel={onCancel}
    />
  );
}

/**
 * `NetworkMap`, with Expand wired: tapping a node's Expand badge opens
 * `ExpandNodePanel` for it, right beneath the diagram. Tapping a second node
 * (or the same one again) replaces the panel rather than stacking a second
 * one — one Expand proposal open at a time, so a person is never mid-estimate
 * on two nodes without realising it.
 */
export function NetworkMapWithExpand(props: Omit<NetworkMapProps, 'onExpand'>) {
  const [expandingEntityId, setExpandingEntityId] = useState<string | null>(null);

  return (
    <>
      <NetworkMap {...props} onExpand={setExpandingEntityId} />
      {expandingEntityId ? (
        <ExpandNodePanel
          entityId={expandingEntityId}
          programId={props.programId}
          onCancel={() => setExpandingEntityId(null)}
        />
      ) : null}
    </>
  );
}
