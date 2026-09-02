import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import * as t from '@/db/schema';
import { readSubmission } from '@/jobs/submission';
import { toRunnableTool } from '@/model/tool-adapter';
import { getRegistry } from '@/tools';
import { JOB_CAPS } from '@/config/constants';
import { getTestDb, testDatabaseIsUp } from '../support/test-db';
import { seededProgram } from '../support/seeded-program';

/**
 * How a `submit_*` payload is read (SPEC §15.4, finding 21).
 *
 * The agents propose and our code settles, so the payload comes out of the
 * message rather than the tool's `run()`. Two things about that read were
 * wrong, and both are here: it took the **first** submission when a corrected
 * one comes second, and it ran **no schema** at all, because the SDK's own
 * parse had already refused the payload before `run()` — inside a `try` that
 * turns the failure into a tool result the model sees and we did not.
 */

const goodDraft = {
  verdict: 'recommend',
  sentences: [
    {
      section: 'identity',
      text: 'A sentence with a citation.',
      citations: [{ entityId: 'CX3012yTGIhgMxcZG6hgnA' }],
    },
  ],
};

describe('readSubmission', () => {
  it('takes the LAST submission, because a corrected one comes second', () => {
    const read = readSubmission<typeof goodDraft>(
      [
        { name: 'get_supplier', input: { supplierId: 'x' } },
        // Refused by the SDK's parse: `run()` never saw it, and the model was
        // told. What follows is its answer to that.
        { name: 'submit_assessment', input: { verdict: 'recommend', sentences: [] } },
        { name: 'submit_assessment', input: goodDraft },
      ],
      'submit_assessment',
    );

    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value.sentences).toHaveLength(1);
  });

  it('reports a payload the schema rejects as the issue list, in the model’s field names', () => {
    const read = readSubmission(
      [{ name: 'submit_assessment', input: { verdict: 'maybe' } }],
      'submit_assessment',
    );

    expect(read.ok).toBe(false);
    if (read.ok) return;
    // A refinement failure: the model mis-shaped its output, which it can fix
    // on being told — so the message has to name the field.
    expect(read.message).toContain('verdict');
    expect(read.message).toContain('sentences');
  });

  it('says which tools were called when the submit tool was not one of them', () => {
    const read = readSubmission([{ name: 'get_shortlist', input: {} }], 'submit_recommendation');
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.message).toContain('get_shortlist');
  });
});

describe('a payload the SDK’s parse refuses', () => {
  it('is recorded on its trace row as a refusal, not left looking unfinished', async () => {
    if (!(await testDatabaseIsUp())) return;
    const db = await getTestDb();
    const program = await seededProgram(db);
    if (!program) return;

    const [run] = await db
      .insert(t.run)
      .values({ programId: program.id, state: 'running', trigger: 'test', subjectLabel: 'parse' })
      .returning({ id: t.run.id });
    const [job] = await db
      .insert(t.job)
      .values({
        runId: run!.id,
        kind: 'assess',
        subjectType: 'program',
        subjectId: program.id,
        state: 'running',
        toolCallCap: JOB_CAPS.assess.toolCalls,
        tokenCap: JOB_CAPS.assess.tokens,
      })
      .returning({ id: t.job.id });
    const [turn] = await db
      .insert(t.traceTurn)
      .values({
        jobId: job!.id,
        n: 1,
        request: {},
        response: '{}',
        ms: 0,
      })
      .returning({ id: t.traceTurn.id });

    // The row `runLoop` opens BEFORE a tool runs: input known, output not.
    const refused = { verdict: 'maybe' };
    await db.insert(t.traceToolCall).values({
      traceTurnId: turn!.id,
      toolUseId: 'toolu_parse_failure',
      toolName: 'submit_assessment',
      input: refused as never,
      ms: 0,
    });

    const tool = toRunnableTool(getRegistry().byName.get('submit_assessment')!, {
      db,
      upstream: {} as never,
      meter: { addModelTokens: () => {} },
      runId: run!.id,
      jobId: job!.id,
      surface: 'job',
    });

    // The runner calls `parse` before `run`, and re-raises what it throws.
    expect(() => tool.parse(refused)).toThrow();
    // The write is fire-and-forget inside `parse`, so let it land.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const row = await db.query.traceToolCall.findFirst({
      where: eq(t.traceToolCall.toolUseId, 'toolu_parse_failure'),
    });
    expect(row!.ok, 'a null ok reads as "called, and we do not have its result"').toBe(false);
    expect(JSON.stringify(row!.output)).toContain('sentences');
  });
});
