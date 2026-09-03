// Next.js loads `.env` itself; a plain Node entrypoint has to ask.
import 'dotenv/config';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { closeDirectDb, getDirectDb, type Database } from '@/db/client';
import * as t from '@/db/schema';
import { PROGRAM } from '@/db/seed-data/program';
import { loadCategoryPage } from '@/db/queries/category-page';
import { loadCitationPage } from '@/db/queries/citation-page';
import { loadEntityPage } from '@/db/queries/entity-page';
import { loadRecommendationPage } from '@/db/queries/recommendation-page';
import { loadRunPage } from '@/db/queries/run-page';
import { loadRunsPage } from '@/db/queries/runs-page';
import { loadSettlePage } from '@/db/queries/settle-page';
import { loadSupplierPage } from '@/db/queries/supplier-page';

/**
 * Every page, fetched, against a running app (SPEC §13).
 *
 *   pnpm dev            # in one terminal
 *   pnpm smoke:pages    # in another
 *
 * ## Why this exists rather than a test
 *
 * **Nothing in the suite touches `src/app`.** Fifty-seven test files cover the
 * domain, the jobs, the tools, the upstream client and the model client, and
 * not one of them renders a page — so the largest single directory in the
 * build, and the only one a reviewer looks at directly, is checked by opening
 * it in a browser and nothing else.
 *
 * It is a script rather than a test for the same reason the other `smoke:*`
 * scripts are: it needs something running that `pnpm check` promises not to
 * need. `pnpm check` is keyless and serverless by construction, and a test that
 * quietly required a dev server would make it neither.
 *
 * ## What it asserts, and why a status code is not enough
 *
 * A page that lost its `where` clause still returns 200. It renders, it is
 * empty, and a status check calls that a pass — which is exactly the failure a
 * refactor of the data layer produces.
 *
 * So every check carries **markers read out of the database**, never
 * hand-written: the Program's name, the Supplier's roster name, the Category's
 * name. A marker is a string that can only be on the page if the page loaded
 * the row it is about. When one is missing the report says which, because
 * *"/supplier/… is missing 'Yazaki'"* is a bug report and *"page failed"* is
 * not.
 *
 * Every Program-scoped page renders `<Breadcrumb>` with the Program's name, so
 * that marker applies to all of them and each subject page adds its own on top.
 *
 * ## One marker per `<h2>` section, not one per route
 *
 * Lifting each `{/* ── Section ── * /}` seam into its own component (see
 * `README.md`, "the layer rule") made an empty section indistinguishable from
 * a loaded one by status code alone: a section that receives an empty prop
 * renders nothing and the route still returns 200. `sectionMarkers()` below
 * calls the same `db/queries` loader the page itself calls, for a **subject
 * chosen for having real rows** rather than the arbitrary first one, and pulls
 * one string per section straight out of the shaped result — never
 * hand-written, and never present unless that section's own rows loaded. A
 * section with no natural database string to test (a count, a weight) is left
 * uncovered rather than faked with UI copy; the route-level marker still
 * covers it having rendered at all.
 *
 * ## What it skips, and says so
 *
 * A Citation page needs a published sentence; an Entity page needs a resolved
 * Profile; a Job page needs a Job. On a freshly seeded database none of those
 * exist, and failing would only teach you to ignore the output. A skip names
 * the row that was missing, so *"run the pipeline first"* is the report rather
 * than a red line.
 */

const BASE = process.env.PAGES_BASE_URL ?? 'http://localhost:3100';

/** For the report only: ids identify rows, not pages. */
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

type Check = {
  path: string;
  /** Read from the database. A hand-written marker checks the fixture, not the page. */
  markers: string[];
  /** Set when the subject row does not exist yet; the check is reported, not run. */
  skip?: string;
  /** The root redirects, so it is the one check that must not be a 200. */
  expect?: 'ok' | 'redirect';
};

