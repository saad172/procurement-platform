// Next.js loads `.env` itself; a plain Node entrypoint has to ask.
import 'dotenv/config';
import { desc, eq } from 'drizzle-orm';
import { closeDirectDb, getDirectDb } from '@/db/client';
import * as t from '@/db/schema';
import { PROGRAM } from '@/db/seed-data/program';

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

async function main(): Promise<void> {
  const db = getDirectDb();
  try {
    const program = await db.query.program.findFirst({ where: eq(t.program.name, PROGRAM.name) });
    if (!program) {
      console.error(`The Program "${PROGRAM.name}" is not seeded. Run: pnpm db:seed`);
      process.exitCode = 1;
      return;
    }
    const p = program.id;

    // Every subject is read as *the latest real one*, so this checks the
    // database in front of you rather than a shape it might once have had.
    const supplier = await db.query.supplier.findFirst({ where: eq(t.supplier.programId, p) });
    const category = await db.query.category.findFirst({ where: eq(t.category.programId, p) });
    const parked = await db.query.match.findFirst({ where: eq(t.match.status, 'needs_review') });
    const entity = await db.query.entity.findFirst();
    const record = await db.query.record.findFirst();
    const sentence = await db.query.sentence.findFirst();
    const run = await db.query.run.findFirst({ orderBy: [desc(t.run.createdAt)] });
    const job = run
      ? await db.query.job.findFirst({ where: eq(t.job.runId, run.id), orderBy: [desc(t.job.createdAt)] })
      : undefined;
    /**
     * Any Recommendation in the Program, and then the Category it belongs to —
     * not the first Category and then its Recommendation. Asking the other way
     * round skipped a page that existed, because the first Category seeded is
     * rarely the one somebody ran `recommend` for.
     */
    const recommendation = await db.query.recommendation.findFirst();
    const recommendedCategory = recommendation
      ? await db.query.category.findFirst({ where: eq(t.category.id, recommendation.categoryId) })
      : undefined;

    const name = program.name;
    const checks: Check[] = [
      { path: '/', markers: [], expect: 'redirect' },
      { path: `/program/${p}`, markers: [name] },
      { path: `/program/${p}/runs`, markers: [name] },
      { path: `/program/${p}/needs-review`, markers: [name] },
      {
        path: `/program/${p}/category/${category?.id}`,
        markers: [name, category?.name ?? ''],
        ...(category ? {} : { skip: 'no Category is seeded' }),
      },
      {
        path: `/program/${p}/supplier/${supplier?.id}`,
        markers: [name, supplier?.rosterName ?? ''],
        ...(supplier ? {} : { skip: 'no Supplier is seeded' }),
      },
      {
        path: `/program/${p}/needs-review/${parked?.supplierId}`,
        markers: [name],
        ...(parked ? {} : { skip: 'no Match is parked at needs_review' }),
      },
      {
        path: `/program/${p}/category/${recommendedCategory?.id}/recommendation`,
        markers: [name, recommendedCategory?.name ?? ''],
        ...(recommendation ? {} : { skip: 'no Recommendation has been published' }),
      },
      {
        path: `/program/${p}/entity/${entity?.id}`,
        markers: [name],
        ...(entity ? {} : { skip: 'no entity row — nothing has resolved yet' }),
      },
      {
        path: `/program/${p}/record/${record?.id}`,
        markers: [name],
        ...(record ? {} : { skip: 'no record row — nothing has been fetched yet' }),
      },
      {
        path: `/program/${p}/citation/${sentence?.id}`,
        markers: [name],
        ...(sentence ? {} : { skip: 'no sentence row — nothing has been published yet' }),
      },
      {
        path: `/program/${p}/runs/${run?.id}`,
        markers: [name],
        ...(run ? {} : { skip: 'no Run has been opened' }),
      },
      {
        path: `/program/${p}/runs/${run?.id}/job/${job?.id}`,
        markers: [name],
        ...(job ? {} : { skip: 'no Job has been queued' }),
      },
    ];

    console.log(`\nPages against ${BASE}\n` + '─'.repeat(78));

    let failed = 0;
    let skipped = 0;
    for (const check of checks) {
      /**
       * The Program id is on twelve of the thirteen lines and tells you nothing
       * about which of them failed. Showing the route with its ids elided makes
       * the column readable as a list of pages, which is what it is.
       */
      const shown = check.path
        .replaceAll(UUID, ':id')
        .replace('/program/:id', '/program')
        // An entity id is base64url and a record id carries slashes, so neither
        // is a uuid and both are just as unhelpful in this column.
        .replace(/\/(entity|record|citation)\/.+$/, '/$1/:id');
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
        console.log(`  FAIL  ${shown.padEnd(46)} ${error instanceof Error ? error.message : String(error)}`);
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
        console.log(`  FAIL  ${shown.padEnd(46)} ${status}, missing ${missing.map((m) => `"${m}"`).join(', ')}`);
      } else {
        console.log(`  ok    ${shown.padEnd(46)} ${status}`);
      }
    }

    console.log('─'.repeat(78));
    console.log(`  ${checks.length - skipped - failed} passed · ${failed} failed · ${skipped} skipped\n`);
    if (failed > 0) process.exitCode = 1;
  } finally {
    await closeDirectDb();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exit(1);
});
