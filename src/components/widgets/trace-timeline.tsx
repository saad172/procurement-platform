import { RawPayload } from './raw';
import { arr, isObj, num, str } from './parts-card';

/**
 * `trace_timeline` — mirrors the Job page's turn list
 * (`src/app/program/[programId]/runs/[runId]/job/[jobId]/page.tsx`), one card
 * per turn: n, role, stop reason and the tools it called. **No link**: the
 * payload is `trace_turn` rows keyed by `jobId` alone, and the page needs a
 * `programId` and `runId` ahead of that id.
 *
 * `trace_turn.response` is stored **as text** — the whole `BetaMessage`
 * verbatim (SPEC §3.7) — so it is parsed here rather than read as an object;
 * a turn whose JSON does not parse still renders its `n` and stop reason.
 */
export function TraceTimelineWidget({ payload }: { payload: unknown }) {
  const turns = arr(payload)
    .map(parseTurn)
    .filter((t): t is NonNullable<typeof t> => t !== null);
  if (turns.length === 0) return <RawPayload payload={payload} />;
  return (
    <div>
      {turns.map((turn) => (
        <TurnCard key={turn.id} turn={turn} />
      ))}
    </div>
  );
}

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

function tryParse(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}
