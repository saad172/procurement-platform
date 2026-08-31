/**
 * Re-runs the eight Discriminators over the **stored** payloads of every
 * Candidate that has already been judged, and diffs the verdicts against what
 * was recorded at the time.
 *
 * It exists because a Discriminator is only as good as the facts handed to it,
 * and two of those facts — `aliases` and `businessPurposes` — were silently
 * always empty until the attribute projection was fixed. A pass rate measured
 * against an empty input is not a measurement, and the only honest way to say
 * what changed is to run the old inputs and the new ones over the same
 * Candidates.
 *
 * It spends nothing: every payload it needs is already in `upstream_response`.
 * Candidates whose entity was never fetched with its own `getEntity` body are
 * counted and skipped rather than guessed at.
 *
 *     pnpm remeasure:discriminators
 */
import { config } from 'dotenv';
config({ path: '.env', quiet: true });
import postgres from 'postgres';
import { runDiscriminators, type RosterRow } from '../src/domain/match/discriminators';
import { toCandidateFacts } from '../src/jobs/resolve';
import { entitySchema, type SayariEntity } from '../src/upstream/projections/sayari';

type Row = {
  entity_id: string;
  roster_name: string | null;
  roster_address: string | null;
  roster_country: string | null;
  has_category: boolean;
  body: unknown;
  recorded: { discriminator: string; verdict: string }[] | null;
};

const pct = (n: number, of: number) => (of === 0 ? '  —  ' : `${((n / of) * 100).toFixed(1)}%`);

async function main() {
  const sql = postgres(process.env.DATABASE_URL!);

  /**
   * One row per judged Candidate, carrying the roster row it was judged
   * against and the most recent stored body for its entity.
   *
   * `distinct on` keeps the newest payload per entity — a Candidate refetched
   * in a later attempt should be re-measured against what we hold now.
   */
  const rows = (await sql`
    with payload as (
      select distinct on (u.params->>'id')
             u.params->>'id' as entity_id, u.body
      from upstream_response u
      where u.endpoint = 'entity.getEntity' and u.params ? 'id'
      order by u.params->>'id', u.fetched_at desc
    )
    select mc.entity_id,
           s.roster_name, s.roster_address, s.roster_country,
           exists (select 1 from supplier_category sc where sc.supplier_id = s.id) as has_category,
           p.body,
           (select jsonb_agg(jsonb_build_object('discriminator', v.discriminator, 'verdict', v.verdict))
              from match_candidate_verdict v
             where v.match_candidate_id = mc.id and v.reported_by = 'rules') as recorded
    from match_candidate mc
    join match_attempt ma on ma.id = mc.match_attempt_id
    join match m on m.id = ma.match_id
    join supplier s on s.id = m.supplier_id
    left join payload p on p.entity_id = mc.entity_id
    where s.roster_name is not null
  `) as unknown as Row[];

  const now: Record<string, Record<string, number>> = {};
  const then: Record<string, Record<string, number>> = {};
  const flips: { entity: string; roster: string; discriminator: string; from: string; to: string }[] = [];
  let noPayload = 0;
  let noRecorded = 0;
  let measured = 0;
  let aliasesGained = 0;
  let purposesGained = 0;

  for (const row of rows) {
    if (!row.body) {
      noPayload += 1;
      continue;
    }
    const roster: RosterRow = {
      name: row.roster_name!,
      address: row.roster_address,
      country: row.roster_country,
      hasCategory: row.has_category,
    };

    let entity: SayariEntity;
    try {
      entity = entitySchema.parse(row.body) as SayariEntity;
    } catch {
      noPayload += 1;
      continue;
    }

    const facts = toCandidateFacts(entity);
    if (facts.aliases.length > 0) aliasesGained += 1;
    if (facts.businessPurposes.length > 0) purposesGained += 1;

    /**
     * The same Candidate as it is judged today.
     *
     * **`lei_witness` is not a real reading here.** The GLEIF join is live and
     * this script spends nothing, so `facts.gleif` is undefined and that one
     * Discriminator reads `unavailable` for every row by construction. It is
     * printed rather than hidden — a silently omitted row is how a reader comes
     * to believe eight checks were re-measured when seven were — but every
     * `lei_witness` movement below is this script's doing, not the fix's.
     */
    const results = runDiscriminators(roster, facts);
    measured += 1;
    for (const r of results) {
      (now[r.discriminator] ??= {})[r.verdict] = ((now[r.discriminator] ??= {})[r.verdict] ?? 0) + 1;
    }

    const recorded = row.recorded;
    if (!recorded) {
      noRecorded += 1;
      continue;
    }
    const byName = new Map(recorded.map((r) => [r.discriminator, r.verdict]));
    for (const r of results) {
      const was = byName.get(r.discriminator);
      if (was == null) continue;
      (then[r.discriminator] ??= {})[was] = ((then[r.discriminator] ??= {})[was] ?? 0) + 1;
      if (was !== r.verdict) {
        flips.push({
          entity: entity.label,
          roster: roster.name,
          discriminator: r.discriminator,
          from: was,
          to: r.verdict,
        });
      }
    }
  }

  await sql.end();

  console.log(`judged Candidates       ${rows.length}`);
  console.log(`  re-measured           ${measured}`);
  console.log(`  no stored payload     ${noPayload}`);
  console.log(`  no recorded verdicts  ${noRecorded}`);
  console.log(`\nof the ${measured} re-measured, the facts now carry:`);
  console.log(`  aliases           ${aliasesGained} (${pct(aliasesGained, measured)})`);
  console.log(`  businessPurposes  ${purposesGained} (${pct(purposesGained, measured)})`);

  const comparable = measured - noRecorded;
  console.log(
    `\nThe two columns are different populations: "then" is the ${comparable} Candidates that` +
      `\nstored a rules verdict, "now" is all ${measured} re-measured. Read the percentages,` +
      `\nnot the counts. lei_witness is unavailable throughout by construction — see the source.`,
  );
  console.log(`\n${'discriminator'.padEnd(18)} ${`recorded then (n=${comparable})`.padEnd(34)} now (n=${measured})`);
  for (const name of Object.keys(now).sort()) {
    const fmt = (counts: Record<string, number> | undefined) => {
      if (!counts) return '—';
      const total = Object.values(counts).reduce((a, b) => a + b, 0);
      return ['pass', 'fail', 'unavailable']
        .filter((v) => counts[v])
        .map((v) => `${v} ${counts[v]} (${pct(counts[v]!, total)})`)
        .join(', ');
    };
    console.log(`${name.padEnd(18)} ${fmt(then[name]).padEnd(34)} ${fmt(now[name])}`);
  }

  console.log(`\nverdicts that moved: ${flips.length}`);
  const byKind = new Map<string, number>();
  for (const f of flips) {
    const key = `${f.discriminator}: ${f.from} → ${f.to}`;
    byKind.set(key, (byKind.get(key) ?? 0) + 1);
  }
  for (const [key, n] of [...byKind].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${n.toString().padStart(4)}  ${key}`);
  }

  console.log(`\nfirst 15, named:`);
  for (const f of flips.slice(0, 15)) {
    console.log(`  ${f.discriminator} ${f.from} → ${f.to}  "${f.entity}" for roster "${f.roster}"`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
