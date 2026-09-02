import { describe, expect, it } from 'vitest';
import {
  MARK_BUTTON_LABEL,
  RECOMMENDATION_MARKS,
  markHeader,
  markTone,
  markWord,
  newerVersionStrip,
  pinnedVersionStrip,
} from '@/domain/recommendation-mark';

/**
 * The words a Recommendation's human mark is said in (CONTEXT.md: *Versioned; a
 * person marks it accepted, rejected or needs work*, and SPEC §12.5).
 *
 * Three surfaces render this fact — the Recommendation page's header, the
 * Category page's *argued case* card, and the Category answer — so the wording
 * is one function and this is where it is pinned. What is asserted here is not
 * prose for its own sake: each mark's second sentence is the one thing a reader
 * could otherwise get wrong about it.
 */

describe('the header says what a person decided, and when', () => {
  it('says nobody has marked it, rather than showing nothing', () => {
    // An empty header reads as "no mark exists here", which is a different
    // claim from "nobody has made one yet".
    const header = markHeader({ mark: null, markedAt: null, versionN: 3 });
    expect(header.badge).toBe('unmarked');
    expect(header.tone).toBe('mute');
    expect(header.line).toMatch(/^Nobody has marked version 3\./);
    expect(header.line).toMatch(/accepted, rejected or needs work/);
  });

  it('dates an acceptance and says acceptance never moves', () => {
    const header = markHeader({
      mark: 'accepted',
      markedAt: new Date('2026-09-02T10:15:00Z'),
      versionN: 1,
    });
    expect(header.badge).toBe('accepted by a person');
    expect(header.tone).toBe('good');
    expect(header.line).toBe(
      'A person accepted version 1 on 2026-09-02. ' +
        'Acceptance never moves: a re-run writes a new version and never clears this mark, ' +
        'so this page keeps showing what was accepted until somebody accepts something else.',
    );
  });

  it('says a rejection changed nothing about the document', () => {
    const header = markHeader({
      mark: 'rejected',
      markedAt: new Date('2026-09-02T10:15:00Z'),
      versionN: 2,
    });
    expect(header.tone).toBe('bad');
    expect(header.line).toMatch(/no sentence, no pick and no citation/);
  });

  it('says needs work writes no version, because a re-run does', () => {
    // SPEC §10.6: "A human's *needs work* does not create a version — a re-run
    // does." A reader who expects the click to re-argue the case is a reader
    // who thinks the app is thinking when it is not.
    const header = markHeader({
      mark: 'needs_work',
      markedAt: new Date('2026-09-02T10:15:00Z'),
      versionN: 2,
    });
    expect(header.tone).toBe('warn');
    expect(header.line).toMatch(/Needs work writes no version; a re-run does/);
  });

  it('names the mark without a date when there is none', () => {
    // A version marked before `human_marked_at` was recorded still has a mark,
    // and a header that invented a date for it would be inventing evidence.
    const header = markHeader({ mark: 'accepted', markedAt: null, versionN: 1 });
    expect(header.line).toMatch(/^A person accepted version 1\. /);
    expect(header.line).not.toMatch(/ on \d/);
  });
});

describe('the three marks are CONTEXT’s three words', () => {
  it('offers exactly accepted, rejected and needs work', () => {
    expect([...RECOMMENDATION_MARKS]).toEqual(['accepted', 'rejected', 'needs_work']);
    expect(RECOMMENDATION_MARKS.map(markWord)).toEqual(['accepted', 'rejected', 'needs work']);
  });

  it('labels each button as something a person does', () => {
    expect(RECOMMENDATION_MARKS.map((mark) => MARK_BUTTON_LABEL[mark])).toEqual([
      'Accept',
      'Reject',
      'Needs work',
    ]);
  });

  it('gives an unmarked version the mute tone rather than a colour', () => {
    expect(markTone(null)).toBe('mute');
    expect(markTone('accepted')).toBe('good');
    expect(markTone('rejected')).toBe('bad');
    expect(markTone('needs_work')).toBe('warn');
  });
});

describe('the strip that says which version is on screen', () => {
  it('names the newer sibling and why it is not what you are reading', () => {
    const strip = newerVersionStrip({ shownN: 1, latestN: 2, newer: 1 });
    expect(strip.said).toBe(
      'A newer version exists: version 2 was written after version 1 was accepted.',
    );
    expect(strip.because).toMatch(/Acceptance never moves/);
  });

  it('counts them, because two is different news from one', () => {
    const strip = newerVersionStrip({ shownN: 1, latestN: 3, newer: 2 });
    expect(strip.said).toMatch(/^2 newer versions exist, the most recent being version 3/);
  });

  it('says a pinned version is not the accepted one, and what accepting it would do', () => {
    const strip = pinnedVersionStrip({ viewingN: 2, defaultN: 1, defaultMark: 'accepted' });
    expect(strip.said).toMatch(/not the version this page shows by default/);
    expect(strip.because).toMatch(/clears the acceptance from version 1/);
  });

  it('says the default is merely the latest when nobody has accepted anything', () => {
    const strip = pinnedVersionStrip({ viewingN: 1, defaultN: 3, defaultMark: null });
    expect(strip.because).toMatch(/the latest is what this page shows when nobody has accepted/);
  });
});