/**
 * React escapes text into HTML entities, and a Category called "Wiring &
 * harnesses" would never match its own name as stored. Decoding is narrower
 * than escaping the marker: it handles the five React emits and leaves
 * everything else, including the em dash in the Program's own name, alone.
 */
function decode(html: string): string {
  return html
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#x27;', "'");
}

/**
 * The latest Run that queued a Job about a Supplier or a Category, rather
 * than the latest Run of any kind. `pnpm smoke:model` and the other upstream
 * probes open Runs of their own, and a database that has run them since is
 * one where "the latest Run" is a smoke check with nothing on the Jobs table
 * a person would recognise — falls back to the plain latest Run when no such
 * Job exists, which is the fresh-database case the skip list already names.
 */
async function findRunWithNamedSubject(db: Database, programId: string) {
  const named = await db
    .select({ runId: t.job.runId })
    .from(t.job)
    .innerJoin(t.run, eq(t.run.id, t.job.runId))
    .where(
      and(eq(t.run.programId, programId), inArray(t.job.subjectType, ['supplier', 'category'])),
    )
    .orderBy(desc(t.run.createdAt))
    .limit(1);
  const runId = named[0]?.runId;
  return runId
    ? await db.query.run.findFirst({ where: eq(t.run.id, runId) })
    : await db.query.run.findFirst({
        where: eq(t.run.programId, programId),
        orderBy: [desc(t.run.createdAt)],
      });
}

/**
 * The subject rows every check is built from — each read as *the latest real
 * one*, so this checks the database in front of you rather than a shape it
 * might once have had.
 *
 * Two subjects are chosen for having content rather than for being first:
 * `assessedSupplier` (a standard Assessment exists) and, off the back of it,
 * `richEntity` (its Match, so Sources / Risk factors / Relationships have
 * something to show) — falling back to the arbitrary first row of each kind
 * when nothing has been assessed yet, which is exactly the fresh-database
 * case the skip list already exists to name.
 */
async function findSubjects(db: Database, programId: string) {
  const p = programId;
  const supplier = await db.query.supplier.findFirst({ where: eq(t.supplier.programId, p) });
  const category = await db.query.category.findFirst({ where: eq(t.category.programId, p) });
  const parked = await db.query.match.findFirst({ where: eq(t.match.status, 'needs_review') });
  const record = await db.query.record.findFirst();
  const sentence = await db.query.sentence.findFirst();
  const run = await findRunWithNamedSubject(db, p);
  const job = run
    ? await db.query.job.findFirst({
        where: eq(t.job.runId, run.id),
        orderBy: [desc(t.job.createdAt)],
      })
    : undefined;

  /**
   * Any Recommendation in the Program, and then the Category it belongs to —
   * not the first Category and then its Recommendation. Asking the other way
   * round skipped a page that existed, because the first Category seeded is
   * rarely the one somebody ran `recommend` for.
   */
  const recommendation = await db.query.recommendation.findFirst({
    where: eq(t.recommendation.programId, p),
  });
  const recommendedCategory = recommendation
    ? await db.query.category.findFirst({ where: eq(t.category.id, recommendation.categoryId) })
    : undefined;

  const assessedRow = await db.query.assessment.findFirst({
    where: and(eq(t.assessment.programId, p), eq(t.assessment.kind, 'standard')),
  });
  const assessedSupplier = assessedRow
    ? await db.query.supplier.findFirst({ where: eq(t.supplier.id, assessedRow.supplierId) })
    : undefined;
  const assessedMatch = assessedSupplier
    ? await db.query.match.findFirst({ where: eq(t.match.supplierId, assessedSupplier.id) })
    : undefined;
  const richEntity = assessedMatch?.entityId
    ? await db.query.entity.findFirst({ where: eq(t.entity.id, assessedMatch.entityId) })
    : await db.query.entity.findFirst();

  return {
    supplier,
    category,
    parked,
    record,
    sentence,
    run,
    job,
    recommendation,
    recommendedCategory,
    assessedSupplier,
    richEntity,
  };
}

