import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getPooledDb } from '@/db/client';
import { loadApprovedProgram } from '@/db/queries/approved-program';

/**
 * The root redirects to the **approved** Program, by name.
 *
 * SPEC §4.3: the Program and the 50-row roster both seed at boot, so **the
 * reviewer's first action is Run, not an import**. A landing page asking which
 * program to open would be a step between a person and the one they came for.
 *
 * Which Program that is, and why it is asked for by name rather than ordered,
 * is in `loadApprovedProgram`.
 */
export default async function HomePage() {
  const program = await loadApprovedProgram(getPooledDb());
  if (program) redirect(`/program/${program.id}` as never);

  return (
    <main>
      <h1>Procurement Platform</h1>
      <p className="sub">
        No sourcing program is seeded yet. Run <code className="mono">pnpm db:seed</code> to load the
        demo program and its 50-row roster.
      </p>
      <p className="note">
        <Link href={'/' as never}>Reload</Link> once the seed has run.
      </p>
    </main>
  );
}
