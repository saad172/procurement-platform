import { createHash } from 'node:crypto';
import { RUNNABLE_JOB_KINDS } from '@/config/constants';
import type { ToolDefinition, ToolSurface } from './define';

/**
 * `finalizeRegistry()` — the fourth chokepoint (SPEC §2.4, §15.5).
 *
 * Unlike the other three it is **not** an import boundary, because what it
 * guards quantifies over runtime values a linter cannot see: which tools a
 * given surface, and a given Round, may reach.
 *
 * It **throws at boot** — the same idiom as a missing credential and a drifted
 * weight preset. And it **derives** every per-surface and per-Round tool list
 * rather than accepting a hand-written one, which is what makes *"a loop was
 * handed a tool it cannot reach"* **unrepresentable** rather than tested for.
 */

export type Registry = {
  all: ToolDefinition[];
  byName: Map<string, ToolDefinition>;
  /**
   * Problems that are **stated rather than refused**.
   *
   * The invariants throw, because each one prevents a tool somebody adds later
   * without thinking about it. This one cannot yet: two `enqueue_*` tools in
   * the catalog today name Job kinds the worker has no handler for, and
   * refusing to boot on them would refuse to boot the app. Carried here so a
   * test can read the finding, and logged at boot so it is not silent.
   */
  warnings: string[];
  /** Derived. There is no way to hand-write one of these. */
  forSurface: (surface: ToolSurface) => ToolDefinition[];
  /** Derived per Round — see `MATCH_RUNGS_BY_ROUND` for why this exists. */
  forMatchRound: (roundN: number) => ToolDefinition[];
  /** Derived per narrative loop and role — see `NARRATIVE_PROFILES`. */
  forNarrativeRole: (loop: NarrativeLoop, role: NarrativeRole) => ToolDefinition[];
  digest: (tools: readonly ToolDefinition[]) => { names: string[]; hash: string };
};

export type NarrativeLoop = 'assess' | 'recommend';
export type NarrativeRole = 'proposer' | 'evaluator';

/**
 * The Assessment and Recommendation loops, by role (SPEC §10.3, §15.3).
 *
 * **The evaluator reads what the proposer read**, so the read list is written
 * once and both roles are derived from it. It used to be a `.filter()` at each
 * call site removing the proposer's submit, which is the same list stated twice
 * — and the asymmetry that matters is not what they can see (finding 76: a
 * verifier weaker than the thing it verifies measures its own window) but what
 * they can write. Each role gets exactly one write, and they are different
 * writes: the proposer submits the document, the evaluator submits its verdict
 * on it.
 *
 * The digest sizes SPEC §15.3 names are unchanged by this — assess is five
 * tools for either role, recommend is six — because a role trades one submit
 * for the other rather than gaining a tool.
 */
const NARRATIVE_READS: Record<NarrativeLoop, readonly string[]> = {
  assess: ['get_supplier', 'get_supplier_family', 'get_assessment_brief', 'get_entity'],
  recommend: [
    'get_shortlist',
    'get_supplier',
    'get_supplier_family',
    'get_recommendation_brief',
    'get_category',
  ],
};

/** The one write each role holds. `submit_evaluation` is shared by both evaluators. */
const NARRATIVE_WRITES: Record<NarrativeLoop, Record<NarrativeRole, string>> = {
  assess: { proposer: 'submit_assessment', evaluator: 'submit_evaluation' },
  recommend: { proposer: 'submit_recommendation', evaluator: 'submit_evaluation' },
};

export const NARRATIVE_PROFILES: Record<NarrativeLoop, Record<NarrativeRole, string[]>> = {
  assess: {
    proposer: [...NARRATIVE_READS.assess, NARRATIVE_WRITES.assess.proposer],
    evaluator: [...NARRATIVE_READS.assess, NARRATIVE_WRITES.assess.evaluator],
  },
  recommend: {
    proposer: [...NARRATIVE_READS.recommend, NARRATIVE_WRITES.recommend.proposer],
    evaluator: [...NARRATIVE_READS.recommend, NARRATIVE_WRITES.recommend.evaluator],
  },
};

