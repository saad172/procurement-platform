import type { AnswerTone } from './supplier-answer';

/**
 * What a Programme page says before anything else.
 *
 * The page opened with a two-figure strip, a run panel and four charts under
 * the heading *"Where this roster is, and whether resolution worked"* — which
 * names a **pipeline stage**, not a question anybody arrives with. A person
 * opening this page wants to know whether anything is blocking them, whether
 * anything is waiting on them, and how far from a decision the programme is.
 *
 * Those are three different things and up to two of them can be urgent at once,
 * so this returns a list. The order is the order they block on:
 *
 * 1. **Nothing is listening** — every button will accept a click and queue work
 *    behind a machine that is not running. Nothing else on the page can change
 *    until that does, and it is not something the page can fix.
 * 2. **Something is waiting on a person** — the software has already tried and
 *    declined to guess, so this will not resolve itself.
 * 3. **Where the programme actually is** — said honestly, including when the
 *    honest answer is "at the beginning".
 */

export type ProgrammeAnswer = {
  tone: AnswerTone;
  said: string;
  because: string;
  actions: { label: string; href?: string; primary?: boolean }[];
};

export type ProgrammeAnswerInput = {
  /** Whether a worker has picked anything up recently. Liveness, not health. */
  workerUp: boolean;
  /** A Run still moving, if there is one. */
  running: { jobsInFlight: number; queued: number; href: string; label: string } | undefined;
  suppliers: { total: number; identified: number; assessed: number; uncategorised: number };
  /** Roster rows the resolver handed back for a person to settle. */
  waitingOnYou: { count: number; names: string[] };
  categories: { total: number; withRecommendation: number };
  needsReviewHref: string;
  runsHref: string;
};

/** How many names a sentence lists before it starts being a list. */
const NAMED = 3;

export function programmeAnswer(input: ProgrammeAnswerInput): ProgrammeAnswer[] {
  const answers: ProgrammeAnswer[] = [];

  if (!input.workerUp) {
    answers.push({
      tone: 'stop',
      said: 'Nothing is running, so nothing is moving.',
      because:
        'No background worker has picked up work recently. Every button on this page will accept a click and then queue the work behind a machine that is not listening, so the figures below cannot change until it is started. This is not something the page can fix — the worker holds no inbound port by design, and recent activity is the only signal available from here.',
      actions: [{ label: 'See what is queued', href: input.runsHref }],
    });
  } else if (input.running) {
    answers.push({
      tone: 'neutral',
      said: `${input.running.label} is running.`,
      because: `${count(input.running.jobsInFlight, 'job')} in flight and ${input.running.queued} queued. The figures below update as matches land, and the job-by-job view is on the run page.`,
      actions: [{ label: 'Watch it', href: input.running.href }],
    });
  }

  if (input.waitingOnYou.count > 0) {
    const { count: n, names } = input.waitingOnYou;
    const named = names.slice(0, NAMED);
    answers.push({
      tone: 'you',
      said: `${n === 1 ? 'One supplier is' : `${n} suppliers are`} waiting on a decision only you can make.`,
      because: `For ${list(named)}${names.length > named.length ? ` and ${names.length - named.length} more` : ''} we found several companies with the same name and could not tell which one the roster row means. Nobody else will resolve these — two independent reads disagreed, which is the software declining to guess rather than failing.`,
      actions: [
        { label: n === 1 ? 'Decide it' : `Decide these ${n}`, href: input.needsReviewHref, primary: true },
      ],
    });
  }

  if (answers.length === 0) answers.push(progress(input));
  return answers;
}

/**
 * Where the programme actually is.
 *
 * **A category can be awarded once its bidders have been researched and a
 * recommendation written for it**, so that is the figure this leads with — not
 * the count of suppliers, which moves early and steadily and reads like
 * progress towards a decision it is not progress towards.
 */
function progress(input: ProgrammeAnswerInput): ProgrammeAnswer {
  const { categories, suppliers } = input;

  if (categories.withRecommendation === 0) {
    return {
      tone: 'neutral',
      said: `No category can be awarded yet, and ${suppliers.assessed === 0 ? 'nothing has been written up' : `${suppliers.assessed} of ${suppliers.total} suppliers have been`}.`,
      because: `A category becomes awardable once its bidders have been researched and a recommendation written for it, and none has been written for any of the ${categories.total}. At ${suppliers.assessed} ${suppliers.assessed === 1 ? 'supplier' : 'suppliers'} written up out of ${suppliers.total}, the honest read is that this programme is at the beginning rather than near a decision.`,
      actions: [],
    };
  }

  if (categories.withRecommendation < categories.total) {
    return {
      tone: 'neutral',
      said: `${categories.withRecommendation} of ${categories.total} categories have an argued case behind them.`,
      because: `The rest have a ranking and nothing arguing from it, and a ranking is not a decision. ${suppliers.assessed} of ${suppliers.total} suppliers have been written up.`,
      actions: [],
    };
  }

  return {
    tone: 'ok',
    said: 'Every category has a recommendation behind it.',
    because: `All ${categories.total} carry an argued case against their unfiltered shortlist, and ${suppliers.assessed} of ${suppliers.total} suppliers have been written up. What remains is reading them.`,
    actions: [],
  };
}

const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;

const list = (parts: string[]): string =>
  parts.length <= 1
    ? (parts[0] ?? 'them')
    : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
