import { describe, it, expect } from "vitest";
import { createGateApp } from "../create-app.js";
import { VERSION_INFO } from "../version.js";

// Minimal config for testing
const testConfig = {
  trustedMints: ["https://mint.test.com"],
  upstreams: [],
  pricing: [],
  walletAddress: "0x1234567890123456789012345678901234567890",
};

describe("GET /v1/info", () => {
  it("should return version info in expected format", async () => {
    const app = createGateApp(testConfig);
    const res = await app.request("/v1/info");
    
    expect(res.status).toBe(200);
    const body = await res.json();
    
    expect(body).toHaveProperty("name", "cash2chat");
    expect(body).toHaveProperty("version");
    expect(body).toHaveProperty("description");
    expect(body.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("should return version matching VERSION_INFO constant", async () => {
    const app = createGateApp(testConfig);
    const res = await app.request("/v1/info");
    const body = await res.json();
    
    expect(body.name).toBe(VERSION_INFO.name);
    expect(body.version).toBe(VERSION_INFO.version);
    expect(body.description).toBe(VERSION_INFO.description);
  });
});

describe("X-Gate-Version header", () => {
  it("should be present on /v1/info response", async () => {
    const app = createGateApp(testConfig);
    const res = await app.request("/v1/info");
    
    expect(res.headers.get("X-Gate-Version")).toBe(VERSION_INFO.version);
  });

  it("should be present on /health response", async () => {
    const app = createGateApp(testConfig);
    const res = await app.request("/health");
    
    expect(res.headers.get("X-Gate-Version")).toBe(VERSION_INFO.version);
  });

  it("should be present on / landing page response", async () => {
    const app = createGateApp(testConfig);
    const res = await app.request("/");
    
    expect(res.headers.get("X-Gate-Version")).toBe(VERSION_INFO.version);
  });

  it("should be present on /v1/pricing response", async () => {
    const app = createGateApp(testConfig);
    const res = await app.request("/v1/pricing");
    
    expect(res.headers.get("X-Gate-Version")).toBe(VERSION_INFO.version);
  });
});