type Subjects = Awaited<ReturnType<typeof findSubjects>>;

/** The Category page's section markers — the Shortlist row, the excluded row, the argued case, the tariff line. */
async function categoryMarkers(db: Database, programId: string, cat: Subjects['category']) {
  if (!cat) return [];
  const data = await loadCategoryPage(db, { programId, categoryId: cat.id, query: {} });
  if (!data) return [];
  const line = data.category.hsLines.find((l) => l.isDefault) ?? data.category.hsLines[0];
  return [
    data.shortlist.ranked[0]?.displayName,
    data.shortlist.excluded[0]?.row.displayName,
    data.version ? data.version.evaluatorOutcome.replace(/_/g, ' ') : undefined,
    line?.label,
  ].filter((m): m is string => !!m);
}

/** The Supplier page's section markers — who it is, what was concluded, the family, the enrichments. */
async function supplierMarkers(db: Database, programId: string, supplierId: string) {
  const data = await loadSupplierPage(db, { programId, supplierId, query: {} });
  if (!data) return [];
  // No more standalone Family exposure badge on the page data (network spec
  // §5, ticket 03 unit 03b) — the chain rows (`familyChain`) are still here,
  // and Network exposure's own raw inputs are among `data.scored?.criteria`.
  const familyMarker = data.familyChain[0]?.label;
  return [
    data.described?.headline ?? undefined,
    data.sentences[0]?.text.slice(0, 30),
    familyMarker,
    data.enrichments[0] ? data.enrichments[0].source.replace(/_/g, ' ') : undefined,
  ].filter((m): m is string => !!m);
}

/**
 * The Entity page's section markers — a Source, a Risk factor, a
 * Relationship, the fetched payload, and the roster name of the Supplier this
 * entity is known to. `rosterName` comes from the assessed Supplier the
 * subject was already chosen through in `findSubjects`, so no extra query is
 * needed to have it in hand.
 */
async function entityMarkers(
  db: Database,
  programId: string,
  entityId: string,
  rosterName: string | null | undefined,
) {
  const data = await loadEntityPage(db, { programId, entityId });
  if (!data) return [];
  return [
    data.sources[0]?.label,
    data.factors[0]?.name,
    data.edgeGroups[0] ? data.edgeGroups[0].relationshipType.replace(/_/g, ' ') : undefined,
    data.source?.endpoint,
    rosterName ?? undefined,
  ].filter((m): m is string => !!m);
}

/** The Recommendation page's section markers — a Pick and the argument's first citation-bearing sentence. */
async function recommendationMarkers(db: Database, programId: string, categoryId: string) {
  const data = await loadRecommendationPage(db, { programId, categoryId });
  if (!data) return [];
  return [
    data.picks[0]?.rosterName ?? data.picks[0]?.entityLabel,
    data.sentences[0]?.text.slice(0, 30),
  ].filter((m): m is string => !!m);
}

/** The Run page's Jobs section — one Job whose subject resolved to a name. */
async function runMarkers(db: Database, programId: string, runId: string) {
  const data = await loadRunPage(db, { programId, runId });
  if (!data) return [];
  const named = data.jobs
    .map((job) => data.subjects.get(job.subjectId))
    .find((name): name is string => !!name);
  return named ? [named] : [];
}

/** The Runs page's Ledger section — one Run's own label. */
async function runsMarkers(db: Database, programId: string) {
  const data = await loadRunsPage(db, { programId });
  if (!data) return [];
  const label = data.runs.find((row) => row.run.subjectLabel)?.run.subjectLabel;
  return label ? [label] : [];
}

/** The Settle-row page's sections — a shared verdict, and a listed candidate's own label. */
async function settleMarkers(db: Database, programId: string, supplierId: string) {
  const data = await loadSettlePage(db, { programId, supplierId, query: {} });
  if (!data) return [];
  const candidate = data.groups.flatMap((g) => g.choices)[0]?.label;
  return [
    data.shared[0] ? data.shared[0].discriminator.replace(/_/g, ' ') : undefined,
    candidate,
  ].filter((m): m is string => !!m);
}

