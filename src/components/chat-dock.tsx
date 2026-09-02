'use client';

import { usePathname, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { readServerSentEvents } from '@/lib/server-sent-events';
import type { Widget } from '@/tools/define';
import { RenderWidget } from '@/components/widgets';

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
 *
 * `ChatDock` itself is the toggle and the shell; the Thread — its turns, its
 * in-flight send, the SSE stream that fills it — lives in `useChatThread`
 * below, so "where is a message sent" has one place to look regardless of
 * which of the dock's two shapes (closed button, open panel) is on screen.
 */

/** One tool call's frozen result, as the dock draws it — the `Widget` itself is `@/tools/define`'s, the one type `widget()` produces. */
type WidgetCall = { toolName: string; widget: Widget };
type Proposal = {
  /**
   * The `thread_message` row this proposal was written to. The gate posts it
   * back, because the person's answer has to name the row it answers.
   */
  messageId: string;
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
  widgets?: WidgetCall[];
  proposals?: Proposal[];
};

/**
 * The Thread: its turns, and the one in-flight send.
 *
 * ONE IN-FLIGHT TURN PER THREAD: the input is disabled while `busy`, so there
 * is no interleaving to reason about.
 */
function useChatThread(programId: string) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [threadId, setThreadId] = useState<string | undefined>();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState('');
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
      const replaceLast = (turn: Turn) => setTurns((previous) => [...previous.slice(0, -1), turn]);

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
            widgets: WidgetCall[];
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
        {
          role: 'assistant',
          text: `The request failed: ${error instanceof Error ? error.message : String(error)}`,
        },
      ]);
    } finally {
      setBusy(false);
    }
  }

  return { turns, input, setInput, busy, send };
}

/**
 * THE PERMANENT DISCLOSURE. It is not a warning that appears when something
 * goes wrong — it is a standing statement of what this surface is, because
 * the exemption it describes is permanent.
 */
function ChatDisclosure() {
  return (
    <p
      className="note"
      style={{
        margin: 0,
        padding: '0.5rem 1rem',
        background: '#fff7e6',
        borderBottom: '1px solid var(--rule)',
      }}
    >
      Chat is not citation-checked. The record is the Assessment.
    </p>
  );
}

/** Widgets are FROZEN from the tool's return value, not typed by the model — which is why `render_table` is not a tool. */
function TurnWidgets({ widgets }: { widgets: WidgetCall[] }) {
  return (
    <>
      {widgets.map((widget, widgetIndex) => (
        <RenderWidget key={widgetIndex} toolName={widget.toolName} widget={widget.widget} />
      ))}
    </>
  );
}

function ChatTranscript({ turns }: { turns: Turn[] }) {
  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: '1rem' }}>
      {turns.length === 0 ? (
        <p className="note">
          Ask about a supplier, a shortlist, or what a score is made of. Anything that spends or
          writes is proposed with an estimate first, and nothing runs until you say so.
        </p>
      ) : null}

      {turns.map((turn, index) => (
        <div key={index} style={{ marginBottom: '1rem' }}>
          <p className="note" style={{ margin: 0 }}>
            {turn.role}
          </p>
          <p style={{ margin: '0.2rem 0', whiteSpace: 'pre-wrap' }}>{turn.text}</p>
          {turn.widgets ? <TurnWidgets widgets={turn.widgets} /> : null}
          {turn.proposals?.map((proposal, proposalIndex) => (
            <ConfirmGate key={proposalIndex} proposal={proposal} />
          ))}
        </div>
      ))}
    </div>
  );
}

function ChatComposer({
  input,
  onChange,
  busy,
  onSend,
}: {
  input: string;
  onChange: (value: string) => void;
  busy: boolean;
  onSend: () => void;
}) {
  return (
    <div
      style={{
        borderTop: '1px solid var(--rule)',
        padding: '0.7rem 1rem',
        display: 'flex',
        gap: '0.5rem',
      }}
    >
      <input
        value={input}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') onSend();
        }}
        disabled={busy}
        placeholder={busy ? 'Thinking…' : 'Ask something'}
        style={{ flex: 1, padding: '0.45rem', border: '1px solid var(--rule)', borderRadius: 4 }}
      />
      <button
        type="button"
        onClick={onSend}
        disabled={busy}
        className="badge"
        style={{ cursor: 'pointer', padding: '0.45rem 0.8rem' }}
      >
        Send
      </button>
    </div>
  );
}

export function ChatDock({ programId }: { programId: string }) {
  const [open, setOpen] = useState(false);
  const { turns, input, setInput, busy, send } = useChatThread(programId);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="badge"
        style={{
          position: 'fixed',
          right: '1.25rem',
          bottom: '1.25rem',
          padding: '0.5rem 0.9rem',
          cursor: 'pointer',
          background: 'var(--paper)',
        }}
      >
        Ask about this program
      </button>
    );
  }

  return (
    <aside
      style={{
        position: 'fixed',
        right: 0,
        top: 0,
        bottom: 0,
        width: 'min(30rem, 100vw)',
        background: 'var(--paper)',
        borderLeft: '1px solid var(--rule)',
        display: 'flex',
        flexDirection: 'column',
        zIndex: 10,
      }}
    >
      <header
        style={{
          padding: '0.8rem 1rem',
          borderBottom: '1px solid var(--rule)',
          display: 'flex',
          justifyContent: 'space-between',
        }}
      >
        <strong>Chat</strong>
        <button
          type="button"
          onClick={() => setOpen(false)}
          style={{ border: 0, background: 'none', cursor: 'pointer' }}
        >
          close
        </button>
      </header>

      <ChatDisclosure />
      <ChatTranscript turns={turns} />
      <ChatComposer input={input} onChange={setInput} busy={busy} onSend={() => void send()} />
    </aside>
  );
}

