/**
 * Tests for worker.ts — CF Worker entry point.
 *
 * Tests buildApp() logic (upstream configuration, env hash caching)
 * by importing the worker default export and exercising it via Hono's fetch.
 *
 * Since worker.ts uses module-level caching keyed on envHash
 * (first 8 chars of OPENROUTER_API_KEY, GATE_WALLET_ADDRESS, etc.),
 * each test uses unique key prefixes to force a fresh buildApp() call.
 */
import { describe, test, expect, vi, beforeEach } from "vitest";

// ── Mock createGateApp to avoid full app initialization ──────────
const mockApp = {
  fetch: vi.fn(async () => new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  })),
};

vi.mock("../create-app.js", () => ({
  createGateApp: vi.fn(() => mockApp),
}));

// Import after mocks
import worker from "../worker.js";
import { createGateApp } from "../create-app.js";

// ── Helpers ──────────────────────────────────────────────────────

let envCounter = 0;

/**
 * Each call generates a unique env where the first 8 chars of API key
 * and wallet address differ — this forces a new envHash and triggers buildApp().
 */
function makeEnv(overrides: Record<string, unknown> = {}) {
  envCounter++;
  const id = String(envCounter).padStart(8, "0");
  return {
    OPENROUTER_API_KEY: `${id}-openrouter-key`,
    GATE_WALLET_ADDRESS: `${id}-wallet-address`,
    ...overrides,
  };
}

