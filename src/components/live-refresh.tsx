'use client';

import { useEffect, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Live progress on a server-rendered page (SPEC §5.1).
 *
 * The worker writes Job state to Postgres and **holds no inbound port by
 * design** (SPEC §2.2), so there is nothing for the browser to subscribe to. A
 * socket would mean giving the worker the one thing it exists not to have. The
 * page asks again instead, and every figure it re-reads is a real row.
 *
 * **Self-pacing rather than a fixed interval.** `router.refresh()` inside a
 * transition holds `isPending` until the new RSC payload lands, and the next
 * tick is only scheduled once it has — so a slow query spaces the polls out
 * instead of stacking them behind each other.
 *
 * It stops on two conditions, and both matter. `active` goes false the moment
 * nothing is queued or running, because a finished Run that kept polling would
 * be a page quietly re-querying for ever. And a **hidden tab polls nothing** —
 * a Run page left open in a background tab is the same leak with no one
 * watching it.
 */
export function LiveRefresh({
  active,
  everyMs = 2000,
  idle,
}: {
  active: boolean;
  everyMs?: number;
  /** What to say once there is nothing left to watch. Nothing, by default. */
  idle?: string;
}) {
  const router = useRouter();
  const [refreshing, startRefresh] = useTransition();
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    const read = () => setVisible(document.visibilityState === 'visible');
    read();
    document.addEventListener('visibilitychange', read);
    return () => document.removeEventListener('visibilitychange', read);
  }, []);

  useEffect(() => {
    if (!active || !visible || refreshing) return;
    const timer = setTimeout(() => startRefresh(() => router.refresh()), everyMs);
    return () => clearTimeout(timer);
  }, [active, visible, refreshing, everyMs, router]);

  if (!active) return idle ? <span className="note">{idle}</span> : null;

  return (
    <span className="live" aria-live="polite">
      <i aria-hidden="true" />
      {!visible
        ? 'paused while this tab is in the background'
        : refreshing
          ? 'reading…'
          : `live · re-reading every ${Math.round(everyMs / 1000)}s`}
    </span>
  );
}
