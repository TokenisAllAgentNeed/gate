/**
 * Mock upstream LLM server for E2E tests.
 *
 * Supports multiple behaviors based on model name:
 * - "mock-ok" / default: returns a JSON chat completion
 * - "mock-500": returns 500 error
 * - "mock-timeout": hangs for 30s (simulates upstream timeout)
 * - "mock-stream" / body.stream=true: returns SSE stream
 */
import { Hono } from "hono";
import { stream as honoStream } from "hono/streaming";

const enc = (s: string) => new TextEncoder().encode(s);

export function createMockUpstream(): Hono {
  const mock = new Hono();

  mock.post("/v1/chat/completions", async (c) => {
    const body = await c.req.json();
    const model = body.model as string;

    if (model === "mock-500") {
      return c.json({ error: { message: "Internal Server Error" } }, 500);
    }

    if (model === "mock-timeout") {
      await new Promise((r) => setTimeout(r, 30_000));
      return c.json({ error: { message: "Should not reach here" } }, 500);
    }

    if (model === "mock-stream" || body.stream === true) {
      c.header("Content-Type", "text/event-stream");
      c.header("Cache-Control", "no-cache");
      return honoStream(c, async (s) => {
        const encoder = new TextEncoder();
        await s.write(
          encoder.encode(
            'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n'
          )
        );
        await s.write(
          encoder.encode(
            'data: {"choices":[{"delta":{"content":" world"}}]}\n\n'
          )
        );
        await s.write(encoder.encode("data: [DONE]\n\n"));
      });
    }

    return c.json({
      id: "chatcmpl-mock-123",
      object: "chat.completion",
      created: Date.now(),
      model,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "Hello from mock!" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });
  });

  return mock;
}
