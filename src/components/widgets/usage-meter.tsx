import { RawPayload } from './raw';
import { WhereGrid } from './figures';
import { isObj, num, str } from './narrow';

/**
 * `usage_meter` — mirrors the Runs page's *Your Sayari account* block
 * (`src/app/program/[programId]/runs/sections.tsx`, `TheWorking`).
 *
 * **The two usage numbers are not the same kind of thing** (`get_usage`'s own
 * comment, `src/tools/catalog/reads.ts`): this Program's Run count is scoped
 * and current, Sayari's own counters are account-wide and lag, and neither is
 * netted against the other. The labels ride in the payload on purpose, so a
 * caveat asked for in chat cannot silently differ from the one the page
 * renders — this widget draws the strings it is handed rather than its own.
 * No dollar figure is drawn for Sayari, because none is computed: `dollars` is
 * frozen `null` and `dollarsNote` says why.
 */
export function UsageMeterWidget({ payload }: { payload: unknown }) {
  const u = parse(payload);
  // Falls back rather than throws: a widget frozen onto a message outlives
  // the shape `parse()` expects (finding 103).
  if (!u) return <RawPayload payload={payload} />;
  return (
    <div>
      <WhereGrid items={[{ value: u.ours.runs, label: `runs · ${u.ours.scope}` }]} />
      <div className="card" style={{ marginTop: '0.5rem' }}>
        <p style={{ margin: 0, fontWeight: 600 }}>{u.sayari.scope}</p>
        <p className="note" style={{ margin: '0.3rem 0 0' }}>
          {u.sayari.note}
        </p>
        <p className="note" style={{ margin: '0.3rem 0 0' }}>
          {u.sayari.dollars != null ? `$${u.sayari.dollars}` : 'no dollar figure'} —{' '}
          {u.sayari.dollarsNote}
        </p>
      </div>
      {u.claudeNote ? (
        <p className="note" style={{ marginTop: '0.5rem' }}>
          {u.claudeNote}
        </p>
      ) : null}
    </div>
  );
}

function parse(payload: unknown) {
  if (!isObj(payload) || !isObj(payload.ours) || !isObj(payload.sayari)) return null;
  const ours = payload.ours;
  const sayari = payload.sayari;
  const runs = num(ours.runs);
  const oursScope = str(ours.scope);
  const sayariScope = str(sayari.scope);
  const note = str(sayari.note);
  const dollarsNote = str(sayari.dollarsNote);
  if (runs == null || !oursScope || !sayariScope || !note || !dollarsNote) return null;
  return {
    ours: { scope: oursScope, runs },
    sayari: { scope: sayariScope, note, dollars: num(sayari.dollars), dollarsNote },
    claudeNote: str(payload.claudeNote),
  };
}
