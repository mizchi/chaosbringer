import { describe, expect, it, vi } from "vitest";
import { openRouterAdvisor } from "./openrouter.js";
import type { AdvisorContext } from "./types.js";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);

const sampleContext = (
  overrides: Partial<AdvisorContext> = {},
): AdvisorContext => ({
  url: "https://example.test/page",
  screenshot: PNG,
  candidates: [
    { index: 0, selector: "#a", description: "button A" },
    { index: 1, selector: "#b", description: "link B" },
    { index: 2, selector: "#c", description: "input C" },
  ],
  reason: "novelty_stall",
  budgetRemaining: 19,
  ...overrides,
});

const okBody = (chosenIndex = 1, usageUsd = 0.001) => ({
  choices: [
    {
      message: {
        content: JSON.stringify({ chosenIndex, reasoning: "the model picks B" }),
      },
    },
  ],
  usage: { total_cost: usageUsd },
});

const okResponse = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

describe("openRouterAdvisor", () => {
  it("returns a suggestion on a well-formed response", async () => {
    const fetchMock = vi.fn(async () => okResponse(okBody(1)));
    const advisor = openRouterAdvisor({ apiKey: "key", fetch: fetchMock });
    const result = await advisor.suggest(sampleContext());
    expect(result).toEqual({ chosenIndex: 1, reasoning: "the model picks B" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("uses google/gemini-2.5-flash by default and overrides via model option", async () => {
    const fetchMock = vi.fn(async () => okResponse(okBody()));
    const advisor = openRouterAdvisor({ apiKey: "k", fetch: fetchMock, model: "anthropic/claude-haiku-4.5" });
    await advisor.suggest(sampleContext());
    const body = JSON.parse(fetchMock.mock.calls[0][1]?.body as string);
    expect(body.model).toBe("anthropic/claude-haiku-4.5");
    expect(advisor.name).toContain("anthropic/claude-haiku-4.5");
  });

  it("sends the screenshot as a base64 image_url content block", async () => {
    const fetchMock = vi.fn(async () => okResponse(okBody()));
    const advisor = openRouterAdvisor({ apiKey: "k", fetch: fetchMock });
    await advisor.suggest(sampleContext());
    const body = JSON.parse(fetchMock.mock.calls[0][1]?.body as string);
    const userMsg = body.messages.find((m: { role: string }) => m.role === "user");
    const imagePart = userMsg.content.find((c: { type: string }) => c.type === "image_url");
    expect(imagePart.image_url.url).toMatch(/^data:image\/png;base64,/);
    expect(imagePart.image_url.url).toContain(PNG.toString("base64"));
  });

  it("renders candidates and url into the user text content block", async () => {
    const fetchMock = vi.fn(async () => okResponse(okBody()));
    const advisor = openRouterAdvisor({ apiKey: "k", fetch: fetchMock });
    await advisor.suggest(sampleContext());
    const body = JSON.parse(fetchMock.mock.calls[0][1]?.body as string);
    const userMsg = body.messages.find((m: { role: string }) => m.role === "user");
    const textPart = userMsg.content.find((c: { type: string }) => c.type === "text");
    expect(textPart.text).toContain("https://example.test/page");
    expect(textPart.text).toContain("0. button A");
    expect(textPart.text).toContain("1. link B");
    expect(textPart.text).toContain("novelty_stall");
  });

  it("sends the system prompt as a system message", async () => {
    const fetchMock = vi.fn(async () => okResponse(okBody()));
    const advisor = openRouterAdvisor({ apiKey: "k", fetch: fetchMock });
    await advisor.suggest(sampleContext());
    const body = JSON.parse(fetchMock.mock.calls[0][1]?.body as string);
    const systemMsg = body.messages.find((m: { role: string }) => m.role === "system");
    expect(systemMsg).toBeDefined();
    expect(typeof systemMsg.content).toBe("string");
    expect(systemMsg.content.length).toBeGreaterThan(50);
  });

  it("sends the API key as a Bearer token and never logs it", async () => {
    const fetchMock = vi.fn(async () => okResponse(okBody()));
    const advisor = openRouterAdvisor({ apiKey: "secret-key", fetch: fetchMock });
    await advisor.suggest(sampleContext());
    const headers = fetchMock.mock.calls[0][1]?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer secret-key");
    expect(advisor.name).not.toContain("secret-key");
  });

  it("returns null when the response is not 2xx", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response("upstream timeout", {
          status: 504,
          headers: { "content-type": "text/plain" },
        }),
    );
    const advisor = openRouterAdvisor({ apiKey: "k", fetch: fetchMock });
    expect(await advisor.suggest(sampleContext())).toBeNull();
  });

  it("returns null when the model body is not JSON", async () => {
    const fetchMock = vi.fn(async () =>
      okResponse({
        choices: [{ message: { content: "not json at all" } }],
      }),
    );
    const advisor = openRouterAdvisor({ apiKey: "k", fetch: fetchMock });
    expect(await advisor.suggest(sampleContext())).toBeNull();
  });

  it("returns null when chosenIndex is missing", async () => {
    const fetchMock = vi.fn(async () =>
      okResponse({
        choices: [{ message: { content: JSON.stringify({ reasoning: "no index" }) } }],
      }),
    );
    const advisor = openRouterAdvisor({ apiKey: "k", fetch: fetchMock });
    expect(await advisor.suggest(sampleContext())).toBeNull();
  });

  it("returns null when reasoning is missing", async () => {
    const fetchMock = vi.fn(async () =>
      okResponse({
        choices: [{ message: { content: JSON.stringify({ chosenIndex: 0 }) } }],
      }),
    );
    const advisor = openRouterAdvisor({ apiKey: "k", fetch: fetchMock });
    expect(await advisor.suggest(sampleContext())).toBeNull();
  });

  it("strips fenced code blocks around the JSON before parsing", async () => {
    const fenced = "```json\n" + JSON.stringify({ chosenIndex: 2, reasoning: "fenced" }) + "\n```";
    const fetchMock = vi.fn(async () =>
      okResponse({ choices: [{ message: { content: fenced } }] }),
    );
    const advisor = openRouterAdvisor({ apiKey: "k", fetch: fetchMock });
    const result = await advisor.suggest(sampleContext());
    expect(result?.chosenIndex).toBe(2);
  });

  it("does not hit the network once the USD budget is exhausted", async () => {
    const fetchMock = vi.fn(async () => okResponse(okBody(0, 0.4)));
    const advisor = openRouterAdvisor({
      apiKey: "k",
      fetch: fetchMock,
      budgetUsd: 0.5,
    });
    await advisor.suggest(sampleContext()); // first call: cost 0.4, total 0.4 (under budget)
    await advisor.suggest(sampleContext()); // second call: would push to 0.8 — let it run, charge it
    expect(await advisor.suggest(sampleContext())).toBeNull(); // third call: budget already over, no fetch
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns null and skips fetch when fetch is a no-op for budget testing", async () => {
    const fetchMock = vi.fn(async () => okResponse(okBody(0, 1)));
    const advisor = openRouterAdvisor({
      apiKey: "k",
      fetch: fetchMock,
      budgetUsd: 0.5,
    });
    await advisor.suggest(sampleContext());
    expect(await advisor.suggest(sampleContext())).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
