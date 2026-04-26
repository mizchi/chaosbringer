/**
 * Built-in invariant presets. Mirrors the `faults` helpers — lets users wire
 * common assertions without writing the check() closure each time.
 *
 * Presets declared here are otherwise ordinary Invariants. They just know how
 * to set up their own tooling (e.g. inject axe-core into the page).
 */
import { visualRegression } from "./visual.js";
const DEFAULT_AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];
export function buildAxeRunPayload(opts = {}) {
    const tags = opts.tags && opts.tags.length > 0 ? opts.tags : DEFAULT_AXE_TAGS;
    const contextEntries = {};
    if (opts.include && opts.include.length > 0) {
        contextEntries.include = opts.include.map((s) => [s]);
    }
    if (opts.exclude && opts.exclude.length > 0) {
        contextEntries.exclude = opts.exclude.map((s) => [s]);
    }
    const hasContext = contextEntries.include || contextEntries.exclude;
    const rules = opts.disableRules?.length
        ? Object.fromEntries(opts.disableRules.map((r) => [r, { enabled: false }]))
        : undefined;
    return {
        context: hasContext ? contextEntries : null,
        options: {
            runOnly: { type: "tag", values: tags },
            ...(rules ? { rules } : {}),
            resultTypes: ["violations"],
        },
    };
}
/**
 * Render a violations array to a single-line summary suitable for the
 * invariant failure message. Example:
 *   `3 violations: color-contrast(×5, serious), image-alt(×2, critical)`
 */
export function formatAxeViolations(violations) {
    if (violations.length === 0)
        return "";
    const parts = violations.map((v) => {
        const count = v.nodes?.length ?? 0;
        const impact = v.impact ? `, ${v.impact}` : "";
        return `${v.id}(×${count}${impact})`;
    });
    return `${violations.length} a11y violations: ${parts.join(", ")}`;
}
async function loadAxeSource() {
    try {
        const mod = (await import("axe-core"));
        const source = mod.default?.source ?? mod.source;
        if (typeof source !== "string" || source.length === 0) {
            throw new Error("axe-core did not expose a `source` string — check the installed version.");
        }
        return source;
    }
    catch (err) {
        if (err instanceof Error && err.message.startsWith("axe-core"))
            throw err;
        throw new Error("chaosbringer: invariants.axe() requires the `axe-core` package. Install it with `pnpm add axe-core`.");
    }
}
/**
 * Axe-core invariant preset. Injects axe into every page the invariant runs
 * on, calls `axe.run`, and fails with a one-line summary of the violations.
 * Requires `axe-core` to be installed — it's an optional peer dep.
 */
export function axe(options = {}) {
    const payload = buildAxeRunPayload(options);
    return {
        name: options.name ?? "a11y-axe",
        urlPattern: options.urlPattern,
        when: options.when ?? "afterActions",
        async check({ page }) {
            const source = await loadAxeSource();
            await page.addScriptTag({ content: source });
            const results = (await page.evaluate(async (p) => {
                // @ts-ignore - axe is attached to window by the script tag above.
                const ax = globalThis.axe;
                if (!ax)
                    throw new Error("axe-core failed to install on the page");
                return ax.run(p.context ?? document, p.options);
            }, payload));
            if (!results || !Array.isArray(results.violations) || results.violations.length === 0) {
                return true;
            }
            return formatAxeViolations(results.violations);
        },
    };
}
/** Exported as a namespace so consumers can write `invariants.axe(...)`. */
export const invariants = { axe, visualRegression };