/**
 * The Match query rungs, **by Round** (SPEC §6.5).
 *
 * Round 1 offers R2 only; Rounds 2 and 3 offer the three R3 tools. So *"the
 * resolver called an R3 tool before the R2 one"* is **unrepresentable** rather
 * than tested for — and a fixture could only ever have proved that the
 * *recorded model* ordered its rungs correctly, which proves nothing about the
 * code.
 */
export const MATCH_RUNGS_BY_ROUND: Record<number, string[]> = {
  1: ['find_candidates_by_name_town'],
  2: ['find_candidates_by_address', 'find_lei_by_name', 'join_lei'],
  3: ['find_candidates_by_address', 'find_lei_by_name', 'join_lei'],
};

/** Tools every Match Round offers, whatever rung is available. */
const MATCH_COMMON_TOOLS = [
  'get_supplier',
  'sayari_get_entity',
  'sayari_get_record',
  'submit_match_proposal',
  'submit_match_verdict',
];

/**
 * The Dossier profile is **six**, not the "~5" originally estimated
 * (SPEC §15.3).
 *
 * The sixth — `sayari_get_record` — is load-bearing: Citations must resolve to
 * a **live local row**, and a record id seen inside `entity.attributes[].record`
 * has no local `record` row unless something fetched it. On five tools a
 * Dossier could only cite at entity granularity, while it is promised as
 * *cited like an Assessment*.
 */
export const DOSSIER_PROFILE = [
  'get_supplier',
  'sayari_get_entity',
  'sayari_get_record',
  'sayari_traversal',
  'sayari_negative_news',
  'submit_dossier',
] as const;

const NAME_SCHEME =
  /^(get|list|compare|find|join|submit|enqueue|navigate|sayari|gleif|worldbank|usitc|nominatim)_[a-z0-9_]+$/;

class RegistryError extends Error {
  constructor(problems: string[]) {
    super(
      [
        'Refusing to boot — the tool registry is not legal.',
        '',
        ...problems.map((p) => `  · ${p}`),
        '',
        '  These are boot invariants (SPEC §15.5). Each one exists because the',
        '  failure it prevents is a tool added later without thinking about it.',
      ].join('\n'),
    );
    this.name = 'RegistryError';
  }
}

/**
 * Validates and derives. Call once at boot, beside the prompt manifest.
 *
 * `registry.test.ts` exists to assert that this **rejects**, not to re-check
 * each tool — a test that re-listed the tools would go stale beside them.
 */
export function finalizeRegistry(tools: readonly ToolDefinition[]): Registry {
  const problems: string[] = [];
  const byName = new Map<string, ToolDefinition>();

  checkEachTool(tools, byName, problems);
  checkDossierProfile(byName, problems);
  checkRoundRungs(byName, problems);
  checkNarrativeProfiles(byName, problems);

  if (problems.length > 0) throw new RegistryError(problems);

  const warnings = enqueueKindWarnings(tools);
  for (const warning of warnings) console.warn(`[registry] ${warning}`);

  return { ...buildRegistry(tools, byName), warnings };
}

/**
 * 12. **Every `enqueue_*` tool names a Job kind a worker can run.**
 *
 * Chat can propose `enqueue_deep_traversal` (kind `traverse`) and
 * `enqueue_dossier` (kind `dossier`), and the worker registered a handler for
 * neither. So an accepted proposal — a person reading an estimate and pressing
 * a button — produced a Job that dequeued and failed with *"no handler
 * registered for job kind"*. The confirm gate's whole claim is that a spend is
 * a person's act; a button that cannot work is worse than no button.
 *
 * **It is now down to one.** The Deep Traversal handler has landed and
 * `traverse` is in `RUNNABLE_JOB_KINDS`, so `enqueue_deep_traversal` no longer
 * warns — which is the whole point of a warning that names its tools rather
 * than counting them.
 *
 * **A warning, not a refusal, and only for now.** Every other invariant here
 * throws, which is what makes them invariants. This one cannot yet:
 * `enqueue_dossier` is in the catalog today, so throwing would refuse to boot
 * the application rather than the mistake — and *removing* it from chat changes
 * the tool list in the recorded chat request, which reddens `chat/one-turn` for
 * a reason that is not drift. It becomes a refusal the moment `dossier` is
 * either handled or withdrawn.
 */