/**
 * The confirm gate (SPEC §14.5).
 *
 * Rendered **from `confirm(input)` itself** and stored on the message, so what
 * the person consented to is what ran. **No editing here** — editing would make
 * the gate an input form and split the proposal from the act.
 *
 * Both buttons post `{ messageId, accept }` to `/api/chat/confirm`, which is
 * where the tool actually runs; the sending lives in `useConfirm` below.
 */
function ConfirmGate({ proposal }: { proposal: Proposal }) {
  const { state, failure, answer } = useConfirm(proposal.messageId);

  return (
    <div className="card" style={{ marginTop: '0.5rem', borderColor: '#f0dcb4' }}>
      <p style={{ margin: 0, fontWeight: 600 }}>{proposal.estimate.what}</p>
      <p className="note" style={{ margin: '0.3rem 0' }}>
        {/*
          On a params_hash hit the gate reads "cached — no credits, no wait",
          which is the difference between a gate people read and a gate people
          click through.
        */}
        {proposal.estimate.cached ? <strong>cached — no credits, no wait. </strong> : null}
        {Object.entries(proposal.estimate.spends)
          .filter(([, value]) => value != null)
          .map(
            ([key, value]) =>
              `${key}: ${typeof value === 'object' ? JSON.stringify(value) : String(value)}`,
          )
          .join(' · ')}
      </p>
      <p className="note" style={{ margin: '0.3rem 0' }}>
        {proposal.estimate.basis}
      </p>
      {proposal.estimate.caveats.length > 0 ? (
        <ul className="note" style={{ margin: '0.3rem 0', paddingLeft: '1.1rem' }}>
          {proposal.estimate.caveats.map((caveat) => (
            <li key={caveat}>{caveat}</li>
          ))}
        </ul>
      ) : null}

      {state === 'accepted' || state === 'declined' ? (
        <p className="note" style={{ margin: '0.4rem 0 0' }}>
          {state === 'accepted'
            ? 'Enqueued. The application will say when it finishes — the model does not announce it, because it would be writing about results it has not read.'
            : 'Declined. The model has been told, so it can offer something cheaper rather than proposing this again.'}
        </p>
      ) : (
        <>
          <div style={{ display: 'flex', gap: '0.4rem', marginTop: '0.5rem' }}>
            <button
              type="button"
              className="badge good"
              style={{ cursor: 'pointer' }}
              disabled={state === 'sending'}
              onClick={() => void answer(true)}
            >
              Run it
            </button>
            <button
              type="button"
              className="badge mute"
              style={{ cursor: 'pointer' }}
              disabled={state === 'sending'}
              onClick={() => void answer(false)}
            >
              No
            </button>
          </div>
          {/*
            A failed answer says what happened and leaves the buttons, because
            the proposal is still `proposed` in the database — the person's
            press did not take, and a gate that hid its buttons after one would
            read as though it had.
          */}
          {state === 'failed' ? (
            <p className="note" style={{ margin: '0.4rem 0 0' }}>
              That did not go through: {failure}
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}

/** What the confirm route answers with: `{ declined }`, `{ ok, data }`, or `{ error }`. */
type ConfirmAnswer = { declined?: boolean; ok?: boolean; data?: unknown; error?: string };

/**
 * The person's answer, posted to the route that owns it.
 *
 * A hook rather than a handler inside `ConfirmGate`, for the reason
 * `useChatThread` is one: the gate above is what a person *reads* before
 * deciding, and where an answer is *sent* has one place to look.
 *
 * `sending` disables both buttons, so one proposal cannot be answered twice;
 * `failed` keeps them, so an answer that did not reach the route can be given
 * again. Neither state is written anywhere — the row's `confirm_state` is the
 * record, and this is only what the screen says while the post is in the air.
 */
function useConfirm(messageId: string) {
  const [state, setState] = useState<'proposed' | 'sending' | 'accepted' | 'declined' | 'failed'>(
    'proposed',
  );
  const [failure, setFailure] = useState('');

  async function answer(accept: boolean) {
    setState('sending');
    try {
      const response = await fetch('/api/chat/confirm', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // The id names the row this answers. The route reads the frozen
        // estimate off that row, so what runs is what the person was shown.
        body: JSON.stringify({ messageId, accept }),
      });
      const body = (await response.json().catch(() => ({}))) as ConfirmAnswer;

      const reason = failureOf(response, body);
      if (reason != null) {
        setFailure(reason);
        setState('failed');
        return;
      }
      setState(accept ? 'accepted' : 'declined');
    } catch (error) {
      // Named, never dressed up as an assistant apology — the same rule the
      // send path follows.
      setFailure(error instanceof Error ? error.message : String(error));
      setState('failed');
    }
  }

  return { state, failure, answer };
}

/** The reason an answer did not take, or `null` when it did. */
function failureOf(response: Response, answer: ConfirmAnswer): string | null {
  if (!response.ok) return answer.error ?? `the confirm route answered ${response.status}`;

  // A 200 carrying `ok: false` is the tool's own objections. They are shown
  // verbatim rather than reported as a run, because nothing ran.
  if (answer.ok === false) {
    return Array.isArray(answer.data) ? answer.data.join(' · ') : 'the tool did not run';
  }
  return null;
}
