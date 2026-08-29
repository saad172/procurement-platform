import { finalizeRegistry, type Registry } from './registry';
import { OTHER_READS, PAGE_READS } from './catalog/reads';
import { MATCH_RUNG_TOOLS, RAW_LOOKUPS } from './catalog/lookups';
import { AGENT_WRITES } from './catalog/writes';
import { CLIENT_TOOLS, EXTRA_READS, JOB_STARTS } from './catalog/enqueues';

/**
 * The tool catalog, in seven families (SPEC §15.2).
 *
 * | Family              | Shape                                              |
 * |---------------------|----------------------------------------------------|
 * | 1. Page reads       | thin wrappers over the query each page runs for SSR |
 * | 2. Reads no page owns | the shortlist, comparisons, traces, usage         |
 * | 3. Match rung tools | job-only, **the query baked in** so a Trace records *which* rung ran |
 * | 4. Raw lookups      | source-prefixed, for chat and the stdio MCP user   |
 * | 5. Agent writes     | schema-enforced structures, never prose            |
 * | 6. Job starts       | chat-only, confirm required — chat proposes, never does |
 * | 7. Client           | `navigate_to`, which renders a link                |
 *
 * **No caller sees all of them.** Every per-surface and per-Round list is
 * derived by `finalizeRegistry()`, never hand-written.
 */
export const ALL_TOOLS = [
  ...PAGE_READS,
  ...OTHER_READS,
  ...MATCH_RUNG_TOOLS,
  ...RAW_LOOKUPS,
  ...AGENT_WRITES,
  ...JOB_STARTS,
  ...CLIENT_TOOLS,
  ...EXTRA_READS,
];

let registry: Registry | undefined;

/** Built once at boot; throws with every problem named if the catalog is illegal. */
export function getRegistry(): Registry {
  if (!registry) registry = finalizeRegistry(ALL_TOOLS);
  return registry;
}

export function resetRegistryForTesting(): void {
  registry = undefined;
}

export { finalizeRegistry, DOSSIER_PROFILE, MATCH_RUNGS_BY_ROUND } from './registry';
export type { Registry } from './registry';
export { defineTool } from './define';
export type {
  Estimate,
  ReadWithWidget,
  ToolContext,
  ToolDefinition,
  ToolEffect,
  ToolLatency,
  ToolResult,
  ToolSpend,
  ToolSurface,
  Widget,
  WidgetType,
} from './define';
