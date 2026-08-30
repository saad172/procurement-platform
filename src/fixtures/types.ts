/**
 * A fixture is an **export of one real Job's rows** (SPEC §19.1), never a
 * hand-written file.
 *
 * Half the recording seam already exists and is not a client: `trace_turn`
 * holds every model turn and `upstream_response` holds every raw body. Exporting
 * them is what makes the replay-bar claim *proved by the tests existing* — a
 * Trace that cannot drive a replay never met the bar.
 *
 * The shape below is therefore deliberately dumb. It is rows, not a
 * reconstruction: anything this file had to *compute* would be a hand-edited
 * fixture wearing a different hat.
 */

/** One recorded model turn: the request's fingerprint, the response verbatim. */
export type FixtureTurn = {
  n: number;
  /**
   * sha256 of the canonical outbound body (`src/model/wire.ts`).
   *
   * Null for a turn recorded before the capture existed, or one whose capture
   * was lost. Replay reports those rather than guessing, because a turn that
   * can be served only by position is a turn that cannot detect drift.
   */
  wireHash: string | null;
  /**
   * The raw sha256 of the same body, which never changes.
   *
   * It is what `fixtures:rehash` matches a dumped body against, so a refinement
   * of the wire hash costs a re-hash rather than a re-run.
   */
  bodyHash?: string | null;
  loop: string;
  roundN: number | null;
  /** The whole `BetaMessage`, exactly as the API returned it. */
  response: unknown;
  /**
   * The raw SSE body, verbatim, for a **streamed** turn — where `response` is
   * null and this is what the API actually said.
   *
   * Stored as text rather than as a reassembled message, for the same reason
   * `response` is stored whole: a replay that had to *rebuild* an event stream
   * from a final message would be synthesising the thing under test. The events
   * a client sees are the events that were recorded.
   */
  sse?: string;
};

/** One cached upstream body, keyed the way `call()` looks it up. */
export type FixtureUpstreamRow = {
  source: string;
  endpoint: string;
  paramsHash: string;
  params: unknown;
  body: unknown;
  bodyHash: string;
  via: string;
};

/**
 * What §19.5's staleness test compares against.
 *
 * Prompt and tool drift are *already* fatal to a replay that matches wire
 * hashes — a changed system prompt changes the body, so the fixture simply
 * misses. But "it missed" does not say **why**, and a miss on turn 1 of six
 * fixtures at once is a confusing morning.
 *
 * So this snapshots `buildManifest()`'s per-loop hash, which already folds in
 * the four things that change a model's answer: model, effort, system prompt
 * and tool digest. One test compares it and names the cause before anyone
 * starts reading replay errors.
 *
 * It is a **snapshot, never a second computation** — recording stores what
 * `buildManifest()` said at the time, so the two can only disagree by the code
 * genuinely changing.
 */
export type FixtureManifest = {
  name: string;
  recordedAt: string;
  /** Loop name → `buildManifest()`'s per-loop hash, as of recording. */
  loopHashes: Record<string, string>;
  /**
   * Loop name → the tool digest in force at recording, read off `trace_turn`.
   *
   * Stored separately from the hash it feeds because the staleness test has to
   * hold it *constant* to ask its question — "did the prompt move, with the
   * tools held still?" — and a number folded into a hash cannot be held still.
   */
  toolDigests: Record<string, string>;
};

export type Fixture = {
  manifest: FixtureManifest;
  turns: FixtureTurn[];
  upstream: FixtureUpstreamRow[];
};
