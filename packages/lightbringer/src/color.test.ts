import { describe, expect, it } from "vitest";
import { colorEnabled, makePalette } from "./color";

describe("colorEnabled", () => {
  it("NO_COLOR が設定されていれば TTY でも無効になること", () => {
    expect(colorEnabled({ NO_COLOR: "1" }, true)).toBe(false);
  });
  it("PERF_COLOR=0 が NO_COLOR と同様に無効化すること", () => {
    expect(colorEnabled({ PERF_COLOR: "0" }, true)).toBe(false);
  });
  it("PERF_COLOR=1 が非TTYでも有効化すること", () => {
    expect(colorEnabled({ PERF_COLOR: "1" }, false)).toBe(true);
  });
  it("FORCE_COLOR が非TTYでも有効化すること", () => {
    expect(colorEnabled({ FORCE_COLOR: "1" }, false)).toBe(true);
  });
  it("env 指定が無ければ TTY の有無で決まること", () => {
    expect(colorEnabled({}, true)).toBe(true);
    expect(colorEnabled({}, false)).toBe(false);
  });
  it("PERF_COLOR=0 が FORCE_COLOR より優先されること", () => {
    expect(colorEnabled({ PERF_COLOR: "0", FORCE_COLOR: "1" }, true)).toBe(false);
  });
});
describe("makePalette", () => {
  it("無効時は入力をそのまま返すこと", () => {
    const p = makePalette(false);
    expect(p.red("x")).toBe("x");
    expect(p.bold("x")).toBe("x");
  });
  it("有効時は ANSI コードで囲むこと", () => {
    const p = makePalette(true);
    expect(p.red("x")).toBe("\x1b[31mx\x1b[39m");
    expect(p.dim("x")).toBe("\x1b[2mx\x1b[22m");
  });
});
