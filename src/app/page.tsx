import Link from 'next/link';
import { eq } from 'drizzle-orm';
import { redirect } from 'next/navigation';
import { getPooledDb } from '@/db/client';
import * as t from '@/db/schema';
import { PROGRAM } from '@/db/seed-data/program';

/**
 * The root redirects to the **approved** Programme, by name.
 *
 * SPEC §4.3: the Programme and the 50-row roster both seed at boot, so **the
 * reviewer's first action is Run, not an import**. A landing page asking which
 * programme to open would be a step between a person and the one they came for.
 *
 * It used to be `findFirst()` with no `orderBy`, which was unambiguous while
 * exactly one Programme existed. The arranged-fixtures Programme (SPEC §19.3)
 * seeds alongside it, so an unordered read began returning whichever row
 * Postgres reached first — and half the time that is
 * `FIXTURE ARRANGEMENTS — test only`, which is not a programme anybody wants to
 * land on.
 *
 * **The fix is a name, not an `ORDER BY`** — the same conclusion finding 81
 * reached when this bit the assess replay, and `tests/support/seeded-program.ts`
 * carries the other half of it. Ordering would make the answer stable; asking
 * for a specific Programme makes it correct, and stays correct when a third one
 * arrives.
 */
export default async function HomePage() {
  const program = await getPooledDb().query.program.findFirst({
    where: eq(t.program.name, PROGRAM.name),
  });
  if (program) redirect(`/program/${program.id}` as never);

  return (
    <main>
      <h1>Procurement Platform</h1>
      <p className="sub">
        No sourcing programme is seeded yet. Run <code className="mono">pnpm db:seed</code> to load the
        demo programme and its 50-row roster.
      </p>
      <p className="note">
        <Link href={'/' as never}>Reload</Link> once the seed has run.
      </p>
    </main>
  );
}
