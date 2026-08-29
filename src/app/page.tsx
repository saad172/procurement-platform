/**
 * The spine starts at the Program page (SPEC §13.1):
 *
 *   Program → Category → Supplier → Sayari entity → record
 *
 * Pages land in build-order step 11. This placeholder exists so the compose
 * topology is verifiable end to end from step 1 — `docker compose up` should
 * serve something before it serves the real thing.
 */
export default function HomePage() {
  return (
    <main style={{ padding: '3rem', maxWidth: '42rem' }}>
      <h1>Procurement Platform</h1>
      <p>
        Supplier-sourcing decision support on the Sayari entity graph. The spine —
        Program → Category → Supplier → entity → record — lands in build-order step 11.
      </p>
    </main>
  );
}
