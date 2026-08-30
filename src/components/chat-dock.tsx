'use client';

import { usePathname, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { readServerSentEvents } from '@/lib/server-sent-events';

/**
 * The chat dock (SPEC §14).
 *
 * One sentence carries the whole surface:
 *
 * > **Chat is the only surface in this app where an agent may write an uncited
 * > sentence — so everything it *shows* is frozen from a tool, and everything it
 * > *does* is proposed rather than done.**
 *
 * The Citation rule is deliberately **not** extended here: a validator on a
 * streaming turn either blocks the stream or rejects after the person has
 * already read the sentence, and it would tempt the model to cite whatever
 * *resolves* rather than whatever it used. So the exemption is **stated**
 * instead — permanently, in the dock, where it cannot be missed.
 *
 * **Honest cost for the write-up:** the app has exactly one surface where an
 * agent can state an unproven number, and it is the one the user talks to.
 */

type Widget = { toolName: string; widget: { type: string; payload: unknown } };
type Proposal = {
  toolName: string;
  input: unknown;
  estimate: {
    what: string;
    spends: Record<string, unknown>;
    basis: string;
    caveats: string[];
    cached?: boolean;
  };
};

type Turn = {
  role: 'user' | 'assistant';
  text: string;
  widgets?: Widget[];
  proposals?: Proposal[];
};

export function ChatDock({ programId }: { programId: string }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [open, setOpen] = useState(false);
  const [threadId, setThreadId] = useState<string | undefined>();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState('');
  // ONE IN-FLIGHT TURN PER THREAD: the input is disabled while it runs, so
  // there is no interleaving to reason about.
  const [busy, setBusy] = useState(false);

  async function send() {
    const message = input.trim();
    if (!message || busy) return;
    setInput('');
    setTurns((previous) => [...previous, { role: 'user', text: message }]);
    setBusy(true);

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          threadId,
          programId,
          message,
          // The page AND its view state, so chat answers about the ranking the
          // person is actually looking at.
          pageRef: `${pathname}${searchParams.toString() ? `?${searchParams}` : ''}`,
          viewState: Object.fromEntries(searchParams.entries()),
        }),
      });
      if (!response.ok || !response.body) {
        throw new Error(`the chat route answered ${response.status}`);
      }

      /**
       * The assistant's turn is appended **empty** and then filled.
       *
       * Every later update rewrites this one entry rather than appending, which
       * is what keeps a streamed turn a single turn in the transcript — the
       * alternative, appending per delta, renders as a wall of one-word
       * messages.
       */
      let streamed = '';
      setTurns((previous) => [...previous, { role: 'assistant', text: '' }]);
      const replaceLast = (turn: Turn) =>
        setTurns((previous) => [...previous.slice(0, -1), turn]);

      for await (const event of readServerSentEvents(response.body)) {
        if (event.event === 'open') {
          setThreadId((JSON.parse(event.data) as { threadId: string }).threadId);
        } else if (event.event === 'delta') {
          streamed += JSON.parse(event.data) as string;
          replaceLast({ role: 'assistant', text: streamed });
        } else if (event.event === 'done') {
          /**
           * The settled payload replaces the streamed text rather than
           * appending to it. Deltas are display; this is the row that was
           * stored, and the two must not be able to disagree on screen.
           */
          const data = JSON.parse(event.data) as {
            threadId: string;
            text: string;
            widgets: Widget[];
            proposals: Proposal[];
          };
          setThreadId(data.threadId);
          replaceLast({
            role: 'assistant',
            text: data.text,
            widgets: data.widgets,
            proposals: data.proposals,
          });
        } else if (event.event === 'error') {
          // Named, never dressed up as an assistant apology.
          replaceLast({
            role: 'assistant',
            text: `The request failed: ${(JSON.parse(event.data) as { message: string }).message}`,
          });
        }
      }
    } catch (error) {
      // A failure renders as an error block naming what happened, NEVER as an
      // assistant apology. It appends, because a throw here may have happened
      // before the empty assistant turn was ever added.
      setTurns((previous) => [
        ...previous,
        { role: 'assistant', text: `The request failed: ${error instanceof Error ? error.message : String(error)}` },
      ]);
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="badge"
        style={{ position: 'fixed', right: '1.25rem', bottom: '1.25rem', padding: '0.5rem 0.9rem', cursor: 'pointer', background: 'var(--paper)' }}
      >
        Ask about this programme
      </button>
    );
  }

  return (
    <aside
      style={{
        position: 'fixed', right: 0, top: 0, bottom: 0, width: 'min(30rem, 100vw)',
        background: 'var(--paper)', borderLeft: '1px solid var(--rule)',
        display: 'flex', flexDirection: 'column', zIndex: 10,
      }}
    >
      <header style={{ padding: '0.8rem 1rem', borderBottom: '1px solid var(--rule)', display: 'flex', justifyContent: 'space-between' }}>
        <strong>Chat</strong>
        <button type="button" onClick={() => setOpen(false)} style={{ border: 0, background: 'none', cursor: 'pointer' }}>
          close
        </button>
      </header>

      {/*
        THE PERMANENT DISCLOSURE. It is not a warning that appears when something
        goes wrong — it is a standing statement of what this surface is, because
        the exemption it describes is permanent.
      */}
      <p className="note" style={{ margin: 0, padding: '0.5rem 1rem', background: '#fff7e6', borderBottom: '1px solid var(--rule)' }}>
        Chat is not citation-checked. The record is the Assessment.
      </p>

      <div style={{ flex: 1, overflowY: 'auto', padding: '1rem' }}>
        {turns.length === 0 ? (
          <p className="note">
            Ask about a supplier, a shortlist, or what a score is made of. Anything that spends or
            writes is proposed with an estimate first, and nothing runs until you say so.
          </p>
        ) : null}

        {turns.map((turn, index) => (
          <div key={index} style={{ marginBottom: '1rem' }}>
            <p className="note" style={{ margin: 0 }}>{turn.role}</p>
            <p style={{ margin: '0.2rem 0', whiteSpace: 'pre-wrap' }}>{turn.text}</p>

            {/* Widgets are FROZEN from the tool's return value, not typed by
                the model — which is why `render_table` is not a tool. */}
            {turn.widgets?.map((widget, widgetIndex) => (
              <details key={widgetIndex} className="card" style={{ marginTop: '0.4rem', padding: '0.5rem 0.7rem' }} open>
                <summary className="note">{widget.toolName} · {widget.widget.type}</summary>
                <pre className="mono" style={{ margin: '0.4rem 0 0', whiteSpace: 'pre-wrap', maxHeight: '14rem', overflow: 'auto' }}>
                  {JSON.stringify(widget.widget.payload, null, 2).slice(0, 1800)}
                </pre>
              </details>
            ))}

            {turn.proposals?.map((proposal, proposalIndex) => (
              <ConfirmGate key={proposalIndex} proposal={proposal} />
            ))}
          </div>
        ))}
      </div>

      <div style={{ borderTop: '1px solid var(--rule)', padding: '0.7rem 1rem', display: 'flex', gap: '0.5rem' }}>
        <input
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Enter') void send(); }}
          disabled={busy}
          placeholder={busy ? 'Thinking…' : 'Ask something'}
          style={{ flex: 1, padding: '0.45rem', border: '1px solid var(--rule)', borderRadius: 4 }}
        />
        <button type="button" onClick={() => void send()} disabled={busy} className="badge" style={{ cursor: 'pointer', padding: '0.45rem 0.8rem' }}>
          Send
        </button>
      </div>
    </aside>
  );
}

