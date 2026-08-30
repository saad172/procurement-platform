import { seedId } from './seed-data/ids';

/**
 * Deterministic ids for the derived rows a Citation can point at.
 *
 * ## Why this is not the seed's problem again
 *
 * Finding 40 made the **authored** rows deterministic, so two databases seeded
 * from the same file agree on the ids everything else points at. That fixed the
 * *request* side of a replay: the prompt names a Programme and a Supplier, and
 * both now have the same id everywhere.
 *
 * The **response** side stayed broken, and it took an assess replay to show it.
 * A recorded draft cites the rows it was written from — `matchId`,
 * `criterionValueId` — as literal ids, and our own validator resolves every one
 * against the database before publishing. In a replay those rows have been
 * created afresh with new random ids, so the recorded draft cites rows that do
 * not exist, `checkCitationsResolve` objects, and three Rounds later the Job
 * ends `rejected_by_code` having done nothing wrong.
 *
 * The draft cannot be rewritten — a fixture that is edited to fit is no longer
 * a record of anything. So the rows have to land with the same ids instead.
 *
 * ## The natural key, plus a generation
 *
 * These tables are **append-only**: a re-scored Criterion writes a new row and
 * marks the old one superseded, and a re-fetched Enrichment writes a new row
 * for the same subject. So the natural key alone would collide on the second
 * write.
 *
 * `generation` is the number of rows that already exist for that key, so the
 * first is `…:0`, its replacement `…:1`, and a replay that performs the same
 * sequence of writes lands on the same ids. It is derived from a count rather
 * than from a timestamp precisely so that two runs an hour apart agree.
 *
 * ## What this does not promise
 *
 * A run that writes a *different number* of rows produces different ids from
 * that point on — correctly, because it is a different history. Determinism
 * here means *the same run twice*, not *any run ever*.
 */
export function derivedId(kind: string, naturalKey: string, generation: number): string {
  return seedId(`derived:${kind}`, `${naturalKey}#${generation}`);
}
