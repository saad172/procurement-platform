/**
 * The prompt-cache layout, as it is actually sent (SPEC §17.4).
 *
 * Caching is a **prefix match** over `tools → system → messages`, so any byte
 * change anywhere in the prefix invalidates everything after it. A Job's prefix
 * caches harder than chat's: 50 resolve Jobs share one `system` plus tool
 * digest, 50 assess Jobs another, and the **stateless evaluator** a third
 * across every Supplier — so the app's largest volume sits behind its most
 * stable prefix.
 *
 * **Two markers, both in `buildRunner`** (`run-loop.ts`), which is the only
 * place a request is constructed:
 *
 * 1. One **breakpoint on the last tool definition**, ending the static prefix.
 *    The tool list is *not* re-sorted to get it: `finalizeRegistry()`'s digest
 *    order is already deterministic, and re-ordering would change the bytes of
 *    every recorded request for a cache nobody was getting.
 * 2. **Top-level `cache_control`**, which marks the last cacheable block of the
 *    request automatically — so the growing tail of the conversation is cached
 *    without this layer having to know where a Round boundary falls.
 *
 * `system` stays **frozen per loop and never interpolated**; per-run content
 * goes in the first user message, behind the breakpoint. That rule is enforced
 * by `manifest.ts`, which hashes the `system` each loop is pinned at.
 *
 * ## What this file used to hold, and why it does not
 *
 * A `sortToolsByName`, a `markRoundBoundary` that wrote a marker onto the last
 * message block, and a `pageBlock` — none of which had a caller in `src/`. The
 * cache they described was never switched on: `cache_read_input_tokens` summed
 * to zero across every turn of every Job the build has ever run. A layout
 * described in three exported functions and applied by none of them is not a
 * layout; the two markers above are, and they are eight lines away in the file
 * that sends the request.
 *
 * The Round-boundary marker is the one deliberate loss. It did double duty in
 * the spec — the cache breakpoint and the resume checkpoint on one line — and
 * the resume checkpoint now lives where it can actually be read back, in
 * `job_round.checkpoint` (`src/jobs/checkpoint.ts`). Top-level `cache_control`
 * covers the caching half without a per-Round edit to the message array.
 *
 * The 5-minute TTL is the default and is right: at our cadence every request
 * refreshes it.
 */

export const CACHE_CONTROL = { type: 'ephemeral' as const };
