import { reassessSupplier, reenrichSupplier } from '../../run-actions';

/**
 * What a person can set going from a Supplier page (SPEC §5.1).
 *
 * Each opens **its own Run**, subject-labelled, because every on-demand act that
 * spends starts one of its own — charging a decision made now to a run somebody
 * has already read would move a total they have already seen.
 *
 * The two are offered separately because they answer different questions.
 * Re-enriching asks *has the evidence changed?*; re-assessing asks *does the
 * argument still hold?* — and the second is worth doing on unchanged evidence
 * after a weight change, which is why it is not a single "refresh" button.
 */
export function SupplierActions({
  programId,
  supplierId,
  hasMatch,
  hasScore,
}: {
  programId: string;
  supplierId: string;
  hasMatch: boolean;
  hasScore: boolean;
}) {
  if (!hasMatch) {
    return (
      <section className="card" aria-label="Actions">
        <h3>Actions</h3>
        <p className="note">
          Nothing can be run for this supplier until its match is settled — enrichment and
          assessment both describe a company, and we have not identified one. Settle it under{' '}
          <a href={`/program/${programId}/needs-review`}>needs review</a>.
        </p>
      </section>
    );
  }

  return (
    <section className="card" aria-label="Actions">
      <h3>Actions</h3>
      <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
        <form action={reenrichSupplier}>
          <input type="hidden" name="programId" value={programId} />
          <input type="hidden" name="supplierId" value={supplierId} />
          <button
            type="submit"
            className="badge"
            style={{ cursor: 'pointer', padding: '0.45rem 0.8rem' }}
          >
            Re-enrich
          </button>
        </form>

        <form action={reassessSupplier}>
          <input type="hidden" name="programId" value={programId} />
          <input type="hidden" name="supplierId" value={supplierId} />
          <button
            type="submit"
            className="badge"
            style={{ cursor: 'pointer', padding: '0.45rem 0.8rem' }}
            disabled={!hasScore}
          >
            Re-assess
          </button>
        </form>
      </div>

      <p className="note" style={{ marginTop: '0.6rem' }}>
        {hasScore
          ? 'Re-enrich re-fetches the six sources and re-scores. Re-assess re-argues the case from what is stored — worth doing on unchanged evidence after a weight change. Each starts its own run.'
          : 'Re-assess needs a score. Re-enrich first: an assessment argues from criterion values, and there are none yet.'}
      </p>
    </section>
  );
}
