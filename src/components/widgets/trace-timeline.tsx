import { RawPayload } from './raw';
import { arr, isObj, num, str } from './narrow';

/**
 * `trace_timeline` — the Job page's turn list
 * (`src/app/program/[programId]/runs/[runId]/job/[jobId]/page.tsx`), one card
 * per turn: n, role, stop reason, token counts and the tools it called (SPEC
 * §14.4). It is the Trace CONTEXT.md defines — *the stored turns and tool
 * calls of a Job, viewable in the UI* — read here through the same rows the
 * page reads.
 *
 * **No link.** `list_trace`'s payload is `trace_turn` rows keyed by `jobId`
 * alone; the Job page's URL needs a `programId` and a `runId` ahead of that
 * id, and neither travels with a turn row, so nothing is guessed (finding
 * 103's shape, one level down from the tools it names).
 *
 * `trace_turn.response` is stored **as text** — the whole `BetaMessage`
 * verbatim (SPEC §3.7) — so it is parsed here rather than read as an object;
 * a turn whose JSON does not parse still renders its `n` and stop reason,
 * because those two columns are native to the row and never depend on the
 * parse succeeding.
 */
export function TraceTimelineWidget({ payload }: { payload: unknown }) {
  // Not an array at all: the shape this widget expects is wrong, not empty.
  if (!Array.isArray(payload)) return <RawPayload payload={payload} />;
  // An array IS this shape, and zero turns is a real state for a Job just
  // enqueued — distinct from a shape mismatch, so it gets its own line
  // rather than falling to a `RawPayload` that would print a bare `[]`.
  if (payload.length === 0) return <p className="empty">No turns recorded yet.</p>;

  const turns = payload.map(parseTurn).filter((t): t is NonNullable<typeof t> => t !== null);
  // Every entry is dropped rather than the whole payload thrown: one
  // unparseable turn among many should not blank the rest of the trace. If
  // every one failed, the array is not turn rows at all, so raw is the
  // more useful view of it.
  if (turns.length === 0) return <RawPayload payload={payload} />;
  return (
    <div>
      {turns.map((turn) => (
        <TurnCard key={turn.id} turn={turn} />
      ))}
    </div>
  );
}

/** ── One turn: its number, role and stop reason, its text, and the tools it called ── */
function TurnCard({ turn }: { turn: Turn }) {
  return (
    <div className="card" style={{ marginTop: '0.5rem' }}>
      <p
        style={{
          margin: 0,
          display: 'flex',
          gap: '0.4rem',
          alignItems: 'baseline',
          flexWrap: 'wrap',
        }}
      >
        <b>Turn {turn.n}</b>
        {turn.role ? <span className="badge mute">{turn.role}</span> : null}
        <span className="badge mute">{turn.stopReason ?? '—'}</span>
        {turn.inputTokens != null || turn.outputTokens != null ? (
          <span className="note">
            {turn.inputTokens ?? '—'} in · {turn.outputTokens ?? '—'} out
          </span>
        ) : null}
      </p>
      {turn.text.length > 0 ? (
        <p className="note" style={{ whiteSpace: 'pre-wrap', margin: '0.4rem 0 0' }}>
          {turn.text.join('\n\n')}
        </p>
      ) : null}
      {turn.toolNames.length > 0 ? (
        <p style={{ display: 'flex', gap: '0.3rem', flexWrap: 'wrap', margin: '0.4rem 0 0' }}>
          {turn.toolNames.map((name, i) => (
            <span key={i} className="badge">
              {name}
            </span>
          ))}
        </p>
      ) : null}
    </div>
  );
}

type Turn = {
  id: string;
  n: number;
  role: string | null;
  stopReason: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  text: string[];
  toolNames: string[];
};

/** `id` and `n` come off the row itself; everything else comes off the parsed `response` text and is absent together when it fails to parse. */
function parseTurn(raw: unknown): Turn | null {
  if (!isObj(raw)) return null;
  const id = str(raw.id);
  const n = num(raw.n);
  if (!id || n == null) return null;

  const body = str(raw.response);
  const parsed: unknown = body ? tryParse(body) : null;
  const content = isObj(parsed) ? arr(parsed.content) : [];
  const usage = isObj(parsed) ? parsed.usage : null;

  return {
    id,
    n,
    role: isObj(parsed) ? str(parsed.role) : null,
    stopReason: str(raw.stopReason),
    inputTokens: isObj(usage) ? num(usage.input_tokens) : null,
    outputTokens: isObj(usage) ? num(usage.output_tokens) : null,
    text: content
      .map((b) => (isObj(b) && b.type === 'text' ? str(b.text) : null))
      .filter((t): t is string => t !== null),
    toolNames: content
      .map((b) => (isObj(b) && b.type === 'tool_use' ? str(b.name) : null))
      .filter((t): t is string => t !== null),
  };
}

/** `trace_turn.response` is a raw Anthropic `BetaMessage` string; `null` here means "unparseable", never "empty". */
function tryParse(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}
