import { describe, expect, it } from 'vitest';
import { z } from 'zod/v4';
import { defineTool } from '@/tools';
import { toRunnableTool, takeFatalToolError } from '@/model/tool-adapter';
import { toChatTools } from '@/model/chat-tools';
import { UpstreamCapExceededError, UpstreamError } from '@/upstream/errors';
import { getTestDb, testDatabaseIsUp } from '../support/test-db';

/**
 * What a model is told when an upstream source fails (SPEC §16.3).
 *
 * `src/tools/catalog/lookups.ts` carries no `try` of its own, so a 429, a
 * timeout or a 5xx reached the model as the SDK's `Error: <message>` string —
 * the runner catches anything a tool throws into an `is_error` tool result, so
 * *"every other kind throws"* never stopped a loop; it only made the sentence
 * worse. These pin the sentence, and pin which failures are **not** given one.
 */

function throwingTool(error: unknown) {
  return defineTool({
    name: 'sayari_get_entity',
    description: 'Fetch one entity.',
    input: z.object({ entityId: z.string() }),
    surfaces: ['job'],
    effect: 'read',
    spends: ['sayari'],
    latency: 'fast',
    handler: async () => {
      throw error;
    },
  });
}

const rateLimited = new UpstreamError({
  kind: 'rate_limit',
  source: 'sayari',
  endpoint: 'entity.getEntity',
  message: 'HTTP 429',
});

const brokenCredentials = new UpstreamError({
  kind: 'auth',
  source: 'sayari',
  endpoint: 'entity.getEntity',
  message: 'HTTP 401',
});

async function ctx() {
  const db = await getTestDb();
  return {
    db,
    upstream: {} as never,
    meter: { addModelTokens: () => {} },
    runId: '00000000-0000-0000-0000-000000000000',
    surface: 'job' as const,
  };
}

describe('a source that did not answer', () => {
  it('is a sentence naming source, endpoint and kind — not a stack', async () => {
    if (!(await testDatabaseIsUp())) return;
    const tool = toRunnableTool(throwingTool(rateLimited), await ctx());

    const result = await tool.run({ entityId: 'x' } as never);
    const text = JSON.stringify(result);
    expect(text).toContain('This did not work. The reasons, verbatim:');
    expect(text).toContain('sayari');
    expect(text).toContain('entity.getEntity');
    expect(text).toContain('rate_limit');
  });

  it('is told to chat in the same shape, because a person asked the question', async () => {
    if (!(await testDatabaseIsUp())) return;
    const [tool] = toChatTools([throwingTool(rateLimited)], await ctx(), {
      onProposal: () => {},
      onResult: () => {},
    });

    const result = await tool!.run({ entityId: 'x' } as never);
    expect(JSON.stringify(result)).toContain('did not answer: rate_limit');
  });

  it('is NOT given a sentence when only we can fix it', async () => {
    if (!(await testDatabaseIsUp())) return;
    const tool = toRunnableTool(throwingTool(brokenCredentials), await ctx());

    // A 401 is our credentials. Telling a model to work around them is asking
    // it to invent an answer, so the throw stands.
    await expect(tool.run({ entityId: 'x' } as never)).rejects.toThrow('HTTP 401');
  });
});

describe('the Job’s own upstream ceiling', () => {
  it('is filed for the loop rather than offered to the model as a workaround', async () => {
    if (!(await testDatabaseIsUp())) return;
    const jobId = '11111111-1111-1111-1111-111111111111';
    const capped = new UpstreamCapExceededError(jobId, 25, 'entity.getEntity');
    const tool = toRunnableTool(throwingTool(capped), { ...(await ctx()), jobId });

    // It still throws, because the runner is going to be stopped anyway — what
    // matters is that the ceiling is now visible to the loop that must stop.
    await expect(tool.run({ entityId: 'x' } as never)).rejects.toThrow('25-upstream-call ceiling');

    const filed = takeFatalToolError(jobId);
    expect(filed?.message).toContain('25-upstream-call ceiling');
    // Taken once: a second loop must not inherit the first one's ceiling.
    expect(takeFatalToolError(jobId)).toBeUndefined();
  });
});
