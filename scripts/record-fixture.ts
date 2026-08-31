// Next.js loads `.env` itself; a plain Node entrypoint has to ask.
import 'dotenv/config';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { and, desc, eq, ne } from 'drizzle-orm';
import { closeDirectDb, getDirectDb } from '@/db/client';
import * as t from '@/db/schema';
import { fixtureDigest, recordFixture, serializeFixture } from '@/fixtures/record';

/**
 * Exports a real Job as a replay fixture (SPEC §19.1, §19.5).
 *
 *   pnpm fixtures:record <name> [jobId]
 *
 * With no `jobId` it takes the most recent **succeeded** Job whose kind matches
 * the fixture's family — `resolve/agree-r1` takes the latest `resolve` Job — so
 * the ordinary flow is: run the smoke script, then record what it produced.
 *
 * **It spends nothing.** Recording reads rows the Job already wrote. The
 * expensive part was running the Job, and re-recording after a prompt change
 * costs tokens but **no Sayari credits**, because the upstream cache is warm.
 */

const FIXTURE_DIR = join(process.cwd(), 'tests', 'fixtures');

/** A fixture's name is `<jobKind>/<case>`, which is also its path. */
function jobKindOf(name: string): string {
  const [kind] = name.split('/');
  if (!kind) throw new Error(`Fixture name "${name}" has no job kind. Expected "<kind>/<case>".`);
  return kind;
}

async function main(): Promise<void> {
  const name = process.argv[2];
  if (!name) {
    console.error('Usage: pnpm fixtures:record <name> [jobId]\n  e.g. pnpm fixtures:record resolve/agree-r1');
    process.exitCode = 1;
    return;
  }

  const db = getDirectDb();
  try {
    let jobId = process.argv[3];
    if (!jobId) {
      const kind = jobKindOf(name);
      /**
       * The latest Job of this kind, **excluding smoke probes**.
       *
       * `smoke:model` opens a Job with `kind: 'assess'` — it exercises the
       * model chokepoint and assess is simply the loop it borrows. Auto-select
       * happily picked it, and `assess/passes-at-round-1` was recorded as a
       * two-turn toy conversation about roster countries. It passed the
       * recorder's checks, because it *is* a well-formed replayable Job.
       *
       * The Run's `trigger` is what separates them: a real Job is triggered by
       * `full`, `reassess`, `discover` and so on; a probe is `smoke`.
       */
      const [latest] = await db
        .select({ id: t.job.id, state: t.job.state, createdAt: t.job.createdAt })
        .from(t.job)
        .innerJoin(t.run, eq(t.run.id, t.job.runId))
        .where(and(eq(t.job.kind, kind as never), ne(t.run.trigger, 'smoke')))
        .orderBy(desc(t.job.createdAt))
        .limit(1);
      if (!latest) {
        console.error(`No "${kind}" job in the database. Run the matching smoke script first.`);
        process.exitCode = 1;
        return;
      }
      jobId = latest.id;
      console.warn(`Using the latest ${kind} job ${jobId} (${latest.state}, ${latest.createdAt.toISOString()}).`);
    }

    // Passed in rather than read inside, so the export is a pure function of
    // its inputs and two recordings of one Job differ only by this field.
    const fixture = await recordFixture(db, { name, jobId, recordedAt: new Date().toISOString() });

    const path = join(FIXTURE_DIR, `${name}.json`);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, serializeFixture(fixture));

    console.warn(
      [
        '',
        `  ${name}`,
        `    ${fixture.turns.length} turn(s), ${fixture.upstream.length} cached upstream row(s)`,
        `    loops: ${Object.keys(fixture.manifest.loopHashes).join(', ') || 'none'}`,
        `    digest ${fixtureDigest(fixture).slice(0, 16)}…`,
        `    written to ${path}`,
        '',
      ].join('\n'),
    );
  } finally {
    await closeDirectDb();
  }
}

void main();
