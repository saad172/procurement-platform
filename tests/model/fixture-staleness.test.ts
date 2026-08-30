import { describe, expect, it } from 'vitest';
import { buildManifest } from '@/model';
import type { LoopName } from '@/model/settings';
import { listFixtureNames, loadFixture } from '@/fixtures/load';

/**
 * **One test reddens on prompt drift** (SPEC §19.5, mechanism 2).
 *
 * ## What this catches, and what the wire hash catches
 *
 * Both mechanisms are loud, and they are loud about different things:
 *
 * | drift | caught by | how it reads |
 * |---|---|---|
 * | system prompt, model, effort | **this test** | "the assess system prompt changed since …" |
 * | tool schema, message order, a changed tool result | the **wire hash** | a replay miss naming the turn |
 *
 * A changed system prompt trips *both* — it changes the request body too. This
 * test exists so the cause is named **before** anyone starts reading replay
 * errors, because six fixtures missing on turn 1 at once is a confusing morning
 * and "the prompt changed" is a five-second answer.
 *
 * ## Why the tool digest is read off the fixture rather than recomputed
 *
 * The per-loop tool sets are assembled at each call site, not derived by
 * `finalizeRegistry()`, so there is no honest way for this file to ask "what
 * would the assess proposer's digest be *today*" without restating those lists
 * — and a restatement would agree with itself no matter how far the real ones
 * drifted, which is a test that cannot fail.
 *
 * So the digest comes from the fixture, and the comparison is over the three
 * fields that *are* re-derivable. Tool drift is not this test's job; it lands
 * as a replay miss, because tool schemas travel in the request body.
 *
 * ## The fix is a command
 *
 * `pnpm fixtures:record <name>` re-records, and it spends **tokens but no
 * Sayari credits**, because the upstream cache is warm.
 */

const names = await listFixtureNames();

describe('fixture manifests match the current prompts', () => {
  it('has at least one fixture to check', () => {
    // A green suite over zero fixtures is the failure this guards: the walk
    // returns an empty list when nothing is recorded, and `it.each([])` would
    // pass silently.
    expect(names.length).toBeGreaterThan(0);
  });

  it.each(names)('%s', async (name) => {
    const fixture = await loadFixture(name);
    const recorded = fixture.manifest.loopHashes;

    /**
     * A **data-only** fixture pins no prompts, because it ran no model.
     *
     * `enrich` is the fan-out: our code calling five upstreams, with no turns
     * by design. What it carries is upstream bodies, which a later Job's replay
     * needs — and there is no prompt in it that could go stale.
     *
     * The check below still runs for everything else, so a model-driven fixture
     * that somehow pinned nothing is still caught.
     */
    if (fixture.turns.length === 0) {
      expect(fixture.upstream.length, `"${name}" has no turns and no bodies, so it holds nothing`)
        .toBeGreaterThan(0);
      return;
    }

    expect(Object.keys(recorded).length).toBeGreaterThan(0);

    for (const [loop, recordedHash] of Object.entries(recorded)) {
      /**
       * `buildManifest` is asked for *this loop's* recorded tool digest, so the
       * hash it returns differs from the recorded one only when the model,
       * effort or system prompt has moved.
       */
      const digests = { [loop]: fixture.manifest.toolDigests[loop] ?? '' } as Partial<Record<LoopName, string>>;
      const current = buildManifest(digests).find((entry) => entry.loop === loop);

      expect(current, `fixture "${name}" pins loop "${loop}", which no longer exists`).toBeDefined();
      expect(
        current!.hash,
        `The "${loop}" loop's model, effort or system prompt has changed since ` +
          `"${name}" was recorded on ${fixture.manifest.recordedAt}. ` +
          `Re-record it with \`pnpm fixtures:record ${name}\` once the change is intended.`,
      ).toBe(recordedHash);
    }
  });
});
