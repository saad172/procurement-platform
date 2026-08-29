import { assertPresetsAreLegal } from '@/domain/score';
import { assertModelConfigIsLegal } from '@/model';
import { getRegistry } from '@/tools';
import { loadEnv, type Env } from './env';

/**
 * Everything that must be true before this process serves a request.
 *
 * The idiom is one thing said three times: **a wrong configuration refuses to
 * boot, naming what is wrong**. It applies to a missing credential (SPEC §4.2),
 * to a weight preset that has drifted away from the Criterion list (§13.4), and
 * — once it exists — to a tool registry handing a loop a tool it cannot reach
 * (§15.5).
 *
 * The alternative each time is a check that runs later, when someone is already
 * looking at a wrong answer.
 */
export function boot(): Env {
  const env = loadEnv();

  // The seed's own presets had already gone stale — summing to 101 and 112 —
  // when a Criterion was dropped. A stored `weight_preset` row would have
  // survived that silently; a constant beside the Criterion list it quantifies
  // over cannot.
  assertPresetsAreLegal();

  // The model constant is a known id, every loop has a system prompt, and every
  // effort is in the legal set. Boot VALIDATES and never calls — unlike
  // src/upstream, whose fallback is our own code that CI never exercises.
  assertModelConfigIsLegal();

  // finalizeRegistry() derives every per-surface and per-Round tool list, so
  // "a loop was handed a tool it cannot reach" is unrepresentable rather than
  // tested for. It throws here, naming every problem at once.
  getRegistry();

  return env;
}
