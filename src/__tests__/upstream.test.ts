import { describe, it, expect } from "vitest";
import { resolveUpstream, type UpstreamEntry } from "../upstream.js";

const entries: UpstreamEntry[] = [
  { match: "gpt-*", baseUrl: "https://api.openai.com", apiKey: "sk-oai" },
  { match: "claude-*", baseUrl: "https://openrouter.ai/api", apiKey: "sk-or" },
  { match: "*", baseUrl: "https://fallback.example", apiKey: "sk-fb" },
];

describe("resolveUpstream", () => {
  it("should match gpt- prefix to OpenAI", () => {
    const u = resolveUpstream("gpt-4o-mini", entries);
    expect(u?.baseUrl).toBe("https://api.openai.com");
  });

  it("should match claude- prefix to OpenRouter", () => {
    const u = resolveUpstream("claude-sonnet-4-20250514", entries);
    expect(u?.baseUrl).toBe("https://openrouter.ai/api");
  });

  it("should fall back to wildcard for unknown model", () => {
    const u = resolveUpstream("llama3-70b", entries);
    expect(u?.baseUrl).toBe("https://fallback.example");
  });

  it("should prefer exact match over prefix", () => {
    const withExact: UpstreamEntry[] = [
      { match: "gpt-4o-mini", baseUrl: "https://exact.example", apiKey: "sk-ex" },
      ...entries,
    ];
    const u = resolveUpstream("gpt-4o-mini", withExact);
    expect(u?.baseUrl).toBe("https://exact.example");
  });

  it("should return null when no entries", () => {
    expect(resolveUpstream("gpt-4o", [])).toBeNull();
  });

  it("should return null when no match and no wildcard", () => {
    const noWildcard: UpstreamEntry[] = [
      { match: "gpt-*", baseUrl: "https://api.openai.com", apiKey: "sk" },
    ];
    expect(resolveUpstream("claude-3", noWildcard)).toBeNull();
  });
});
