import { describe, expect, it, vi } from 'vitest';
import { evaluateWithVerdict, readVerdict, resultFrom, unreviewed } from '@/jobs/evaluation';
import { RUBRIC_ITEMS, type EvaluationPayload } from '@/tools';
import type { RunLoopOutcome } from '@/model';

/**
 * SPEC §10.3 — the evaluator's verdict.
 *
 * This replaces `parse-objections.test.ts`, which tested a regular expression
 * reading six item names and a leading "fail" out of a paragraph. That parse
 * decided **whether a Round is spent**, so every phrasing it had not
 * anticipated cost or saved a Round by accident — and the cases it needed
 * defending against ("caveats: pass … so this does not fail") were phrasings,
 * not judgements.
 *
 * A submitted verdict cannot be mis-read, so what is left to test is what the
 * code does **around** it: which verdicts become objections, and what happens
 * when the evaluator submits nothing at all.
 */

const verdict = (overrides: Partial<Record<string, string>> = {}): EvaluationPayload => ({
  items: RUBRIC_ITEMS.map((item) => ({
    item,
    verdict: (overrides[item] ?? 'pass') as 'pass' | 'fail' | 'unavailable',
    reasoning: `${item} reasoning`,
  })),
  summary: 'the draft holds up',
});

const done = (toolUses: { name: string; input: unknown }[]): RunLoopOutcome => ({
  status: 'done',
  finalMessage: {},
  toolUses,
  turns: 1,
  toolCalls: toolUses.length,
  tokens: 100,
});

describe('a fail is an objection; a pass and an unavailable are not', () => {
  it('passes when no item fails', () => {
    expect(resultFrom(verdict()).kind).toBe('pass');
  });

  it('does not object to unavailable — it is a verdict distinct from fail', () => {
    // The same distinction a Discriminator's "can't tell" carries: the real
    // company may simply have no LEI, and that is not evidence against it.
    expect(resultFrom(verdict({ support: 'unavailable', omission: 'unavailable' })).kind).toBe(
      'pass',
    );
  });

  it('carries the failed items’ reasoning lines forward, and only those', () => {
    const result = resultFrom(verdict({ strength: 'fail', caveats: 'fail' }));
    expect(result.kind).toBe('objections');
    expect(result.kind === 'objections' && result.objections).toEqual([
      'strength — strength reasoning',
      'caveats — caveats reasoning',
    ]);
  });

  it('stores the verdict itself as the round’s rubric, not a rendering of it', () => {
    // `round.rubric` is jsonb and documented as "the six rubric verdicts". It
    // used to hold `{ raw: <the whole reply> }`, which is a transcript.
    const result = resultFrom(verdict({ support: 'fail' }));
    expect(result.rubric).toEqual(verdict({ support: 'fail' }));
    expect(result.text).toContain('support — fail: support reasoning');
    expect(result.text).toContain('the draft holds up');
  });
});

describe('reading the submitted verdict', () => {
  it('takes the LAST submit_evaluation — an evaluator that submits twice has changed its mind', () => {
    const read = readVerdict(
      done([
        { name: 'get_supplier', input: {} },
        { name: 'submit_evaluation', input: verdict({ support: 'fail' }) },
        { name: 'submit_evaluation', input: verdict() },
      ]),
    );
    expect(read.ok).toBe(true);
    expect(read.ok && read.verdict.items.find((i) => i.item === 'support')?.verdict).toBe('pass');
  });

  it('refuses a verdict that names five of the six items', () => {
    const five = verdict();
    five.items = five.items.slice(0, 5);
    const read = readVerdict(done([{ name: 'submit_evaluation', input: five }]));
    expect(read.ok).toBe(false);
    expect(read.ok === false && read.problem).toMatch(/did not parse|names no/);
  });

  it('refuses a verdict that repeats one item and skips another', () => {
    // `strict: true` guarantees the array's length and every member's shape. It
    // cannot say that the six are the six.
    const repeated = verdict();
    repeated.items[0] = { ...repeated.items[1]! };
    const read = readVerdict(done([{ name: 'submit_evaluation', input: repeated }]));
    expect(read.ok).toBe(false);
    expect(read.ok === false && read.problem).toMatch(/names no support/);
  });

  it('names the tools that were called when none of them was the submit', () => {
    const read = readVerdict(done([{ name: 'get_assessment_brief', input: {} }]));
    expect(read.ok).toBe(false);
    expect(read.ok === false && read.problem).toMatch(/no submit_evaluation was called/);
    expect(read.ok === false && read.problem).toMatch(/get_assessment_brief/);
  });

  it('reports a loop that never finished as the loop failure it is', () => {
    const read = readVerdict({ status: 'failed', error: 'Connection error.' });
    expect(read.ok).toBe(false);
    expect(read.ok === false && read.problem).toMatch(/ended as failed: Connection error/);
  });
});

describe('an evaluator that produces no verdict', () => {
  it('retries once, free, and uses the second answer', async () => {
    const call = vi
      .fn<() => Promise<RunLoopOutcome>>()
      .mockResolvedValueOnce(done([]))
      .mockResolvedValueOnce(done([{ name: 'submit_evaluation', input: verdict() }]));

    const result = await evaluateWithVerdict(call);
    expect(call).toHaveBeenCalledTimes(2);
    expect(result.kind).toBe('pass');
  });

  it('gives up after the retry and records every item as unavailable', async () => {
    const call = vi.fn<() => Promise<RunLoopOutcome>>().mockResolvedValue(done([]));
    const result = await evaluateWithVerdict(call);

    expect(call).toHaveBeenCalledTimes(2);
    // NOT a pass. A draft nothing reviewed is not a draft that survived review,
    // and the difference is the whole reason the loop has two agents.
    expect(result.kind).toBe('objections');
    expect(result.kind === 'objections' && result.objections[0]).toMatch(
      /produced no verdict on this draft/,
    );
    const rubric = result.rubric as EvaluationPayload;
    expect(rubric.items).toHaveLength(RUBRIC_ITEMS.length);
    expect(rubric.items.every((item) => item.verdict === 'unavailable')).toBe(true);
  });

  it('says which failure it was, so the dissent line is readable', () => {
    const result = unreviewed('the loop ended as terminated: tool call ceiling');
    expect(result.kind === 'objections' && result.objections[0]).toContain('tool call ceiling');
  });
});
