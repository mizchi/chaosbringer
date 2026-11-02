import { chromium } from "playwright";
import { describe, expect, it, vi } from "vitest";
import { chaos } from "./chaos.js";
import { ChaosCrawler } from "./crawler.js";
import { axe } from "./invariants.js";
import { defineScenario } from "./load/scenario.js";
import { scenarioLoad } from "./load/scenario-load.js";
import {
  AXE_PEERS,
  assertPeers,
  invariantPeerNeeds,
  isMissingPeerError,
  MissingPeerError,
  peerInstalled,
  VISUAL_REGRESSION_PEERS,
} from "./peers.js";
import type { Invariant } from "./types.js";
import { visualRegression } from "./visual.js";

/** A package no tree has: resolving it for real is the missing-peer case, with nothing uninstalled. */
const NOT_INSTALLED = "@chaosbringer-test/not-installed";
const needsAbsent: Invariant = { name: "needs-absent", peers: [NOT_INSTALLED], check: () => true };

describe("assertPeers", () => {
  const none = () => false;

  it("passes when every package resolves, and with nothing to resolve", () => {
    expect(() => assertPeers([{ by: "--axe", peers: AXE_PEERS }], () => true)).not.toThrow();
    expect(() => assertPeers([], none)).not.toThrow();
  });

  it("names who needs which package, and the one command that installs them all", () => {
    let err: unknown;
    try {
      assertPeers(
        [
          { by: "--axe", peers: AXE_PEERS },
          { by: "--visual-baseline", peers: VISUAL_REGRESSION_PEERS },
        ],
        (name) => name === "pngjs",
      );
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(MissingPeerError);
    expect(isMissingPeerError(err)).toBe(true);
    const e = err as MissingPeerError;
    expect(e.packages).toEqual(["axe-core", "pixelmatch"]);
    expect(e.requiredBy).toEqual(["--axe", "--visual-baseline"]);
    expect(e.installCommand).toBe("pnpm add -D axe-core pixelmatch");
    expect(e.message).toBe(
      "chaosbringer: --axe needs axe-core, --visual-baseline needs pixelmatch: optional peer dependencies " +
        "that are not installed. Install them with `pnpm add -D axe-core pixelmatch` (or `npm install -D axe-core pixelmatch`)",
    );
  });

  it("names a package two invariants need once", () => {
    const err = (() => {
      try {
        assertPeers(invariantPeerNeeds([axe(), axe({ name: "a11y-dialog" })]), none);
      } catch (e) {
        return e as MissingPeerError;
      }
    })();
    expect(err?.packages).toEqual(["axe-core"]);
    expect(err?.message).toBe(
      'chaosbringer: invariant "a11y-axe" needs axe-core, invariant "a11y-dialog" needs axe-core: an optional peer ' +
        "dependency that is not installed. Install it with `pnpm add -D axe-core` (or `npm install -D axe-core`)",
    );
  });
});

describe("invariantPeerNeeds", () => {
  it("reads the presets' declared peers, and nothing from an invariant that declares none", () => {
    expect(
      invariantPeerNeeds([axe(), visualRegression({ baselineDir: "vb" }), { name: "custom", check: () => true }]),
    ).toEqual([
      { by: 'invariant "a11y-axe"', peers: ["axe-core"] },
      { by: 'invariant "visual-regression"', peers: ["pixelmatch", "pngjs"] },
    ]);
    expect(invariantPeerNeeds(undefined)).toEqual([]);
  });

  it("refuses a peers that is not a list of package names, which was spread into its letters", () => {
    const withPeers = (peers: unknown): Invariant => ({ name: "x", peers: peers as string[], check: () => true });
    for (const peers of ["axe-core", [""], [42]]) {
      expect(() => invariantPeerNeeds([withPeers(peers)])).toThrow(
        `chaosbringer: invariant "x" peers must be an array of package names (got ${JSON.stringify(peers)})`,
      );
    }
    expect(() => new ChaosCrawler({ baseUrl: "http://127.0.0.1:9/", invariants: [withPeers("axe-core")] })).toThrow(
      'invariant "x" peers must be an array of package names',
    );
    expect(invariantPeerNeeds([withPeers([])])).toEqual([]);
  });
});

describe("peerInstalled", () => {
  it("resolves from chaosbringer's own location", () => {
    // This repo installs all three as devDependencies.
    for (const name of [...AXE_PEERS, ...VISUAL_REGRESSION_PEERS]) expect(peerInstalled(name)).toBe(true);
    expect(peerInstalled(NOT_INSTALLED)).toBe(false);
  });
});

// Before the browser starts, for every way the library is driven: a missing
// axe-core used to cost a whole crawl, and then failed every page with one
// "requires the axe-core package" invariant violation each, as if the site
// had the bug.
describe("an invariant whose peer is not installed", () => {
  it("is refused by the ChaosCrawler constructor", () => {
    expect(() => new ChaosCrawler({ baseUrl: "http://127.0.0.1:9/", invariants: [needsAbsent] })).toThrow(MissingPeerError);
  });

  it("is refused by chaos() before its setup hook launches a browser", async () => {
    const setup = vi.fn(async () => {});
    await expect(chaos({ baseUrl: "http://127.0.0.1:9/", invariants: [needsAbsent], setup })).rejects.toThrow(
      `invariant "needs-absent" needs ${NOT_INSTALLED}`,
    );
    expect(setup).not.toHaveBeenCalled();
  });

  it("is refused by scenarioLoad before its browser launches", async () => {
    // Without the check, each iteration failed on the missing package and
    // the load run itself resolved.
    const launch = vi.spyOn(chromium, "launch").mockRejectedValue(new Error("launched"));
    try {
      await expect(
        scenarioLoad({
          baseUrl: "http://127.0.0.1:9/",
          scenarios: [{ scenario: defineScenario({ name: "x", steps: [{ name: "s", run: async () => {} }] }), workers: 1 }],
          invariants: [needsAbsent],
        }),
      ).rejects.toBeInstanceOf(MissingPeerError);
      expect(launch).not.toHaveBeenCalled();
    } finally {
      launch.mockRestore();
    }
  });

  it("fails the Playwright fixture before the test body runs", async () => {
    const { withChaos } = await import("./fixture.js");
    const use = vi.fn(async () => {});
    await expect(
      withChaos({ invariants: [needsAbsent] }).chaos(
        { chaosOptions: {}, baseURL: "http://127.0.0.1:9/" },
        use,
        {} as Parameters<ReturnType<typeof withChaos>["chaos"]>[2],
      ),
    ).rejects.toBeInstanceOf(MissingPeerError);
    expect(use).not.toHaveBeenCalled();
  });
});