/** The Citation page's one section — the title of the first thing this sentence cites. */
async function citationMarkers(db: Database, programId: string, sentenceId: string) {
  const data = await loadCitationPage(db, { programId, sentenceId });
  return data?.citations[0]?.title ? [data.citations[0].title] : [];
}

/**
 * Every extra marker, gathered up front so `buildChecks` stays a plain list.
 * A subject that does not exist yet contributes no markers, which is exactly
 * the skip case `buildChecks` already names.
 */
async function sectionMarkers(db: Database, programId: string, s: Subjects) {
  const categoryForPage = s.recommendedCategory ?? s.category;
  const supplierId = s.assessedSupplier?.id ?? s.supplier?.id;
  return {
    category: categoryForPage ? await categoryMarkers(db, programId, categoryForPage) : [],
    supplier: supplierId ? await supplierMarkers(db, programId, supplierId) : [],
    entity: s.richEntity
      ? await entityMarkers(db, programId, s.richEntity.id, s.assessedSupplier?.rosterName)
      : [],
    recommendation:
      s.recommendation && s.recommendedCategory
        ? await recommendationMarkers(db, programId, s.recommendedCategory.id)
        : [],
    run: s.run ? await runMarkers(db, programId, s.run.id) : [],
    runs: await runsMarkers(db, programId),
    settle: s.parked ? await settleMarkers(db, programId, s.parked.supplierId) : [],
    citation: s.sentence ? await citationMarkers(db, programId, s.sentence.id) : [],
  };
}

type SectionMarkers = Awaited<ReturnType<typeof sectionMarkers>>;

/** The thirteen routes, each carrying the Program's name plus whatever section markers were found for it. */
function buildChecks(programId: string, name: string, s: Subjects, m: SectionMarkers): Check[] {
  const categoryForPage = s.recommendedCategory ?? s.category;
  // The same preference `sectionMarkers` used to compute `m.supplier`: an
  // assessed Supplier when there is one, so the route checked and the
  // markers checked against it are always the same row.
  const supplierForPage = s.assessedSupplier ?? s.supplier;
  return [
    { path: '/', markers: [], expect: 'redirect' },
    { path: `/program/${programId}`, markers: [name, ...m.category.slice(-1)] },
    { path: `/program/${programId}/runs`, markers: [name, ...m.runs] },
    { path: `/program/${programId}/needs-review`, markers: [name] },
    {
      path: `/program/${programId}/category/${categoryForPage?.id}`,
      markers: [name, categoryForPage?.name ?? '', ...m.category],
      ...(categoryForPage ? {} : { skip: 'no Category is seeded' }),
    },
    {
      path: `/program/${programId}/supplier/${supplierForPage?.id}`,
      markers: [name, supplierForPage?.rosterName ?? '', ...m.supplier],
      ...(supplierForPage ? {} : { skip: 'no Supplier is seeded' }),
    },
    {
      path: `/program/${programId}/needs-review/${s.parked?.supplierId}`,
      markers: [name, ...m.settle],
      ...(s.parked ? {} : { skip: 'no Match is parked at needs_review' }),
    },
    {
      path: `/program/${programId}/category/${categoryForPage?.id}/recommendation`,
      markers: [name, categoryForPage?.name ?? '', ...m.recommendation],
      ...(s.recommendation ? {} : { skip: 'no Recommendation has been published' }),
    },
    {
      path: `/program/${programId}/entity/${s.richEntity?.id}`,
      markers: [name, ...m.entity],
      ...(s.richEntity ? {} : { skip: 'no entity row — nothing has resolved yet' }),
    },
    {
      path: `/program/${programId}/record/${s.record?.id}`,
      markers: [name],
      ...(s.record ? {} : { skip: 'no record row — nothing has been fetched yet' }),
    },
    {
      path: `/program/${programId}/citation/${s.sentence?.id}`,
      markers: [name, ...m.citation],
      ...(s.sentence ? {} : { skip: 'no sentence row — nothing has been published yet' }),
    },
    {
      path: `/program/${programId}/runs/${s.run?.id}`,
      markers: [name, ...m.run],
      ...(s.run ? {} : { skip: 'no Run has been opened' }),
    },
    {
      path: `/program/${programId}/runs/${s.run?.id}/job/${s.job?.id}`,
      markers: [name],
      ...(s.job ? {} : { skip: 'no Job has been queued' }),
    },
  ];
}

