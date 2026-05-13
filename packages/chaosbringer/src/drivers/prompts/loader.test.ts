import { describe, expect, it } from "vitest";
import {
  formatCandidates,
  formatHistory,
  formatViolations,
  parsePromptFile,
  parseSuggestion,
  renderUserPrompt,
  stripCodeFence,
} from "./loader.js";

describe("parsePromptFile", () => {
  it("splits on the SYSTEM and USER delimiters", () => {
    const parsed = parsePromptFile(
      "---SYSTEM---\nbe helpful\n---USER---\nhello {{url}}\n",
    );
    expect(parsed.system).toBe("be helpful");
    expect(parsed.userTemplate).toBe("hello {{url}}");
  });

  it("throws on missing delimiters", () => {
    expect(() => parsePromptFile("no markers here")).toThrow(/SYSTEM/);
    expect(() => parsePromptFile("---SYSTEM---\nx")).toThrow(/USER/);
  });
});

describe("formatHistory / formatViolations / formatCandidates", () => {
  it("formats empty history as (none)", () => {
    expect(formatHistory([])).toBe("(none)");
  });

  it("numbers history entries", () => {
    expect(
      formatHistory([
        { type: "click", target: "a", success: true },
        { type: "input", target: "b", success: false, error: "oops" },
      ]),
    ).toContain("1. click a");
    expect(
      formatHistory([
        { type: "click", target: "a", success: true },
        { type: "input", target: "b", success: false, error: "oops" },
      ]),
    ).toContain("fail: oops");
  });

  it("formats empty violations as (none)", () => {
    expect(formatViolations([])).toBe("(none)");
  });

  it("formats candidates with their index prefix", () => {
    expect(
      formatCandidates([
        { index: 0, description: "button A" },
        { index: 1, description: "input B" },
      ]),
    ).toBe("0. button A\n1. input B");
  });
});

describe("renderUserPrompt", () => {
  it("substitutes placeholders", () => {
    const out = renderUserPrompt(
      "URL: {{url}} step {{stepIndex}}\n{{goalLine}}H={{history}} V={{violations}} C={{candidates}}",
      {
        url: "https://x",
        screenshot: Buffer.from([]),
        candidates: [{ index: 0, description: "a" }],
        history: [],
        invariantViolations: [],
        goal: "find bugs",
        stepIndex: 7,
      },
    );
    expect(out).toContain("https://x");
    expect(out).toContain("step 7");
    expect(out).toContain("Goal: find bugs");
    expect(out).toContain("(none)");
    expect(out).toContain("0. a");
  });

  it("omits the goal line when goal is not set", () => {
    const out = renderUserPrompt("{{goalLine}}rest", {
      url: "",
      screenshot: Buffer.from([]),
      candidates: [],
      history: [],
      invariantViolations: [],
      stepIndex: 0,
    });
    expect(out).toBe("rest");
  });
});

describe("parseSuggestion", () => {
  it("accepts {index, reasoning}", () => {
    expect(parseSuggestion('{"index":1,"reasoning":"x"}', 3)).toEqual({
      index: 1,
      reasoning: "x",
    });
  });

  it("accepts legacy {chosenIndex} key", () => {
    expect(parseSuggestion('{"chosenIndex":2,"reasoning":"x"}', 3)).toEqual({
      index: 2,
      reasoning: "x",
    });
  });

  it("rejects out-of-range index", () => {
    expect(parseSuggestion('{"index":99,"reasoning":"x"}', 3)).toBeNull();
  });

  it("rejects missing reasoning", () => {
    expect(parseSuggestion('{"index":0}', 3)).toBeNull();
  });

  it("rejects non-JSON", () => {
    expect(parseSuggestion("not json", 3)).toBeNull();
  });
});

describe("stripCodeFence", () => {
  it("removes ```json fences", () => {
    expect(stripCodeFence('```json\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it("leaves plain text alone", () => {
    expect(stripCodeFence("plain")).toBe("plain");
  });
});
