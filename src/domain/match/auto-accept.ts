import {
  DISCRIMINATOR_NAMES,
  type CandidateFacts,
  type DiscriminatorResult,
} from './discriminators';

/**
 * The auto-accept gate (SPEC §6.3).
 *
 * Plain code may settle a Match only when **exactly one Candidate passes all
 * eight Discriminators** *and* a **GLEIF exact-LEI join independently agrees*.
 *
 * **No ratio margin over the runner-up.** Sayari's `score` is not comparable
 * between queries, and `matchStrength` is uniform across every candidate within
 * one query — it grades the query, not the candidates. Any threshold over
 * either would be a number we invented.
 *
 * **Accepted consequence, stated rather than discovered:** a company with **no
 * LEI can never be auto-accepted**. That is the safe direction of failure. On a
 * roster of trade names few rows clear this bar, and **that count is a result
 * to report**, not a defect to fix.
 *
 * ## And no rival that is placed at the roster address and failed nothing
 *
 * *Exactly one candidate passed all eight* is a weaker statement than it looks,
 * because `unavailable` is not a `fail`. A rival whose eight verdicts are all
 * pass or `can't tell` has not been ruled out by anything — it has been ruled
 * out by a missing status field, or an unread script, or an LEI it does not
 * carry. Measured on the roster: `SAMVARDHANA MOTHERSON ADSYS TECH LIMITED`
 * was the only all-eight pass for the Samvardhana Motherson row, and
 * `Samvardhana Motherson International Ltd.` — at the roster's own Noida
 * address — lost it on one `unavailable` liveness verdict. The gate settled
 * silently on the smaller company.
 *
 * **A rival is a Candidate with zero `fail` verdicts *and* something placing it
 * at the roster address** — at least one of `country`, `locality`, `street` or
 * `lei_witness` returning `pass`. Both halves are needed, and the second half is
 * the Identity Standard rather than a convenience: the right answer is *the
 * legal entity registered at the roster address*, so a record that says nothing
 * about where it is has not made a competing claim to be that entity. It is a
 * record with no evidence, not a candidate with contrary evidence.
 *
 * Both halves are measured on the roster, on rows that disagree about them:
 *
 * - `Samvardhana Motherson International Ltd.` passes `country`, `locality`
 *   **and** `street` against the roster's own Noida address and fails nothing.
 *   It is a rival, and the gate refuses.
 * - Sayari's second Bosch record is labelled `ROBERT BOSCH` and carries no
 *   country, no city, no postcode, no LEI and no status. Four of its eight
 *   verdicts are `pass` — name cover, alias context, business purpose, and a
 *   street rung reading the brand tokens out of `Robert-Bosch-Platz` — and the
 *   other four are `can't tell`. Nothing places it anywhere. Counting it as a
 *   rival cost `ROBERT BOSCH GMBH` a zero-token settlement it had earned on
 *   evidence, in favour of a record that had produced none.
 *
 * The refusal names which of the four placed the rival, so a reader can see the
 * claim rather than take the refusal on trust.
 */

export type AutoAcceptOutcome =
  | { accepted: true; entityId: string; reason: string }
  | { accepted: false; reason: string };

export type CandidateAssessment = {
  candidate: CandidateFacts;
  verdicts: DiscriminatorResult[];
};

/**
 * The four Discriminators that can put a Candidate **at the roster address**.
 *
 * Three are the address ladder itself; the fourth is GLEIF corroborating the
 * roster's own jurisdiction and city, which is a claim about where the company
 * is registered rather than about what it is called. `name_cover`,
 * `alias_context`, `business_purpose` and `liveness` are all true of a company
 * in the wrong country, so none of them can place one.
 */
const PLACING_DISCRIMINATORS = ['country', 'locality', 'street', 'lei_witness'] as const;

/** Which of the four placed this Candidate, empty when nothing did. */
function placedBy(verdicts: readonly DiscriminatorResult[]): string[] {
  return PLACING_DISCRIMINATORS.filter((name) =>
    verdicts.some((v) => v.discriminator === name && v.verdict === 'pass'),
  );
}

