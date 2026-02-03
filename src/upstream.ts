/**
 * Upstream LLM router — resolves a model name to an upstream config
 * and proxies requests (including SSE streaming).
 */

export interface UpstreamEntry {
  /** Prefix or exact model name. Use "*" as catch-all. */
  match: string;
  /** Base URL (no trailing slash) */
  baseUrl: string;
  /** Bearer token for Authorization header */
  apiKey: string;
  /** Optional: rewrite model name before sending upstream */
  modelRewrite?: (model: string) => string;
}

/**
 * Find the upstream entry for a given model name.
 * Matching order: exact match > prefix match > wildcard "*"
 */
export function resolveUpstream(
  model: string,
  entries: UpstreamEntry[]
): UpstreamEntry | null {
  // Exact match first
  const exact = entries.find((e) => e.match === model);
  if (exact) return exact;

  // Prefix match (e.g. "gpt-" matches "gpt-4o-mini")
  const prefix = entries.find(
    (e) => e.match !== "*" && e.match.endsWith("*") && model.startsWith(e.match.slice(0, -1))
  );
  if (prefix) return prefix;

  // Wildcard catch-all
  const wildcard = entries.find((e) => e.match === "*");
  return wildcard ?? null;
}

/** OpenAI-compatible chat completion request body */
export interface ChatCompletionRequest {
  model: string;
  messages: Array<{ role: string; content: string | null }>;
  stream?: boolean;
  max_tokens?: number;
  temperature?: number;
  [key: string]: unknown;
}

export interface ProxyResult {
  /** HTTP status from upstream */
  status: number;
  /** Response headers to forward */
  headers: Record<string, string>;
  /** For non-streaming: parsed JSON body */
  body?: Record<string, unknown>;
  /** For streaming: ReadableStream to pipe */
  stream?: ReadableStream<Uint8Array>;
  /** Whether this is a streaming response */
  isStream: boolean;
}

/**
 * Proxy a chat completions request to the upstream LLM.
 * Supports both regular JSON and SSE streaming responses.
 */
export async function proxyToUpstream(
  upstream: UpstreamEntry,
  requestBody: ChatCompletionRequest
): Promise<ProxyResult> {
  const url = `${upstream.baseUrl}/v1/chat/completions`;

  // Rewrite model name if configured
  const body = { ...requestBody };
  if (upstream.modelRewrite) {
    body.model = upstream.modelRewrite(body.model);
  }

  const isStreamRequested = body.stream === true;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${upstream.apiKey}`,
    },
    body: JSON.stringify(body),
  });

  const contentType = res.headers.get("content-type") ?? "";
  const isStreamResponse =
    isStreamRequested &&
    (contentType.includes("text/event-stream") ||
      contentType.includes("octet-stream"));

  if (!res.ok) {
    const errText = await res.text();
    return {
      status: res.status,
      headers: { "Content-Type": "application/json" },
      body: {
        error: {
          code: "upstream_error",
          message: `LLM API returned ${res.status}: ${errText.slice(0, 500)}`,
        },
      },
      isStream: false,
    };
  }

  if (isStreamResponse && res.body) {
    return {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
      stream: res.body as ReadableStream<Uint8Array>,
      isStream: true,
    };
  }

  // Non-streaming: parse and return JSON
  const json = await res.json();
  return {
    status: 200,
    headers: { "Content-Type": "application/json" },
    body: json,
    isStream: false,
  };
}
