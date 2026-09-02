import Link from 'next/link';
import { z } from 'zod/v4';
import { RawPayload } from './raw';

/**
 * `program_summary` — the Program page's heading (`page.tsx`'s `<h1>`/`<p
 * className="sub">`) plus `CategoryLedger`'s Category rows
 * (`src/app/program/[programId]/sections.tsx`, inside `TheWorking`), at the
 * top of the spine `Program → Category → Supplier → Sayari entity → record`
 * (SPEC §13.1).
 *
 * `get_program`'s query never joins `biddersByCategory` — that count is built
 * on the page's own loader from a Supplier↔Category join this tool does not
 * run (finding 103) — so `CategoryTable` below names each Category without a
 * bidder figure rather than a zero that would read as "nobody bids on this".
 *
 * **The Plant line has no page equivalent.** `program.plants` feeds only the
 * page's proximity map, never a text list — drawn here as plain text because
 * chat has no map to draw instead, and a Plant's code, city and country are
 * exactly what a person would ask the map to point at.
 */

const plantSchema = z.object({
  id: z.string(),
  code: z.string(),
  city: z.string(),
  country: z.string(),
});
const categorySchema = z.object({
  id: z.string(),
  programId: z.string().optional(),
  code: z.string(),
  name: z.string(),
});
const payloadSchema = z.object({
  id: z.string(),
  name: z.string(),
  importingCountry: z.string(),
  vehicleClass: z.string(),
  sourcingHorizon: z.string(),
  plants: z.array(plantSchema),
  categories: z.array(categorySchema),
  uncategorised: z.array(z.object({ id: z.string(), rosterName: z.string().nullable() })),
});

export function ProgramSummaryWidget({ payload }: { payload: unknown }) {
  const parsed = payloadSchema.safeParse(payload);
  // Falls back rather than throws: a widget frozen onto a message outlives
  // the shape this schema names (finding 103).
  if (!parsed.success) return <RawPayload payload={payload} />;
  const p = parsed.data;
  return (
    <div>
      <h4 style={{ margin: '0 0 0.3rem' }}>
        <Link href={`/program/${p.id}` as never}>{p.name}</Link>
      </h4>
      <p className="note" style={{ margin: '0 0 0.6rem' }}>
        {p.importingCountry} · {p.vehicleClass} · {p.sourcingHorizon}
      </p>
      <PlantLine plants={p.plants} />
      <CategoryTable programId={p.id} categories={p.categories} />
      <p className="note" style={{ margin: '0.5rem 0 0' }}>
        {p.uncategorised.length} not mapped to any category, so cannot be ranked.
      </p>
    </div>
  );
}

/** ── The Plants a Category's proximity is measured against, listed rather than mapped ── */
function PlantLine({ plants }: { plants: z.infer<typeof plantSchema>[] }) {
  if (plants.length === 0) return <p className="note">No plants recorded.</p>;
  return (
    <p className="note" style={{ margin: '0 0 0.6rem' }}>
      {plants.map((pl) => `${pl.code} · ${pl.city}, ${pl.country}`).join(' · ')}
    </p>
  );
}

/** ── What you are buying, minus the Bidders column `get_program` cannot fill ── */
function CategoryTable({
  programId,
  categories,
}: {
  programId: string;
  categories: z.infer<typeof categorySchema>[];
}) {
  if (categories.length === 0) return <p className="empty">No categories yet.</p>;
  return (
    <table>
      <thead>
        <tr>
          <th>Code</th>
          <th>Category</th>
        </tr>
      </thead>
      <tbody>
        {categories.map((c) => (
          <tr key={c.id}>
            <td>
              {/*
                `c.programId` falls back to the enclosing `programId` because
                an older frozen payload carried the category row without it
                (finding 103) — both name the same Program here, so either is
                a correct link.
              */}
              <Link href={`/program/${c.programId ?? programId}/category/${c.id}` as never}>
                <strong className="mono">{c.code}</strong>
              </Link>
            </td>
            <td>{c.name}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
