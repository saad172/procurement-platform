// Next.js loads `.env` itself; a plain Node entrypoint has to ask.
import 'dotenv/config';
import { eq } from 'drizzle-orm';
import { closeDirectDb, getDirectDb } from '@/db/client';
import * as t from '@/db/schema';
import { PROGRAM } from '@/db/seed-data/program';
import { EXPECTED_BY_INDEX, type ExpectedMatch } from '@/db/seed-data/expected-matches';

/**
 * Grades the Match loop against the truth set (`src/db/seed-data/expected-matches.ts`).
 *
 *     pnpm check:matches
 *
 * ## The five outcomes, and why they are five rather than two
 *
 * *Right* and *wrong* is the wrong shape for a loop whose stated design allows
 * it to refuse. A Match that parks because the right company is not in the
 * graph is the system working; a Match that parks while the right company sits
 * on its own Candidate list is a different failure from one that accepted the
 * wrong company, and a different one again from one that never saw anything.
 *
 * | Outcome | What happened |
 * |---|---|
 * | accepted right | accepted, and it is the expected entity |
 * | accepted wrong | accepted, and it is not — the expensive kind |
 * | parked correctly | parked, and parking is what the truth set expects |
 * | parked with the answer in hand | parked, and the expected entity **is** among the Candidates it recorded |
 * | not found wrongly | `not_found`, but the expected entity exists in the graph |
 *
 * ## Only confirmed rows are counted
 *
 * The truth set is drafted, unconfirmed, and says so on every row. A scoreboard
 * that graded itself against its own guesses would report a number nobody
 * checked, so the headline counts `confirmed: true` rows only and the rest are
 * listed underneath as what they are: work waiting for a person.
 */

type Row = {
  rosterIndex: number;
  rosterName: string;
  status: string;
  settledBy: string;
  entityId: string | null;
  label: string | null;
  candidateIds: string[];
};

type Outcome =
  | 'accepted right'
  | 'accepted wrong'
  | 'parked correctly'
  | 'parked with the answer in hand'
  | 'not found wrongly'
  | 'no expectation recorded';

const ORDER: Outcome[] = [
  'accepted right',
  'accepted wrong',
  'parked correctly',
  'parked with the answer in hand',
  'not found wrongly',
  'no expectation recorded',
];

/** Grades one Supplier. Pure, so the table and the listing cannot disagree. */
function grade(row: Row, expected: ExpectedMatch | undefined): Outcome {
  if (!expected) return 'no expectation recorded';

  const wanted = typeof expected.expected === 'string' ? null : expected.expected;

  if (row.status === 'accepted') {
    if (!wanted) return 'accepted wrong';
    return row.entityId === wanted.entityId ? 'accepted right' : 'accepted wrong';
  }

  // `parking_is_correct` and `not_in_sayari` both make a parked row right.
  if (!wanted) return 'parked correctly';

  // Parked with a real expectation: the question is whether the loop ever had
  // the answer in front of it. A Candidate it recorded is one a person can
  // still pick on the Needs Review page; one it never saw is not.
  if (row.candidateIds.includes(wanted.entityId)) return 'parked with the answer in hand';
  return row.status === 'not_found' ? 'not found wrongly' : 'parked correctly';
}

async function main(): Promise<void> {
  const db = getDirectDb();
  try {
    const program = await db.query.program.findFirst({ where: eq(t.program.name, PROGRAM.name) });
    if (!program) throw new Error('Seed the database first: pnpm db:seed');

    const rows = await loadRows(db, program.id);
    const graded = rows.map((row) => ({
      row,
      expected: EXPECTED_BY_INDEX.get(row.rosterIndex),
      outcome: grade(row, EXPECTED_BY_INDEX.get(row.rosterIndex)),
    }));

    const confirmed = graded.filter((g) => g.expected?.confirmed === true);
    const unconfirmed = graded.filter((g) => g.expected?.confirmed !== true);

    print(confirmed, unconfirmed, rows.length);
  } finally {
    await closeDirectDb();
  }
}

async function loadRows(db: ReturnType<typeof getDirectDb>, programId: string): Promise<Row[]> {
  const suppliers = await db.query.supplier.findMany({
    where: eq(t.supplier.programId, programId),
  });

  const rows: Row[] = [];
  for (const supplier of suppliers) {
    if (supplier.rosterIndex == null || supplier.rosterName == null) continue;
    const match = await db.query.match.findFirst({
      where: eq(t.match.supplierId, supplier.id),
      with: { entity: true, attempts: { with: { candidates: true } } },
    });
    rows.push({
      rosterIndex: supplier.rosterIndex,
      rosterName: supplier.rosterName,
      status: match?.status ?? 'no match row',
      settledBy: match?.settledBy ?? '—',
      entityId: match?.entityId ?? null,
      label: match?.entity?.label ?? null,
      // Every Candidate ever recorded for this Supplier, across attempts —
      // "did the loop ever have the right answer in front of it" is a question
      // about the whole Match, not about its last attempt.
      candidateIds: [
        ...new Set((match?.attempts ?? []).flatMap((a) => a.candidates.map((c) => c.entityId))),
      ],
    });
  }
  return rows.sort((a, b) => a.rosterIndex - b.rosterIndex);
}

type Graded = { row: Row; expected: ExpectedMatch | undefined; outcome: Outcome };

function print(confirmed: Graded[], unconfirmed: Graded[], total: number): void {
  console.log(
    `\n  ${total} roster rows · truth set ${confirmed.length} confirmed, ${unconfirmed.length} unconfirmed\n`,
  );

  console.log('  ── The scoreboard, over CONFIRMED rows only ───────────────────────────');
  if (confirmed.length === 0) {
    console.log(
      '  Nothing is confirmed yet, so there is no scoreboard. The draft below is\n' +
        '  what a person has to read first — see docs/seed/expected-matches-draft.md.\n',
    );
  } else {
    for (const outcome of ORDER) {
      const n = confirmed.filter((g) => g.outcome === outcome).length;
      if (n > 0) console.log(`  ${String(n).padStart(3)}  ${outcome}`);
    }
    console.log('');
    for (const g of confirmed) {
      console.log(
        `  ${String(g.row.rosterIndex).padStart(2)} ${g.row.rosterName.padEnd(30)} ${g.outcome.padEnd(30)} ${g.row.label ?? `(${g.row.status})`}`,
      );
    }
    console.log('');
  }

  console.log('  ── Unconfirmed, listed rather than counted ────────────────────────────');
  for (const g of unconfirmed) {
    const expectation =
      g.expected === undefined
        ? 'no expectation recorded'
        : typeof g.expected.expected === 'string'
          ? g.expected.expected
          : g.expected.expected.label;
    console.log(
      `  ${String(g.row.rosterIndex).padStart(2)} ${g.row.rosterName.padEnd(30)} ` +
        `${(g.expected?.confidence ?? '—').padEnd(7)} ${g.outcome.padEnd(30)} ` +
        `settled: ${g.row.label ?? `(${g.row.status})`}  ·  expected: ${expectation}`,
    );
  }
  console.log('');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
