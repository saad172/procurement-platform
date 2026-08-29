/**
 * Prompts are **frozen string constants**, one file per loop (SPEC §17.9).
 *
 * One exported `system` with **no interpolation**, plus a
 * `buildFirstUserMessage(input)` for everything that varies per run. The split
 * is what makes the cache layout work: `system` is the front of the prefix, so
 * a single interpolated value at the top would invalidate every cached turn
 * behind it.
 *
 * Not `.md` read at runtime: a file read is a boot dependency, and a missing
 * prompt file would invent a failure mode for no gain.
 */
export * as resolvePrompts from './resolve';
export * as assessPrompts from './assess';
export * as recommendPrompts from './recommend';
export * as classifierPrompts from './classifier';
export * as chatPrompts from './chat';
