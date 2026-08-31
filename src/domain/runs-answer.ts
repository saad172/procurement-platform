import type { AnswerTone } from './supplier-answer';

/**
 * What the Runs page says before its table.
 *
 * The page was headed **"Runs"** and opened with two efficiency cards and a
 * ledger — accurate, and answering a question nobody asked. *Why do only three
 * of fifty suppliers have a write-up?* is answerable from this page's data and
 * was nowhere on it: the reason is one cancelled batch, its 43 unstarted jobs
 * sitting in a `cancelled` column four scrolls down.
 *
 * Two things are worth saying before the ledger, and they are different kinds
 * of news:
 *
 * 1. **Work that was started and never finished**, because that is usually the
 *    whole explanation for why the programme looks emptier than it should.
 * 2. **Work our own validator refused to publish** — which is the system
 *    working, and reads as failure unless the page says otherwise. Nobody was
 *    told at the time and the reason is three clicks down.
 */

export type RunsAnswer = {
  tone: AnswerTone;
  said: string;
  because: string;
  actions: { label: string; href?: string; primary?: boolean }[];
};

export type RunsAnswerInput = {
  runs: {
    id: string;
    label: string;
    state: 'queued' | 'running' | 'done' | 'failed' | 'paused_on_budget' | 'cancelled';
    jobs: { total: number; done: number; failed: number; neverStarted: number };
    actualUsd: number;
  }[];
  /**
   * Jobs whose failure was **our own checks refusing to publish**, rather than
   * anything upstream going wrong.
   */
  refusedByOurChecks: { subjectLabel: string; runId: string }[];
  totalUsd: number;
  runHref: (runId: string) => string;
};

/** How many names a sentence lists before it starts being a list. */
const NAMED = 3;

export function runsAnswer(input: RunsAnswerInput): RunsAnswer[] {
  const answers: RunsAnswer[] = [];

  /**
   * The largest piece of work that was stopped part way.
   *
   * Largest by what was left undone rather than by what it cost, because the
   * question this answers is *why is the programme emptier than it should be*
   * and the answer is the count of things that never ran.
   */
  const abandoned = input.runs
    .filter((run) => run.jobs.neverStarted > 0)
    .sort((a, b) => b.jobs.neverStarted - a.jobs.neverStarted)[0];

  if (abandoned) {
    const { jobs } = abandoned;
    answers.push({
      tone: 'stop',
      said: `${capitalise(abandoned.label)} was stopped part way. ${jobs.neverStarted} of ${jobs.total} never started.`,
      because: `${jobs.done === 0 ? 'None finished' : `${jobs.done} finished`}${jobs.failed > 0 ? `, ${jobs.failed} ${jobs.failed === 1 ? 'was' : 'were'} refused` : ''}, and the remaining ${jobs.neverStarted} never began before it was ${abandoned.state === 'cancelled' ? 'cancelled' : 'stopped'} — after $${abandoned.actualUsd.toFixed(2)} had been spent. That is usually the whole reason a programme looks emptier than the work put into it suggests.`,
      actions: [{ label: 'See what it got through', href: input.runHref(abandoned.id) }],
    });
  }

  if (input.refusedByOurChecks.length > 0) {
    const names = input.refusedByOurChecks.map((row) => row.subjectLabel);
    const named = names.slice(0, NAMED);
    const n = names.length;
    answers.push({
      tone: 'you',
      said: `${n === 1 ? 'One write-up was' : `${n} write-ups were`} refused by our own checks — and that is the system working.`,
      because: `Before an analysis is published, every number in it is checked against a stored fact. For ${list(named)}${names.length > named.length ? ` and ${names.length - named.length} more` : ''} the check could not find the figure the analysis quoted, so it refused to publish rather than let an unverifiable number through. Nothing was lost except the attempt — but nobody was told at the time, and the reason sits three clicks down.`,
      actions: [
        {
          label: 'See what it objected to',
          href: input.runHref(input.refusedByOurChecks[0]!.runId),
          primary: true,
        },
      ],
    });
  }

  if (answers.length === 0) {
    answers.push(
      input.runs.length === 0
        ? {
            tone: 'neutral',
            said: 'Nothing has been run for this programme yet.',
            because:
              'Every figure in this application comes from work somebody started, and none has been. A run is the unit of that work, and this is where every one of them and what it cost is recorded.',
            actions: [],
          }
        : {
            tone: 'ok',
            said: `Everything that was started has finished, at $${input.totalUsd.toFixed(2)}.`,
            because: `${input.runs.length} ${input.runs.length === 1 ? 'run has' : 'runs have'} completed with nothing abandoned part way and nothing refused by the checks. The ledger below is every one of them, newest first, with no filter — not filtering means there is no denominator to disclose.`,
            actions: [],
          },
    );
  }

  return answers;
}

const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

const list = (parts: string[]): string =>
  parts.length <= 1
    ? (parts[0] ?? 'them')
    : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
