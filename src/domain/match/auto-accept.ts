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
 */

export type AutoAcceptOutcome =
  | { accepted: true; entityId: string; reason: string }
  | { accepted: false; reason: string };

export type CandidateAssessment = {
  candidate: CandidateFacts;
  verdicts: DiscriminatorResult[];
};

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
