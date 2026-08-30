import { getPooledDb } from '@/db/client';
import { loadEnv } from '@/config/env';
import { runChatTurn, type ChatTurnRequest } from '@/chat/turn';

/**
 * The chat route handler (SPEC §14, §2.2).
 *
 * **A transport, and nothing else.** The turn itself lives in `@/chat/turn`, so
 * the path that a fixture records is the path that serves a person — a
 * recording taken from a script that re-created this setup by hand would prove
 * only that the script works.
 *
 * What is left here is the part that genuinely belongs to HTTP: reading the
 * request, writing Server-Sent Events, and the headers that keep a stream a
 * stream.
 *
 * **One in-flight turn per Thread.** The client disables its input while a turn
 * runs, so there is no interleaving to reason about.
 */

export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  const body = (await request.json()) as ChatTurnRequest;
  const env = loadEnv();
  const db = getPooledDb();

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };

      try {
        await runChatTurn(
          {
            db,
            upstreamCredentials: {
              sayariClientId: env.SAYARI_CLIENT_ID,
              sayariClientSecret: env.SAYARI_CLIENT_SECRET,
              nominatimUserAgent: env.NOMINATIM_USER_AGENT,
            },
            modelCredentials: { apiKey: env.ANTHROPIC_API_KEY },
          },
          body,
          send,
        );
      } catch (error) {
        /**
         * A throw would otherwise reach the client as a truncated stream, which
         * is indistinguishable from a dropped connection. Naming it is the
         * difference between "the app broke" and "the network did".
         */
        console.error('[chat] turn failed:', error);
        send('error', { message: error instanceof Error ? error.message : String(error) });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      // A proxy that buffers an SSE body turns streaming back into one late
      // response, silently — the symptom is a working app that feels broken.
      'x-accel-buffering': 'no',
    },
  });
}
