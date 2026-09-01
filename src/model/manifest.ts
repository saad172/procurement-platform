import { createHash } from 'node:crypto';
import { LOOP_SETTINGS, type LoopName } from './settings';
import * as assess from './prompts/assess';
import * as chat from './prompts/chat';
import * as classifier from './prompts/classifier';
import * as recommend from './prompts/recommend';
import * as resolve from './prompts/resolve';

/**
 * The prompt manifest (SPEC §17.9, §19.5).
 *
 * One `sha256` per loop over `{ model, effort, system, toolDigest }` — the four
 * things that change a model's answer. Computed at boot beside
 * `finalizeRegistry()` and exported, so **one test** compares one hash per loop
 * and reddens on drift in any of them.
 *
 * The alternative was a per-fixture warning, which is worse in the way that
 * matters: a warning on every fixture is noise that stops being read, while a
 * single red test is a thing someone fixes. Re-recording is a command that
 * spends **tokens but no Sayari credits**, because the upstream cache is warm.
 */

/** The `system` string each loop is frozen at. */
export const LOOP_SYSTEMS: Record<LoopName, string> = {
  resolve: `${resolve.resolverSystem}\n---\n${resolve.evaluatorSystem}`,
  assess: `${assess.proposerSystem}\n---\n${assess.evaluatorSystem}`,
  recommend: `${recommend.analystSystem}\n---\n${recommend.leadSystem}\n---\n${recommend.evaluatorSystem}`,
  classifier: classifier.system,
  chat: chat.system,
  dossier: assess.proposerSystem,
};

export type LoopManifest = {
  loop: LoopName;
  model: string;
  effort: string;
  systemHash: string;
  toolDigestHash: string;
  hash: string;
};

/**
 * `toolDigestHash` is supplied by `finalizeRegistry()` rather than computed
 * here, because the tool list is derived per surface and per Round — a hash
 * this module computed would be a second, hand-written copy of the thing the
 * registry exists to derive.
 */
export function buildManifest(toolDigests: Partial<Record<LoopName, string>>): LoopManifest[] {
  return (Object.keys(LOOP_SETTINGS) as LoopName[]).map((loop) => {
    const settings = LOOP_SETTINGS[loop];
    const system = LOOP_SYSTEMS[loop];
    const systemHash = createHash('sha256').update(system).digest('hex');
    const toolDigestHash = toolDigests[loop] ?? '';
    return {
      loop,
      model: settings.model,
      effort: settings.effort,
      systemHash,
      toolDigestHash,
      hash: createHash('sha256')
        .update(
          JSON.stringify({
            model: settings.model,
            effort: settings.effort,
            systemHash,
            toolDigestHash,
          }),
        )
        .digest('hex'),
    };
  });
}

const LEGAL_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

/**
 * **Boot validates and never calls** (SPEC §17.7, divergence 2).
 *
 * The second deliberate divergence from `src/upstream`, and naming why is the
 * point: `src/upstream` fires a live `metadata` call on boot because its
 * fallback is *our* code, which CI never runs. The model's fallback is
 * **server-side**, so there is no cold path of ours to keep warm — and spending
 * on every cold start to learn nothing would be a worse trade.
 *
 * So this throws instead: the model constant is a known id, every loop has a
 * `system`, every effort is in the legal set, and no `system` is empty.
 */
export function assertModelConfigIsLegal(): void {
  for (const [loop, settings] of Object.entries(LOOP_SETTINGS) as [
    LoopName,
    (typeof LOOP_SETTINGS)[LoopName],
  ][]) {
    if (!settings.model) throw new Error(`Loop "${loop}" has no model.`);
    if (!LEGAL_EFFORTS.has(settings.effort)) {
      throw new Error(
        `Loop "${loop}" has effort "${settings.effort}", which is not one of ${[...LEGAL_EFFORTS].join(', ')}.`,
      );
    }
    const system = LOOP_SYSTEMS[loop];
    if (!system || system.trim().length === 0) {
      throw new Error(`Loop "${loop}" has an empty system prompt.`);
    }
  }
}
