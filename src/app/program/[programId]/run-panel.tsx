import { startRun } from './run-actions';
import { RUN_BUDGET_USD_PER_SUPPLIER } from '@/config/constants';

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
 */
export function RunPanel({
  programId,
  unresolved,
  workerUp,
}: {
  programId: string;
  unresolved: number;
  workerUp: boolean;
}) {
  if (unresolved === 0) {
    return (
      <section className="card" aria-label="Run">
        <h3>Run</h3>
        <p className="note">
          Every supplier on this roster has a settled match. Re-running one is a decision about a
          particular company, so it lives on that company&rsquo;s page rather than here.
        </p>
      </section>
    );
  }

  const options = [10, 25, unresolved].filter((n, i, all) => n <= unresolved && all.indexOf(n) === i);

  return (
    <section className="card" aria-label="Run">
      <h3>Run</h3>
      <p className="note">
        {unresolved} supplier{unresolved === 1 ? '' : 's'} have no settled match yet. A run resolves
        them in roster order and enriches the ones it settles — a row that parks for review does not
        get enriched, because there is nothing yet to enrich.
      </p>

      <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginTop: '0.7rem' }}>
        {options.map((n) => (
          <form key={n} action={startRun}>
            <input type="hidden" name="programId" value={programId} />
            <input type="hidden" name="count" value={n} />
            <button type="submit" className="badge" style={{ cursor: 'pointer', padding: '0.45rem 0.8rem' }}>
              Run {n === unresolved ? `all ${n}` : n} · ~${(RUN_BUDGET_USD_PER_SUPPLIER * n).toFixed(2)}
            </button>
          </form>
        ))}
      </div>

      <p className="note" style={{ marginTop: '0.6rem' }}>
        The estimate is {`$${RUN_BUDGET_USD_PER_SUPPLIER.toFixed(2)}`} per supplier from a committed
        constant, not a bill. What it actually cost is on the Runs page when it finishes.
      </p>

      {!workerUp ? (
        <p className="note warn" style={{ marginTop: '0.6rem' }}>
          <strong>No worker has picked anything up recently.</strong> Jobs will queue and wait rather
          than run. Start one with <code>pnpm worker</code>.
        </p>
      ) : null}
    </section>
  );
}
