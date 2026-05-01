import { describe, expect, it } from "vitest";
import { parsePromptFile, renderUserPrompt } from "./loader.js";

const SAMPLE = `---SYSTEM---
sys body
on two lines
---USER---
URL: {{url}}
Reason: {{reason}}
Candidates:
{{candidates}}
`;

describe("parsePromptFile", () => {
  it("splits on the SYSTEM and USER delimiters", () => {
    const parsed = parsePromptFile(SAMPLE);
    expect(parsed.system).toBe("sys body\non two lines");
    expect(parsed.userTemplate).toContain("URL: {{url}}");
    expect(parsed.userTemplate).toContain("{{candidates}}");
  });

  it("throws when SYSTEM delimiter is missing", () => {
    expect(() => parsePromptFile("---USER---\nbody\n")).toThrow(/SYSTEM/);
  });

  it("throws when USER delimiter is missing", () => {
    expect(() => parsePromptFile("---SYSTEM---\nbody\n")).toThrow(/USER/);
  });

  it("throws when SYSTEM appears after USER", () => {
    expect(() => parsePromptFile("---USER---\na\n---SYSTEM---\nb\n")).toThrow();
  });
});

describe("renderUserPrompt", () => {
  const { userTemplate } = parsePromptFile(SAMPLE);

  it("substitutes all known placeholders", () => {
    const out = renderUserPrompt(userTemplate, {
      url: "https://example.test/x",
      reason: "novelty_stall",
      candidates: "0. button A\n1. link B",
    });
    expect(out).toContain("URL: https://example.test/x");
    expect(out).toContain("Reason: novelty_stall");
    expect(out).toContain("0. button A");
    expect(out).not.toContain("{{url}}");
    expect(out).not.toContain("{{reason}}");
    expect(out).not.toContain("{{candidates}}");
  });

  it("leaves unknown placeholders alone", () => {
    const out = renderUserPrompt("{{url}} {{unknown}}", {
      url: "u",
      reason: "r",
      candidates: "c",
    });
    expect(out).toBe("u {{unknown}}");
  });

  it("escapes nothing — values are passed through verbatim", () => {
    const out = renderUserPrompt("{{candidates}}", {
      url: "u",
      reason: "r",
      candidates: "<script>",
    });
    expect(out).toBe("<script>");
  });
});
