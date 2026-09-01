/**
 * A minimal Server-Sent Events reader.
 *
 * Written rather than pulled in because the whole of what this app needs is
 * below — a named event and a JSON payload — and the dependency would be
 * larger than the parser.
 *
 * **The bug this exists to not have:** a `ReadableStream` chunk boundary falls
 * wherever the network puts it, which is routinely in the middle of an event.
 * Parsing each chunk on its own works on a fast local connection and truncates
 * text in production. So bytes accumulate in a buffer and only whole events —
 * those terminated by a blank line — are dispatched; the remainder stays
 * buffered for the next chunk.
 */

export type ServerSentEvent = { event: string; data: string };

/** Splits a buffer into whole events, returning the unterminated remainder. */
export function parseServerSentEvents(buffer: string): {
  events: ServerSentEvent[];
  rest: string;
} {
  const events: ServerSentEvent[] = [];

  // `\n\n` terminates an event. A CRLF stream is normalised first so the split
  // does not depend on which line ending the server happened to write.
  const normalised = buffer.replace(/\r\n/g, '\n');
  const parts = normalised.split('\n\n');

  // The last part is either empty (the buffer ended on a boundary) or a partial
  // event. Either way it is not ours to dispatch yet.
  const rest = parts.pop() ?? '';

  for (const part of parts) {
    let event = 'message';
    const dataLines: string[] = [];
    for (const line of part.split('\n')) {
      if (line.startsWith('event:')) event = line.slice('event:'.length).trim();
      // Per the spec a single leading space after the colon is part of the
      // delimiter, not the data — dropping more would corrupt indented JSON.
      else if (line.startsWith('data:'))
        dataLines.push(line.slice('data:'.length).replace(/^ /, ''));
    }
    if (dataLines.length > 0) events.push({ event, data: dataLines.join('\n') });
  }

  return { events, rest };
}

/**
 * Reads a response body as a sequence of events.
 *
 * An async generator rather than a callback, so the caller's `for await` loop
 * is where the handling lives and a `break` really stops reading.
 */
export async function* readServerSentEvents(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<ServerSentEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      // `stream: true` keeps a multi-byte character split across chunks intact.
      buffer += decoder.decode(value, { stream: true });
      const { events, rest } = parseServerSentEvents(buffer);
      buffer = rest;
      for (const event of events) yield event;
    }
  } finally {
    reader.releaseLock();
  }
}
