import { describe, expect, it, vi } from "vitest";
import { openRouterDriverProvider } from "./openrouter.js";
import type { DriverProviderInput } from "../types.js";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

const makeInput = (overrides: Partial<DriverProviderInput> = {}): DriverProviderInput => ({
  url: "https://example.test/",
  screenshot: PNG,
  candidates: [
    { index: 0, description: "button A" },
    { index: 1, description: "link B" },
    { index: 2, description: "input C" },
  ],
  history: [],
  invariantViolations: [],
  stepIndex: 0,
  ...overrides,
});

const okBody = (index = 1, costUsd = 0.0005) => ({
  choices: [
    {
      message: {
        content: JSON.stringify({ index, reasoning: "exploring B" }),
      },
    },
  ],
  usage: { total_cost: costUsd },
});

const okResponse = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

describe("openRouterDriverProvider", () => {
  it("returns a result on a well-formed response", async () => {
    const fetchMock = vi.fn(async () => okResponse(okBody(1)));
    const provider = openRouterDriverProvider({ apiKey: "k", fetch: fetchMock });
    const result = await provider.selectAction(makeInput());
    expect(result).toEqual({
      index: 1,
      reasoning: "exploring B",
      confidence: undefined,
    });
  });

  it("accepts legacy chosenIndex key for backward compat", async () => {
    const body = {
      choices: [
        {
          message: {
            content: JSON.stringify({ chosenIndex: 2, reasoning: "x" }),
          },
        },
      ],
    };
    const fetchMock = vi.fn(async () => okResponse(body));
    const provider = openRouterDriverProvider({ apiKey: "k", fetch: fetchMock });
    const result = await provider.selectAction(makeInput());
    expect(result?.index).toBe(2);
  });

  it("returns null on a non-2xx response", async () => {
    const fetchMock = vi.fn(async () => new Response("nope", { status: 500 }));
    const provider = openRouterDriverProvider({ apiKey: "k", fetch: fetchMock });
    expect(await provider.selectAction(makeInput())).toBeNull();
  });

  it("returns null on out-of-range index", async () => {
    const fetchMock = vi.fn(async () => okResponse(okBody(99)));
    const provider = openRouterDriverProvider({ apiKey: "k", fetch: fetchMock });
    expect(await provider.selectAction(makeInput())).toBeNull();
  });

  it("stops calling after maxUsd is exhausted", async () => {
    const fetchMock = vi.fn(async () => okResponse(okBody(0, 0.5)));
    const provider = openRouterDriverProvider({
      apiKey: "k",
      fetch: fetchMock,
      maxUsd: 0.1,
    });
    expect(await provider.selectAction(makeInput())).not.toBeNull();
    // Cost reported was 0.5, well over the cap → next call short-circuits.
    expect(await provider.selectAction(makeInput())).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("handles a code-fenced JSON response", async () => {
    const body = {
      choices: [
        {
          message: {
            content: '```json\n{"index": 0, "reasoning": "fenced"}\n```',
          },
        },
      ],
    };
    const fetchMock = vi.fn(async () => okResponse(body));
    const provider = openRouterDriverProvider({ apiKey: "k", fetch: fetchMock });
    expect(await provider.selectAction(makeInput())).toEqual({
      index: 0,
      reasoning: "fenced",
      confidence: undefined,
    });
  });
});