/** True only when every one of the eight returned `pass` — `unavailable` is not a pass. */
export function passesAllEight(verdicts: readonly DiscriminatorResult[]): boolean {
  if (verdicts.length !== DISCRIMINATOR_NAMES.length) return false;
  const byName = new Map(verdicts.map((v) => [v.discriminator, v.verdict]));
  return DISCRIMINATOR_NAMES.every((name) => byName.get(name) === 'pass');
}

export function evaluateAutoAccept(assessments: readonly CandidateAssessment[]): AutoAcceptOutcome {
  const clean = assessments.filter((a) => passesAllEight(a.verdicts));

  if (clean.length === 0) {
    // A no-LEI company fails `lei_witness` with `unavailable`, so it never
    // reaches the second-witness check below — but "no candidate passed all
    // eight" would be a true and useless thing to tell a person reading the
    // Needs Review page. Where the LEI is the ONLY thing missing, say so: it is
    // the difference between "we could not tell" and "we could tell, and this
    // is the one bar it cannot clear".
    const onlyMissingLei = assessments.find(
      (a) =>
        !a.candidate.lei &&
        a.verdicts.every((v) => v.verdict === 'pass' || v.discriminator === 'lei_witness'),
    );
    if (onlyMissingLei) {
      return {
        accepted: false,
        reason: `${onlyMissingLei.candidate.label} passed every discriminator that could be checked, but carries no LEI, so there is no second witness. A company with no LEI can never be auto-accepted — that is the safe direction of failure, and how often it happens is a result to report.`,
      };
    }
    return {
      accepted: false,
      reason: `No candidate passed all eight discriminators${assessments.length > 0 ? ` (${assessments.length} examined)` : ''}. The agents decide.`,
    };
  }
  if (clean.length > 1) {
    // Two clean candidates is not a tie to break; it is a question code cannot
    // answer, because there is no comparable score to break it with.
    return {
      accepted: false,
      reason: `${clean.length} candidates passed all eight discriminators. There is no comparable score to choose between them, so the agents decide.`,
    };
  }

  const only = clean[0]!;

  /**
   * Every other candidate that is **placed at the roster address** has to have
   * been ruled out, not merely out-scored. Such a rival is one the code could
   * not tell apart from the winner, and settling between them is exactly the
   * judgement the agents exist to make.
   */
  const rivals = assessments
    .filter((a) => a !== only)
    .map((a) => ({ assessment: a, placedBy: placedBy(a.verdicts) }))
    .filter(
      (r) =>
        r.assessment.verdicts.length === DISCRIMINATOR_NAMES.length &&
        r.assessment.verdicts.every((v) => v.verdict !== 'fail') &&
        r.placedBy.length > 0,
    );
  if (rivals.length > 0) {
    const named = rivals
      .map((r) => `${r.assessment.candidate.label} (${r.placedBy.join(', ')})`)
      .join('; ');
    const them = rivals.length === 1 ? 'it' : 'them';
    return {
      accepted: false,
      reason: `${only.candidate.label} passed all eight discriminators, but ${named} failed none of them either, and the checks in brackets place ${them} at the roster address too. Every other verdict against ${them} is a pass or a "can't tell", so nothing here rules ${them} out. The agents decide.`,
    };
  }

  // The second witness. `lei_witness` passing already implies GLEIF agreed, but
  // the gate states the requirement independently rather than inferring it —
  // the whole point is that two mechanisms have to agree.
  if (!only.candidate.lei) {
    return {
      accepted: false,
      reason: `${only.candidate.label} passed all eight discriminators but carries no LEI, so there is no second witness. A company with no LEI can never be auto-accepted — that is the safe direction of failure.`,
    };
  }
  if (!only.candidate.gleif) {
    return {
      accepted: false,
      reason: `${only.candidate.label} passed all eight but the GLEIF exact-LEI join returned nothing for ${only.candidate.lei}.`,
    };
  }

  return {
    accepted: true,
    entityId: only.candidate.entityId,
    reason: `${only.candidate.label} is the only candidate passing all eight discriminators, and GLEIF independently confirms LEI ${only.candidate.lei} as "${only.candidate.gleif.legalName}".`,
  };
}
