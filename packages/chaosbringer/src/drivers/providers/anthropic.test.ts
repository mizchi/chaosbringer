import { describe, expect, it, vi } from "vitest";
import { anthropicDriverProvider } from "./anthropic.js";
import type { DriverProviderInput } from "../types.js";

const PNG = Buffer.from([0x89, 0x50]);

const makeInput = (overrides: Partial<DriverProviderInput> = {}): DriverProviderInput => ({
  url: "https://example.test/",
  screenshot: PNG,
  candidates: [
    { index: 0, description: "button A" },
    { index: 1, description: "input B" },
  ],
  history: [{ type: "click", target: "X", success: true }],
  invariantViolations: [],
  stepIndex: 1,
  ...overrides,
});

const okBody = (index = 1) => ({
  content: [{ type: "text", text: JSON.stringify({ index, reasoning: "y" }) }],
});

const okResponse = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

describe("anthropicDriverProvider", () => {
  it("returns a result on a well-formed response", async () => {
    const fetchMock = vi.fn(async () => okResponse(okBody(1)));
    const provider = anthropicDriverProvider({ apiKey: "k", fetch: fetchMock });
    const result = await provider.selectAction(makeInput());
    expect(result?.index).toBe(1);
  });

  it("uses claude-haiku-4-5 by default and sends x-api-key", async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      captured = { url, init };
      return okResponse(okBody(0));
    });
    const provider = anthropicDriverProvider({ apiKey: "secret", fetch: fetchMock });
    await provider.selectAction(makeInput());
    expect(provider.name).toContain("claude-haiku-4-5");
    expect((captured!.init.headers as Record<string, string>)["x-api-key"]).toBe("secret");
    expect((captured!.init.headers as Record<string, string>)["anthropic-version"]).toBeDefined();
  });

  it("returns null on non-2xx", async () => {
    const fetchMock = vi.fn(async () => new Response("err", { status: 500 }));
    const provider = anthropicDriverProvider({ apiKey: "k", fetch: fetchMock });
    expect(await provider.selectAction(makeInput())).toBeNull();
  });

  it("returns null when content block has no text", async () => {
    const fetchMock = vi.fn(async () => okResponse({ content: [{ type: "image" }] }));
    const provider = anthropicDriverProvider({ apiKey: "k", fetch: fetchMock });
    expect(await provider.selectAction(makeInput())).toBeNull();
  });

  it("returns null on out-of-range index", async () => {
    const fetchMock = vi.fn(async () => okResponse(okBody(99)));
    const provider = anthropicDriverProvider({ apiKey: "k", fetch: fetchMock });
    expect(await provider.selectAction(makeInput())).toBeNull();
  });
});