/**
 * The Program id is on twelve of the thirteen lines and tells you nothing
 * about which of them failed. Showing the route with its ids elided makes the
 * column readable as a list of pages, which is what it is.
 */
function shorten(path: string): string {
  return (
    path
      .replaceAll(UUID, ':id')
      .replace('/program/:id', '/program')
      // An entity id is base64url and a record id carries slashes, so neither
      // is a uuid and both are just as unhelpful in this column.
      .replace(/\/(entity|record|citation)\/.+$/, '/$1/:id')
  );
}

/** Fetches every check, prints one line each, and reports how many of each outcome there were. */
async function runChecks(checks: Check[]): Promise<{ failed: number; skipped: number }> {
  let failed = 0;
  let skipped = 0;
  for (const check of checks) {
    const shown = shorten(check.path);
    if (check.skip) {
      skipped += 1;
      console.log(`  skip  ${shown.padEnd(46)} ${check.skip}`);
      continue;
    }

    let status: number;
    let body: string;
    try {
      // `manual` so the root's redirect is observed rather than followed —
      // following it would test the Program page twice and the root not at all.
      const response = await fetch(`${BASE}${check.path}`, { redirect: 'manual' });
      status = response.status;
      body = decode(await response.text());
    } catch (error) {
      failed += 1;
      console.log(
        `  FAIL  ${shown.padEnd(46)} ${error instanceof Error ? error.message : String(error)}`,
      );
      console.log(`        is the app running? pnpm dev`);
      continue;
    }

    const wantRedirect = check.expect === 'redirect';
    const statusOk = wantRedirect ? status >= 300 && status < 400 : status === 200;
    const missing = check.markers.filter((marker) => marker !== '' && !body.includes(marker));

    if (!statusOk) {
      failed += 1;
      console.log(`  FAIL  ${shown.padEnd(46)} ${status}, wanted ${wantRedirect ? '3xx' : '200'}`);
    } else if (missing.length > 0) {
      failed += 1;
      console.log(
        `  FAIL  ${shown.padEnd(46)} ${status}, missing ${missing.map((m) => `"${m}"`).join(', ')}`,
      );
    } else {
      console.log(`  ok    ${shown.padEnd(46)} ${status}`);
    }
  }
  return { failed, skipped };
}

async function main(): Promise<void> {
  const db = getDirectDb();
  try {
    const program = await db.query.program.findFirst({ where: eq(t.program.name, PROGRAM.name) });
    if (!program) {
      console.error(`The Program "${PROGRAM.name}" is not seeded. Run: pnpm db:seed`);
      process.exitCode = 1;
      return;
    }

    const subjects = await findSubjects(db, program.id);
    const markers = await sectionMarkers(db, program.id, subjects);
    const checks = buildChecks(program.id, program.name, subjects, markers);

    console.log(`\nPages against ${BASE}\n` + '─'.repeat(78));
    const { failed, skipped } = await runChecks(checks);
    console.log('─'.repeat(78));
    console.log(
      `  ${checks.length - skipped - failed} passed · ${failed} failed · ${skipped} skipped\n`,
    );
    if (failed > 0) process.exitCode = 1;
  } finally {
    await closeDirectDb();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exit(1);
});
