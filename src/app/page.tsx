import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getPooledDb } from '@/db/client';

/**
 * The root redirects to the seeded Programme.
 *
 * SPEC §4.3: the Programme and the 50-row roster both seed at boot, so **the
 * reviewer's first action is Run, not an import**. A landing page asking which
 * programme to open would be a step between a person and the only programme
 * there is.
 */
export default async function HomePage() {
  const program = await getPooledDb().query.program.findFirst();
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
