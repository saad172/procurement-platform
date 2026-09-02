import { describe, expect, it } from 'vitest';
import { z } from 'zod/v4';
import { betaZodTool } from '@anthropic-ai/sdk/helpers/beta/zod';
import * as t from '@/db/schema';
import { runLoop } from '@/model';
import { resetAnthropicClients } from '@/model/client';
import { JOB_CAPS } from '@/config/constants';
import { getTestDb, testDatabaseIsUp } from '../support/test-db';
import { seededProgram } from '../support/seeded-program';

/**
 * The prompt-cache layout, asserted over **the body actually sent** (SPEC
 * §17.4).
 *
 * The previous version of this file tested three exported helpers — a tool
 * sorter, a Round-boundary marker and a page block — none of which had a caller
 * anywhere in `src/`. They passed for as long as they existed while
 * `cache_read_input_tokens` was zero on every turn of every Job the build ever
 * ran: **a layout nothing applies is not a layout**, and a test of it is a test
 * that cannot fail for the reason it exists.
 *
 * So this drives the real `runLoop` through a canned `fetch` and reads the
 * request off the wire.
 */

function capturingFetch(): { fetch: typeof fetch; bodies: string[] } {
  const bodies: string[] = [];
  const fetchImpl = (async (_input: unknown, init?: { body?: unknown }) => {
    if (typeof init?.body === 'string') bodies.push(init.body);
    return new Response(
      JSON.stringify({
        id: 'msg_cache_layout',
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-5',
        content: [{ type: 'text', text: 'done' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as unknown as typeof fetch;
  return { fetch: fetchImpl, bodies };
}

const tool = (name: string) =>
  betaZodTool({
    name,
    description: `Does ${name}.`,
    inputSchema: z.object({}),
    run: async () => 'nothing',
  });

async function sentBody(): Promise<{
  tools: { name: string; cache_control?: unknown }[];
  cache_control?: unknown;
}> {
  const db = await getTestDb();
  const program = await seededProgram(db);
  const [run] = await db
    .insert(t.run)
    .values({ programId: program!.id, state: 'running', trigger: 'test', subjectLabel: 'cache' })
    .returning({ id: t.run.id });

  resetAnthropicClients();
  const capture = capturingFetch();
  await runLoop(
    {
      loop: 'assess',
      system: 'A frozen system prompt.',
      // Deliberately NOT in name order: the digest order is what is sent.
      tools: [tool('get_zebra'), tool('get_apple')],
      messages: [{ role: 'user', content: 'A question.' }],
      caps: JOB_CAPS.assess,
    },
    { db, runId: run!.id, credentials: { apiKey: 'not-a-key', fetch: capture.fetch } },
  );

  return JSON.parse(capture.bodies[0]!) as never;
}

describe('the request carries two cache markers', () => {
  it('breaks the static prefix on the LAST tool definition', async () => {
    if (!(await testDatabaseIsUp())) return;
    const body = await sentBody();

    expect(body.tools.at(-1)!.cache_control).toEqual({ type: 'ephemeral' });
    expect(body.tools[0]!.cache_control).toBeUndefined();
  });

  it('carries the tail with top-level cache_control', async () => {
    if (!(await testDatabaseIsUp())) return;
    const body = await sentBody();

    // It marks the last cacheable block automatically, which is what lets the
    // growing end of a conversation cache without this layer knowing where a
    // Round boundary falls.
    expect(body.cache_control).toEqual({ type: 'ephemeral' });
  });

  it('does not re-order the tool list to get the breakpoint', async () => {
    if (!(await testDatabaseIsUp())) return;
    const body = await sentBody();

    // `finalizeRegistry()`'s digest order is already deterministic. Sorting here
    // would change the bytes of every recorded request for a cache nobody was
    // getting.
    expect(body.tools.map((each) => each.name)).toEqual(['get_zebra', 'get_apple']);
  });
});
