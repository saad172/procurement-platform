'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import {
  estimateJobStart,
  runConfirmedJobStart,
  type JobStartConfirmedResult,
  type JobStartEstimateResult,
} from './confirm-gate-actions';

/**
 * The page-native confirm gate's UI (`./confirm-gate-actions.ts`'s own doc
 * comment carries the full design — read that first). This is the ONE
 * generic piece: any page wiring any confirm-gated job-start tool to a
 * button renders `<ConfirmGatePanel toolName="..." input={{...}} .../>` and
 * gets the estimate-then-confirm flow for free, the same way `ChatDock`'s own
 * `ConfirmGate` (`src/components/chat-dock.tsx`) renders one for a chat
 * proposal — this is that component's page-native sibling, deliberately
 * matching its visual vocabulary (`.answer.you`, `.badge good`/`.badge mute`,
 * a disabled-while-sending pair of buttons) rather than inventing a second
 * one.
 *
 * **One difference from `ChatDock`'s gate.** A chat proposal already carries
 * its `Estimate` — `confirm()` ran server-side during the model's own turn,
 * before the message was ever written — so `ConfirmGate` only ever posts the
 * accept/decline. This component calls `estimateJobStart` itself, on mount,
 * because nothing has proposed anything yet: the person opening this panel
 * (by tapping Expand on a diagram node, today) IS the proposal.
 *
 * **A caller that reuses one instance across a changing subject (e.g.
 * `ExpandNodePanel` across different tapped nodes) must give it a `key`
 * derived from that subject** (React's own "resetting state with a key"
 * pattern), so a new subject starts a fresh mount rather than showing the
 * PREVIOUS subject's estimate while the new one loads — this component holds
 * no logic to reset itself mid-life, on purpose (see the effect below).
 *
 * `ExpandNodePanel` (`src/components/widgets/expand-node-button.tsx`) is the
 * one caller today; any future page wires a different `toolName`/`input`
 * pair to a button of its own and reuses this component unchanged.
 */
export type ConfirmGatePanelProps = {
  toolName: string;
  input: Record<string, unknown>;
  programId: string;
  /** Shown once the estimate is ready, in place of `estimate.what` — e.g. "Expand from Yazaki Corporation". Falls back to `estimate.what` when omitted. */
  title?: string;
  /** Rendered as a third, plain button beside Confirm — e.g. "close this panel" for a caller that opened it from a click rather than a fixed slot on the page. */
  onCancel?: () => void;
};

type ConfirmState = 'idle' | 'confirming' | 'done';

export function ConfirmGatePanel({
  toolName,
  input,
  programId,
  title,
  onCancel,
}: ConfirmGatePanelProps) {
  const [estimate, setEstimate] = useState<JobStartEstimateResult | null>(null);
  const [confirmState, setConfirmState] = useState<ConfirmState>('idle');
  const [result, setResult] = useState<JobStartConfirmedResult | null>(null);

  // No synchronous setState here on purpose (react-hooks/set-state-in-effect):
  // `estimate` starts `null` from `useState` itself, and every write to it
  // happens inside the settled `.then()` callback below — the sanctioned
  // shape for "subscribe to an external system, setState when it answers."
  // A caller across a changing subject resets by `key`, not by this effect
  // clearing state on every re-run (see this file's own doc comment).
  useEffect(() => {
    let cancelled = false;
    void estimateJobStart(toolName, input).then(
      (res) => {
        if (!cancelled) setEstimate(res);
      },
      (error: unknown) => {
        if (!cancelled) {
          setEstimate({ ok: false, error: error instanceof Error ? error.message : String(error) });
        }
      },
    );
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toolName, JSON.stringify(input)]);

  async function confirm(): Promise<void> {
    setConfirmState('confirming');
    try {
      setResult(await runConfirmedJobStart(toolName, input));
    } catch (error) {
      setResult({ ok: false, objections: [error instanceof Error ? error.message : String(error)] });
    } finally {
      setConfirmState('done');
    }
  }

  return (
    <div className="answer you" style={{ margin: '0.6rem 0' }}>
      {!estimate ? <p className="said">Reading what this would cost…</p> : null}
      {estimate && !estimate.ok ? <EstimateFailure error={estimate.error} /> : null}
      {estimate?.ok ? (
        <EstimateReady
          title={title}
          estimate={estimate.estimate}
          confirmState={confirmState}
          result={result}
          programId={programId}
          onConfirm={() => void confirm()}
          onCancel={onCancel}
        />
      ) : null}
    </div>
  );
}

function EstimateFailure({ error }: { error: string }) {
  return (
    <>
      <p className="said">Could not read an estimate.</p>
      <p className="because">{error}</p>
    </>
  );
}

/** The estimate, its outcome once confirmed, and the Confirm/Cancel pair — split from `ConfirmGatePanel` itself so that function stays a plain state machine and this stays a plain readout. */
function EstimateReady({
  title,
  estimate,
  confirmState,
  result,
  programId,
  onConfirm,
  onCancel,
}: {
  title: string | undefined;
  estimate: Extract<JobStartEstimateResult, { ok: true }>['estimate'];
  confirmState: ConfirmState;
  result: JobStartConfirmedResult | null;
  programId: string;
  onConfirm: () => void;
  onCancel?: (() => void) | undefined;
}) {
  return (
    <>
      <p className="said">{title ?? estimate.what}</p>
      <p className="because">
        {estimate.cached ? <strong>cached — no credits, no wait. </strong> : null}
        {formatSpends(estimate.spends)}
      </p>
      <p className="because">{estimate.basis}</p>
      {estimate.caveats.length > 0 ? (
        <ul className="note" style={{ margin: '0.3rem 0', paddingLeft: '1.1rem' }}>
          {estimate.caveats.map((caveat) => (
            <li key={caveat}>{caveat}</li>
          ))}
        </ul>
      ) : null}

      {confirmState === 'done' && result ? (
        <ConfirmOutcome result={result} programId={programId} />
      ) : (
        <div className="do">
          <button
            type="button"
            className="badge good"
            style={{ cursor: 'pointer' }}
            disabled={confirmState === 'confirming'}
            onClick={onConfirm}
          >
            Confirm
          </button>
          {onCancel ? (
            <button
              type="button"
              className="badge mute"
              style={{ cursor: 'pointer' }}
              disabled={confirmState === 'confirming'}
              onClick={onCancel}
            >
              Cancel
            </button>
          ) : null}
        </div>
      )}
    </>
  );
}

function ConfirmOutcome({
  result,
  programId,
}: {
  result: JobStartConfirmedResult;
  programId: string;
}) {
  if (!result.ok) return <p className="because">Did not run: {result.objections.join(' · ')}</p>;
  return (
    <p className="because">
      Started.{' '}
      <Link href={`/program/${programId}/runs/${result.runId}` as never}>
        Track it on the Run page →
      </Link>
    </p>
  );
}

/** Matches `ChatDock`'s own `ConfirmGate` formatting exactly (`src/components/chat-dock.tsx`) — one shared reading for what an `Estimate.spends` bag says, whichever gate is showing it. */
function formatSpends(spends: Record<string, unknown>): string {
  return Object.entries(spends)
    .filter(([, value]) => value != null)
    .map(
      ([key, value]) =>
        `${key}: ${typeof value === 'object' ? JSON.stringify(value) : String(value)}`,
    )
    .join(' · ');
}