function enqueueKindWarnings(tools: readonly ToolDefinition[]): string[] {
  const runnable = new Set<string>(RUNNABLE_JOB_KINDS);
  return tools
    .filter((tool) => tool.enqueues !== undefined && !runnable.has(tool.enqueues))
    .map(
      (tool) =>
        `"${tool.name}" enqueues job kind "${tool.enqueues!}", which no worker handler runs — ` +
        `an accepted proposal would fail with "no handler registered". Runnable kinds: ${[...runnable].join(', ')}.`,
    );
}

function checkEachTool(
  tools: readonly ToolDefinition[],
  byName: Map<string, ToolDefinition>,
  problems: string[],
): void {
  for (const tool of tools) {
    // 1. Names are unique.
    if (byName.has(tool.name)) problems.push(`duplicate tool name "${tool.name}"`);
    byName.set(tool.name, tool);

    // 2. Names match the scheme.
    if (!NAME_SCHEME.test(tool.name)) {
      problems.push(
        `"${tool.name}" does not match the naming scheme (source-prefixed for raw lookups, effect-prefixed otherwise)`,
      );
    }

    const onChat = tool.surfaces.includes('chat');

    // 3. A chat-reachable write must be an enqueue_* AND confirm-gated —
    //    because chat proposes and never does.
    if (tool.effect === 'write' && onChat) {
      if (!tool.name.startsWith('enqueue_')) {
        problems.push(
          `"${tool.name}" writes and is reachable from chat, so it must be named enqueue_*`,
        );
      }
      if (!tool.confirm) {
        problems.push(
          `"${tool.name}" writes and is reachable from chat, so it must carry a confirm gate`,
        );
      }
    }

    // 4. Anything that spends and is reachable from chat is confirm-gated.
    if (tool.spends.length > 0 && onChat && !tool.confirm) {
      problems.push(
        `"${tool.name}" spends ${tool.spends.join('/')} and is reachable from chat, so it must carry a confirm gate`,
      );
    }

    // 5. A slow tool is barred from chat, whether or not it fans out.
    if (tool.latency === 'slow' && onChat) {
      problems.push(`"${tool.name}" is slow, so it may not be reachable from chat`);
    }

    // 6. A client-effect tool touches no row and belongs to chat alone.
    if (tool.effect === 'client' && (tool.surfaces.length !== 1 || !onChat)) {
      problems.push(`"${tool.name}" has effect 'client', so its surfaces must be exactly ["chat"]`);
    }

    // 7. Every submit_* is job-only, except submit_dossier which is mcp-only.
    if (tool.name.startsWith('submit_')) {
      const expected = tool.name === 'submit_dossier' ? ['mcp'] : ['job'];
      if (tool.surfaces.length !== expected.length || tool.surfaces[0] !== expected[0]) {
        problems.push(
          `"${tool.name}" must have surfaces exactly ${JSON.stringify(expected)}, so there is one path into a Match or an Assessment and it is owned by a Job`,
        );
      }
    }

    // 8. No write reaches MCP except submit_dossier.
    if (
      tool.effect === 'write' &&
      tool.surfaces.includes('mcp') &&
      tool.name !== 'submit_dossier'
    ) {
      problems.push(`"${tool.name}" writes and is exposed over MCP; only submit_dossier may be`);
    }

    // 9. An estimator no human ever sees is dead code.
    if (tool.confirm && !onChat) {
      problems.push(
        `"${tool.name}" carries a confirm gate but is not reachable from chat, so nobody would ever see it`,
      );
    }
  }
}

function checkDossierProfile(byName: Map<string, ToolDefinition>, problems: string[]): void {
  // 10. The Dossier profile is exactly six named tools, all present, all mcp.
  for (const name of DOSSIER_PROFILE) {
    const tool = byName.get(name);
    if (!tool) {
      problems.push(`the Dossier profile names "${name}", which is not in the registry`);
    } else if (!tool.surfaces.includes('mcp')) {
      problems.push(`the Dossier profile names "${name}", which does not carry the mcp surface`);
    }
  }
}

