import Link from 'next/link';
import { z } from 'zod/v4';
import { RawPayload } from './raw';

/**
 * `program_summary` — mirrors the Program page's answer strip: the name, its
 * Plants, its Categories and the count that reaches no Category at all.
 *
 * `get_program`'s payload has no bidder count per Category — that join lives
 * on the Program page's own loader, not this tool — so this widget names each
 * Category without one rather than inventing a figure the read never fetched.
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

function PlantLine({ plants }: { plants: z.infer<typeof plantSchema>[] }) {
  if (plants.length === 0) return <p className="note">No plants recorded.</p>;
  return (
    <p className="note" style={{ margin: '0 0 0.6rem' }}>
      {plants.map((pl) => `${pl.code} · ${pl.city}, ${pl.country}`).join(' · ')}
    </p>
  );
}

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
