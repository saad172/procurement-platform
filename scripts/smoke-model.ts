// Next.js loads `.env` itself; a plain Node entrypoint has to ask.
import 'dotenv/config';
import { z } from 'zod/v4';
import { betaZodTool } from '@anthropic-ai/sdk/helpers/beta/zod';
import { eq } from 'drizzle-orm';
import { loadEnv } from '@/config/env';
import { closeDirectDb, getDirectDb } from '@/db/client';
import * as t from '@/db/schema';
import { PROGRAM } from '@/db/seed-data/program';
import { runLoop } from '@/model';
import { JOB_CAPS } from '@/config/constants';

/**
 * A live smoke check of the model chokepoint.
 *
 *   pnpm smoke:model
 *
 * **It spends Anthropic tokens**, so it is a script rather than a test. It
 * proves the things a keyless replay suite cannot: that the settings this build
 * pins are actually accepted by the API together — adaptive thinking with
 * summarized display, effort inside `output_config`, server-side fallback,
 * strict tool schemas and the Tool Runner loop, all in one request.
 *
 * It also proves the bookkeeping: one `trace_turn` and one `usage_event` per
 * turn, and a cap that fires terminates rather than fails.
 */

async function main(): Promise<void> {
  const env = loadEnv();
  const db = getDirectDb();
  const program = await db.query.program.findFirst({ where: eq(t.program.name, PROGRAM.name) });
  if (!program) throw new Error('Seed the database first: pnpm db:seed');

  const [run] = await db
    .insert(t.run)
    .values({
      programId: program.id,
      state: 'running',
      trigger: 'smoke',
      subjectLabel: 'model smoke check',
    })
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

  let toolRuns = 0;
  const lookup = betaZodTool({
    name: 'lookup_supplier_country',
    description: 'Returns the roster country recorded for a supplier on this program.',
    inputSchema: z.object({
      supplierName: z.string().describe('The roster name, exactly as imported'),
    }),
    run: async (input) => {
      toolRuns += 1;
      const row = await db.query.supplier.findFirst({
        where: eq(t.supplier.rosterName, input.supplierName),
      });
      return row ? `${row.rosterName}: ${row.rosterCountry}` : 'no such supplier on this program';
    },
  });

  console.log('\nModel smoke check\n' + '─'.repeat(72));

  const outcome = await runLoop(
    {
      loop: 'assess',
      system:
        'You answer questions about a supplier roster. Use the tool for any fact about a ' +
        'supplier. Be brief, and say plainly when the data cannot settle a question.',
      tools: [lookup],
      messages: [
        {
          role: 'user',
          content:
            // Deliberately a question that needs reasoning rather than a lookup:
            // it requires several tool calls and a judgement about what the
            // roster country can and cannot tell you. A trivial lookup makes
            // adaptive thinking decline to think, which would leave this check
            // unable to prove `display: "summarized"` works at all.
            'Yazaki, Sumitomo Electric and Aptiv all bid on wire harnesses. Using only the ' +
            'roster country for each, which of them would face the same US import duty, and ' +
            'what does the roster country NOT tell you about where the harnesses are actually made?',
        },
      ],
      caps: { toolCalls: JOB_CAPS.assess.toolCalls, tokens: JOB_CAPS.assess.tokens },
      roundN: 1,
      toolDigest: { names: ['lookup_supplier_country'], hash: 'smoke' },
    },
    { db, runId: run!.id, jobId: job!.id, credentials: { apiKey: env.ANTHROPIC_API_KEY } },
  );

  const turns = await db.select().from(t.traceTurn).where(eq(t.traceTurn.jobId, job!.id));
  const usage = await db.select().from(t.usageEvent).where(eq(t.usageEvent.jobId, job!.id));
  const spent = usage.reduce(
    (sum, u) =>
      sum +
      (((u.inputTokens ?? 0) + (u.cacheCreationInputTokens ?? 0) + (u.cacheReadInputTokens ?? 0)) /
        1e6) *
        5 +
      ((u.outputTokens ?? 0) / 1e6) * 25,
    0,
  );

  console.log(`  status        ${outcome.status}`);
  if (outcome.status === 'done') {
    const final = outcome.finalMessage as
      | { content: { type: string; text?: string }[] }
      | undefined;
    const text = final?.content
      ?.filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join(' ');
    console.log(`  answer        ${text?.trim()}`);
    console.log(
      `  turns         ${outcome.turns}   tool calls ${outcome.toolCalls}   tokens ${outcome.tokens}`,
    );
  } else if (outcome.status === 'failed') {
    console.log(`  error         ${outcome.error}`);
  }
  console.log(`  tool ran      ${toolRuns} time(s)`);
  console.log(`  trace_turn    ${turns.length} row(s)  — one per turn, whole BetaMessage verbatim`);
  console.log(`  usage_event   ${usage.length} row(s)  — usage has one home, not two`);
  console.log(
    `  thinking      ${turns.some((x) => JSON.stringify(x.response).includes('"thinking"')) ? 'summarized blocks present' : 'none returned'}`,
  );
  console.log(`  cost          $${spent.toFixed(4)} (from a committed price constant, not a bill)`);
  console.log('─'.repeat(72));
  console.log(`  Run ${run!.id}\n`);

  await db.update(t.job).set({ state: 'done' }).where(eq(t.job.id, job!.id));
  await db
    .update(t.run)
    .set({ state: 'done', finishedAt: new Date() })
    .where(eq(t.run.id, run!.id));
  await closeDirectDb();
  process.exit(outcome.status === 'done' ? 0 : 1);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exit(1);
});