function checkRoundRungs(byName: Map<string, ToolDefinition>, problems: string[]): void {
  // 11. Every rung named per Round exists. (The lists themselves are derived
  //     below; this checks the names they are derived from.)
  for (const [round, rungs] of Object.entries(MATCH_RUNGS_BY_ROUND)) {
    for (const rung of rungs) {
      if (!byName.has(rung))
        problems.push(`Round ${round} names rung "${rung}", which is not in the registry`);
    }
  }
  for (const name of MATCH_COMMON_TOOLS) {
    if (!byName.has(name))
      problems.push(`the Match loop needs "${name}", which is not in the registry`);
  }
}

/**
 * The narrative profiles name real tools, and **`submit_evaluation` appears in
 * exactly the two evaluator lists**.
 *
 * The second half is the one worth checking at boot. A verdict tool that leaked
 * into a proposer profile would let the writer grade itself; one that leaked
 * into the Match or Dossier profiles would offer a rubric to a loop that has
 * none. Invariant 7 already keeps every `submit_*` off chat, so what is left to
 * state is *which Job may reach this one*, and that is a quantification over
 * lists a linter cannot see.
 */
function checkNarrativeProfiles(byName: Map<string, ToolDefinition>, problems: string[]): void {
  const holders: string[] = [];
  for (const [loop, roles] of Object.entries(NARRATIVE_PROFILES)) {
    for (const [role, names] of Object.entries(roles)) {
      for (const name of names) {
        if (!byName.has(name)) {
          problems.push(
            `the ${loop} ${role} profile names "${name}", which is not in the registry`,
          );
        }
        if (name === 'submit_evaluation') holders.push(`${loop} ${role}`);
      }
    }
  }

  const otherProfiles = [
    ...DOSSIER_PROFILE,
    ...MATCH_COMMON_TOOLS,
    ...Object.values(MATCH_RUNGS_BY_ROUND).flat(),
  ];
  if (otherProfiles.includes('submit_evaluation')) {
    problems.push(
      '"submit_evaluation" is offered outside the two evaluator profiles; only an evaluator returns a rubric verdict',
    );
  }
  if (holders.length !== 2 || !holders.every((h) => h.endsWith('evaluator'))) {
    problems.push(
      `"submit_evaluation" must appear in exactly the two evaluator profiles, and appears in: ${holders.join(', ') || 'none'}`,
    );
  }
}

function buildRegistry(
  tools: readonly ToolDefinition[],
  byName: Map<string, ToolDefinition>,
): Omit<Registry, 'warnings'> {
  const digest = (subset: readonly ToolDefinition[]) => {
    // Sorted by name, because the tool list is the very front of the cached
    // prefix and a set-ordering wobble at position 0 invalidates everything.
    const sorted = [...subset].sort((a, b) => a.name.localeCompare(b.name));
    const names = sorted.map((t) => t.name);
    const hash = createHash('sha256')
      .update(JSON.stringify(sorted.map((t) => ({ name: t.name, description: t.description }))))
      .digest('hex');
    return { names, hash };
  };

  return {
    all: [...tools],
    byName,
    // DERIVED. There is no parameter here a caller could get wrong.
    forSurface: (surface) => tools.filter((t) => t.surfaces.includes(surface)),
    forMatchRound: (roundN) => {
      const rungs = new Set([...(MATCH_RUNGS_BY_ROUND[roundN] ?? []), ...MATCH_COMMON_TOOLS]);
      return tools.filter((t) => rungs.has(t.name));
    },
    /**
     * **In profile order, not registry order.** The tool list is prompt bytes:
     * the request body carries it as written, so a list assembled by filtering
     * the catalog would reorder the moment a tool was added anywhere above it.
     */
    forNarrativeRole: (loop, role) =>
      NARRATIVE_PROFILES[loop][role].map((name) => byName.get(name)!),
    digest,
  };
}
