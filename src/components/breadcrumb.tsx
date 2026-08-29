import Link from 'next/link';

/**
 * The breadcrumb (SPEC §13.1).
 *
 * **Drill-down means navigation**, and each level replaces the last — so the
 * breadcrumb is the *only* memory of where you came from. It is not decoration:
 * it is the entire mechanism by which the spine stays navigable while the
 * Supplier page gets the full width it needs for an Assessment and a Trace.
 */
export function Breadcrumb({ trail }: { trail: { label: string; href?: string }[] }) {
  return (
    <nav className="breadcrumb" aria-label="Breadcrumb">
      {trail.map((step) => (
        <span key={`${step.label}-${step.href ?? ''}`}>
          {step.href ? <Link href={step.href as never}>{step.label}</Link> : step.label}
        </span>
      ))}
    </nav>
  );
}