async function fetchWorker(env: Record<string, unknown>, path = "/health") {
  return worker.fetch(
    new Request(`http://localhost${path}`),
    env,
    { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as any,
  );
}

describe("worker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("creates app with OpenRouter upstream", async () => {
    await fetchWorker(makeEnv());

    expect(createGateApp).toHaveBeenCalledTimes(1);
    const config = vi.mocked(createGateApp).mock.calls[0][0];
    expect(config.upstreams).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ match: "*", baseUrl: "https://openrouter.ai/api" }),
      ])
    );
  });

  test("creates app with both OpenAI and OpenRouter upstreams", async () => {
    await fetchWorker(makeEnv({
      OPENAI_API_KEY: "sk-openai-test",
    }));

    expect(createGateApp).toHaveBeenCalledTimes(1);
    const config = vi.mocked(createGateApp).mock.calls[0][0];
    expect(config.upstreams).toHaveLength(2);
    expect(config.upstreams[0]).toMatchObject({ match: "gpt-*", baseUrl: "https://api.openai.com" });
    expect(config.upstreams[1]).toMatchObject({ match: "*", baseUrl: "https://openrouter.ai/api" });
  });

  test("OpenAI-only falls back to wildcard", async () => {
    await fetchWorker(makeEnv({
      OPENROUTER_API_KEY: undefined,
      OPENAI_API_KEY: "sk-openai-only",
    }));

    expect(createGateApp).toHaveBeenCalledTimes(1);
    const config = vi.mocked(createGateApp).mock.calls[0][0];
    expect(config.upstreams).toHaveLength(2);
    expect(config.upstreams[0].match).toBe("gpt-*");
    expect(config.upstreams[1].match).toBe("*");
    expect(config.upstreams[1].apiKey).toBe("sk-openai-only");
  });

  test("uses custom base URLs when provided", async () => {
    await fetchWorker(makeEnv({
      OPENAI_API_KEY: "sk-openai",
      OPENAI_BASE_URL: "https://custom-openai.example.com",
      OPENROUTER_BASE_URL: "https://custom-or.example.com",
    }));

    expect(createGateApp).toHaveBeenCalledTimes(1);
    const config = vi.mocked(createGateApp).mock.calls[0][0];
    expect(config.upstreams[0].baseUrl).toBe("https://custom-openai.example.com");
    expect(config.upstreams[1].baseUrl).toBe("https://custom-or.example.com");
  });

  test("uses default trusted mints when not configured", async () => {
    await fetchWorker(makeEnv());

    expect(createGateApp).toHaveBeenCalledTimes(1);
    const config = vi.mocked(createGateApp).mock.calls[0][0];
    expect(config.trustedMints).toEqual(["https://mint.token2chat.com"]);
  });

  test("parses TRUSTED_MINTS comma-separated string", async () => {
    await fetchWorker(makeEnv({
      TRUSTED_MINTS: "https://mint1.example.com, https://mint2.example.com",
    }));

    expect(createGateApp).toHaveBeenCalledTimes(1);
    const config = vi.mocked(createGateApp).mock.calls[0][0];
    expect(config.trustedMints).toEqual([
      "https://mint1.example.com",
      "https://mint2.example.com",
    ]);
  });

  test("passes kvStore from env bindings", async () => {
    const mockKv = { get: vi.fn(), put: vi.fn(), delete: vi.fn(), list: vi.fn() };
    await fetchWorker(makeEnv({ ECASH_STORE: mockKv }));

    expect(createGateApp).toHaveBeenCalledTimes(1);
    const config = vi.mocked(createGateApp).mock.calls[0][0];
    expect(config.kvStore).toBe(mockKv);
  });

  test("passes null kvStore when ECASH_STORE not bound", async () => {
    await fetchWorker(makeEnv());

    expect(createGateApp).toHaveBeenCalledTimes(1);
    const config = vi.mocked(createGateApp).mock.calls[0][0];
    expect(config.kvStore).toBeNull();
  });

  test("passes adminToken from env", async () => {
    await fetchWorker(makeEnv({ GATE_ADMIN_TOKEN: "admin-secret" }));

    expect(createGateApp).toHaveBeenCalledTimes(1);
    const config = vi.mocked(createGateApp).mock.calls[0][0];
    expect(config.adminToken).toBe("admin-secret");
  });

  test("passes PRICING_JSON to loadPricing", async () => {
    const customPricing = JSON.stringify([
      { model: "test-model", mode: "per_token", input_per_million: 100, output_per_million: 200 },
    ]);
    await fetchWorker(makeEnv({ PRICING_JSON: customPricing }));

    expect(createGateApp).toHaveBeenCalledTimes(1);
    const config = vi.mocked(createGateApp).mock.calls[0][0];
    expect(config.pricing).toEqual([
      { model: "test-model", mode: "per_token", input_per_million: 100, output_per_million: 200 },
    ]);
  });

  test("forwards request to the cached app", async () => {
    await fetchWorker(makeEnv(), "/v1/chat/completions");

    expect(mockApp.fetch).toHaveBeenCalledTimes(1);
    const req = mockApp.fetch.mock.calls[0][0] as Request;
    expect(req.url).toContain("/v1/chat/completions");
  });

  test("caches app across requests with same env hash", async () => {
    const env = makeEnv();
    await fetchWorker(env);
    expect(createGateApp).toHaveBeenCalledTimes(1);
    vi.clearAllMocks();

    // Same env → same hash → should use cached app
    await fetchWorker(env);
    expect(createGateApp).toHaveBeenCalledTimes(0);
    expect(mockApp.fetch).toHaveBeenCalledTimes(1);
  });

  test("passes allowed origins from env", async () => {
    await fetchWorker(makeEnv({ ALLOWED_ORIGINS: "https://example.com" }));

    expect(createGateApp).toHaveBeenCalledTimes(1);
    const config = vi.mocked(createGateApp).mock.calls[0][0];
    expect(config.allowedOrigins).toBe("https://example.com");
  });

  test("defaults allowedOrigins to wildcard", async () => {
    await fetchWorker(makeEnv());

    expect(createGateApp).toHaveBeenCalledTimes(1);
    const config = vi.mocked(createGateApp).mock.calls[0][0];
    expect(config.allowedOrigins).toBe("*");
  });

  test("defaults mintUrl when not configured", async () => {
    await fetchWorker(makeEnv());

    expect(createGateApp).toHaveBeenCalledTimes(1);
    const config = vi.mocked(createGateApp).mock.calls[0][0];
    expect(config.mintUrl).toBe("https://mint.token2chat.com");
  });

  test("uses custom MINT_URL when provided", async () => {
    await fetchWorker(makeEnv({ MINT_URL: "https://custom-mint.example.com" }));

    expect(createGateApp).toHaveBeenCalledTimes(1);
    const config = vi.mocked(createGateApp).mock.calls[0][0];
    expect(config.mintUrl).toBe("https://custom-mint.example.com");
  });

  test("walletAddress is passed from env", async () => {
    const env = makeEnv();
    await fetchWorker(env);

    expect(createGateApp).toHaveBeenCalledTimes(1);
    const config = vi.mocked(createGateApp).mock.calls[0][0];
    expect(config.walletAddress).toBe(env.GATE_WALLET_ADDRESS);
  });
});