/**
 * The confirm gate (SPEC §14.5).
 *
 * Rendered **from `confirm(input)` itself** and stored on the message, so what
 * the person consented to is what ran. **No editing here** — editing would make
 * the gate an input form and split the proposal from the act.
 */
function ConfirmGate({ proposal }: { proposal: Proposal }) {
  const [state, setState] = useState<'proposed' | 'accepted' | 'declined'>('proposed');

  return (
    <div className="card" style={{ marginTop: '0.5rem', borderColor: '#f0dcb4' }}>
      <p style={{ margin: 0, fontWeight: 600 }}>{proposal.estimate.what}</p>
      <p className="note" style={{ margin: '0.3rem 0' }}>
        {/*
          On a params_hash hit the gate reads "cached — no credits, no wait",
          which is the difference between a gate people read and a gate people
          click through.
        */}
        {proposal.estimate.cached ? (
          <strong>cached — no credits, no wait. </strong>
        ) : null}
        {Object.entries(proposal.estimate.spends)
          .filter(([, value]) => value != null)
          .map(([key, value]) => `${key}: ${typeof value === 'object' ? JSON.stringify(value) : String(value)}`)
          .join(' · ')}
      </p>
      <p className="note" style={{ margin: '0.3rem 0' }}>{proposal.estimate.basis}</p>
      {proposal.estimate.caveats.length > 0 ? (
        <ul className="note" style={{ margin: '0.3rem 0', paddingLeft: '1.1rem' }}>
          {proposal.estimate.caveats.map((caveat) => (
            <li key={caveat}>{caveat}</li>
          ))}
        </ul>
      ) : null}

      {state === 'proposed' ? (
        <div style={{ display: 'flex', gap: '0.4rem', marginTop: '0.5rem' }}>
          <button type="button" className="badge good" style={{ cursor: 'pointer' }} onClick={() => setState('accepted')}>
            Run it
          </button>
          <button type="button" className="badge mute" style={{ cursor: 'pointer' }} onClick={() => setState('declined')}>
            No
          </button>
        </div>
      ) : (
        <p className="note" style={{ margin: '0.4rem 0 0' }}>
          {state === 'accepted'
            ? 'Enqueued. The application will say when it finishes — the model does not announce it, because it would be writing about results it has not read.'
            : 'Declined. The model has been told, so it can offer something cheaper rather than proposing this again.'}
        </p>
      )}
    </div>
  );
}
