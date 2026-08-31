import { runDiscover, runRecommendation } from '../../run-actions';

/**
 * What a person can set going from a Category page (SPEC §5.1, §11.3).
 *
 * **Recommend always writes a new version**, and the diff may be empty — *"the
 * weights changed and the argument did not"* is itself a result, which is why
 * the button does not try to decide whether re-running is worthwhile.
 *
 * **Discover proposes and never adds.** It reads trade counterparties and
 * classifies them; a person promotes a Lead into a Supplier, and the app has no
 * path that does it unasked.
 */
export function CategoryActions({
  programId,
  categoryId,
  shortlistSize,
  inline = false,
}: {
  programId: string;
  categoryId: string;
  shortlistSize: number;
  /**
   * Rendered inside an `.answer` rather than as its own card.
   *
   * The answer at the top of the page names writing a recommendation as the
   * thing to do, and the button that does it costs money and owns its own
   * disabled state. Rather than the answer growing a second copy of it, the
   * real control moves up into the answer and the card below keeps the rest.
   */
  inline?: boolean;
}) {
  if (inline) {
    return (
      <form action={runRecommendation}>
        <input type="hidden" name="programId" value={programId} />
        <input type="hidden" name="categoryId" value={categoryId} />
        <button type="submit" className="btn primary" disabled={shortlistSize === 0}>
          Write one
        </button>
        {shortlistSize === 0 ? (
          <span className="note" style={{ marginLeft: '0.5rem' }}>
            Nothing here has a score to argue from yet.
          </span>
        ) : null}
      </form>
    );
  }

  return (
    <section className="card" aria-label="Actions">
      <h3>Actions</h3>
      <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
        <form action={runRecommendation}>
          <input type="hidden" name="programId" value={programId} />
          <input type="hidden" name="categoryId" value={categoryId} />
          <button
            type="submit"
            className="badge"
            style={{ cursor: 'pointer', padding: '0.45rem 0.8rem' }}
            disabled={shortlistSize === 0}
          >
            Recommend
          </button>
        </form>

        <form action={runDiscover}>
          <input type="hidden" name="programId" value={programId} />
          <input type="hidden" name="categoryId" value={categoryId} />
          <button type="submit" className="badge" style={{ cursor: 'pointer', padding: '0.45rem 0.8rem' }}>
            Discover leads
          </button>
        </form>
      </div>

      <p className="note" style={{ marginTop: '0.6rem' }}>
        {shortlistSize === 0
          ? 'A recommendation needs a shortlist, and nothing here has a score yet. Discover finds candidates from trade data — it proposes, and a person promotes.'
          : 'Recommend always writes a new version, and the diff may be empty: "the weights changed and the argument did not" is itself a result. Discover proposes leads from trade data and never adds one.'}
      </p>
    </section>
  );
}
