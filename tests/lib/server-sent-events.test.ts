import { describe, expect, it } from 'vitest';
import { parseServerSentEvents, readServerSentEvents } from '@/lib/server-sent-events';

/**
 * The parser exists for one failure: a chunk boundary landing mid-event.
 *
 * That failure is invisible on a fast local connection — every event arrives
 * whole — and truncates text in production. So the tests split events at
 * deliberately awkward places rather than feeding them in tidy pieces.
 */

/** Streams a string in fixed-size pieces, boundaries wherever they fall. */
function chunked(text: string, size: number): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) return controller.close();
      controller.enqueue(bytes.slice(offset, offset + size));
      offset += size;
    },
  });
}

const WIRE =
  'event: open\ndata: {"threadId":"t1"}\n\n' +
  'event: delta\ndata: "Yazaki "\n\n' +
  'event: delta\ndata: "is a match."\n\n' +
  'event: done\ndata: {"text":"Yazaki is a match."}\n\n';

describe('parseServerSentEvents', () => {
  it('dispatches only whole events and keeps the remainder', () => {
    const { events, rest } = parseServerSentEvents('event: a\ndata: 1\n\nevent: b\ndata: 2');
    expect(events).toEqual([{ event: 'a', data: '1' }]);
    // The unterminated second event stays buffered rather than being dispatched
    // half-formed — the whole point.
    expect(rest).toBe('event: b\ndata: 2');
  });

  it('defaults an unnamed event to "message"', () => {
    expect(parseServerSentEvents('data: hello\n\n').events).toEqual([
      { event: 'message', data: 'hello' },
    ]);
  });

  it('strips exactly one space after the colon', () => {
    // Two spaces means the second one is data. Stripping greedily would corrupt
    // indented JSON, which is a payload this app could plausibly send.
    expect(parseServerSentEvents('data:  padded\n\n').events[0]!.data).toBe(' padded');
  });

  it('joins multi-line data with newlines', () => {
    expect(parseServerSentEvents('data: one\ndata: two\n\n').events[0]!.data).toBe('one\ntwo');
  });

  it('normalises CRLF', () => {
    expect(parseServerSentEvents('event: a\r\ndata: 1\r\n\r\n').events).toEqual([
      { event: 'a', data: '1' },
    ]);
  });

  it('ignores a comment-only frame, which carries no data', () => {
    expect(parseServerSentEvents(': keep-alive\n\n').events).toEqual([]);
  });
});

describe('readServerSentEvents', () => {
  // One byte at a time is the harshest boundary there is: every event is split,
  // and so is every field name.
  it.each([1, 3, 7, 64, 4096])('reads the same events at chunk size %i', async (size) => {
    const seen: { event: string; data: string }[] = [];
    for await (const event of readServerSentEvents(chunked(WIRE, size))) seen.push(event);

    expect(seen.map((e) => e.event)).toEqual(['open', 'delta', 'delta', 'done']);
    expect(
      seen
        .filter((e) => e.event === 'delta')
        .map((e) => JSON.parse(e.data) as string)
        .join(''),
    ).toBe('Yazaki is a match.');
  });

  it('keeps a multi-byte character split across chunks intact', async () => {
    // 'é' is two bytes; a chunk size of 1 splits it. A decoder without
    // `{ stream: true }` yields a replacement character here.
    const wire = 'event: delta\ndata: "café — 支払"\n\n';
    const seen: string[] = [];
    for await (const event of readServerSentEvents(chunked(wire, 1))) {
      seen.push(JSON.parse(event.data) as string);
    }
    expect(seen).toEqual(['café — 支払']);
  });
});
