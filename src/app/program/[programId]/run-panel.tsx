import { startRun, enrichRoster, assessRoster } from './run-actions';
import { RUN_BUDGET_USD_PER_SUPPLIER } from '@/config/constants';
import type { RosterWork } from '@/db/queries/runs';

/**
 * The Run affordance (SPEC §4.3).
 *
 * *"The reviewer's first action is Run, not an import."* The count defaults to
 * **10 of 50** with the full roster one click away — ten is not timidity, it is
 * that a reviewer who wants to see the shape of the thing should not have to
 * spend the whole budget first.
 *
 * **The cost is stated before the click, from the committed constant**, and it
 * says so — the same discipline the app applies to every other figure it shows.
 * A button that spends real money without naming the amount is the one control
 * in this app that could not be defended.
 *
 * **It follows the roster through all three stages.** The pipeline is resolve →
 * enrich → assess, and only the first hop is chained by the worker; nothing
 * queues an assessment at all. A panel that went quiet once every Match was
 * settled left the reviewer on a Programme reading *0 of 50 assessed* with no
 * control that would change it, which is the state this replaced.
 */
export function RunPanel({
  programId,
  work,
  workerUp,
}: {
  programId: string;
  work: RosterWork;
  workerUp: boolean;
}) {
  /**
   * **Every stage with work, not just the earliest one.**
   *
   * Showing one stage at a time reads well until a single Supplier gets stuck.
   * One row failing its enrichment hid the Assess control from the forty-seven
   * behind it that were ready — the roster's next phase gated on its worst row,
   * which is the opposite of what the queue does. Each stage is independent
   * work on a different set of Suppliers, so each gets its own control.
   */
  const stages = {
    resolve: work.unresolved,
    enrich: work.unenriched,
    assess: work.unassessed,
  };
  const idle = Object.values(stages).every((n) => n === 0);

  return (
    <section className="card" aria-label="Run">
      <h3>Run</h3>

      {idle ? (
        <p className="note">
          Every supplier on this roster is resolved, enriched and assessed. Re-running one is a
          decision about a particular company, so it lives on that company&rsquo;s page rather than
          here.
        </p>
      ) : null}

      {stages.resolve > 0 ? (
        <Stage
          programId={programId}
          action={startRun}
          remaining={work.unresolved}
          verb="Run"
          lede={
            <>
              {work.unresolved} supplier{work.unresolved === 1 ? ' has' : 's have'} no settled match yet.
              A run takes them in roster order through all three phases — <strong>resolve</strong>,
              then <strong>enrich</strong>, then <strong>assess</strong> — each queued as the one
              before it succeeds, because every phase reads what the last one wrote. A row that parks
              for review stops there, which is the point of parking it.
            </>
          }
          costNote={
            <>
              The estimate is {`$${RUN_BUDGET_USD_PER_SUPPLIER.toFixed(2)}`} per supplier from a
              committed constant, not a bill. What it actually cost is on the Runs page when it
              finishes.
            </>
          }
          priced
        />
      ) : null}

      {stages.enrich > 0 ? (
        <Stage
          programId={programId}
          action={enrichRoster}
          remaining={work.unenriched}
          verb="Enrich"
          lede={
            <>
              {work.unenriched} supplier{work.unenriched === 1 ? ' has' : 's have'} a settled match but
              no criterion values, so nothing about them can be scored or argued from yet. This picks
              the pipeline up where it stopped and carries it to the end —{' '}
              <strong>enrich</strong>, then <strong>assess</strong>.
            </>
          }
          costNote={
            <>
              Enrichment itself runs no model; the assessment it chains into does. The estimate is{' '}
              {`$${RUN_BUDGET_USD_PER_SUPPLIER.toFixed(2)}`} per supplier from the committed
              constant — a ceiling for all three phases, so two of them will come in under it.
            </>
          }
          priced
        />
      ) : null}

      {stages.assess > 0 ? (
        <Stage
          programId={programId}
          action={assessRoster}
          remaining={work.unassessed}
          verb="Assess"
          lede={
            <>
              {work.unassessed} supplier{work.unassessed === 1 ? ' has' : 's have'} criterion values but
              no assessment. Nothing queues an assessment on your behalf — not the worker, not a
              run — so this is the only control that moves the <em>assessed</em> figure on the strip
              above for more than one company at a time.
            </>
          }
          costNote={
            <>
              An assessment is the one stage here that argues, so it is the one that spends model
              tokens. The estimate is {`$${RUN_BUDGET_USD_PER_SUPPLIER.toFixed(2)}`} per supplier
              from the committed constant — a ceiling for the whole pipeline, so this will come in
              under it.
            </>
          }
          priced
        />
      ) : null}

      {!workerUp && !idle ? (
        <p className="note warn" style={{ marginTop: '0.6rem' }}>
          <strong>No worker has picked anything up recently.</strong> Jobs will queue and wait rather
          than run. Start one with <code>pnpm worker</code>.
        </p>
      ) : null}
    </section>
  );
}

/**
 * One stage's buttons: 10, 25, all — the same three everywhere, because a
 * reviewer learning the control once should not have to relearn it per stage.
 */
function Stage({
  programId,
  action,
  remaining,
  verb,
  lede,
  costNote,
  priced = false,
}: {
  programId: string;
  action: (formData: FormData) => Promise<void>;
  remaining: number;
  verb: string;
  lede: React.ReactNode;
  costNote: React.ReactNode;
  /** Whether this stage runs a model, and so whether a dollar figure is a forecast. */
  priced?: boolean;
}) {
  const options = [10, 25, remaining].filter((n, i, all) => n <= remaining && all.indexOf(n) === i);

  return (
    <div style={{ borderTop: '1px solid var(--rule-2)', paddingTop: '0.7rem', marginTop: '0.7rem' }}>
      <p className="note" style={{ marginTop: 0 }}>{lede}</p>

      <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginTop: '0.7rem' }}>
        {options.map((n) => (
          <form key={n} action={action}>
            <input type="hidden" name="programId" value={programId} />
            <input type="hidden" name="count" value={n} />
            <button type="submit" className="badge" style={{ cursor: 'pointer', padding: '0.45rem 0.8rem' }}>
              {verb} {n === remaining ? `all ${n}` : n}
              {priced ? ` · ~$${(RUN_BUDGET_USD_PER_SUPPLIER * n).toFixed(2)}` : ''}
            </button>
          </form>
        ))}
      </div>

      <p className="note" style={{ margin: '0.6rem 0 0' }}>{costNote}</p>
    </div>
  );
}
