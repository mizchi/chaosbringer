/**
 * Action heatmap -- aggregate `report.actions[]` by target + type and surface
 * the most-frequent / least-reliable targets. Useful when triaging a noisy
 * crawl: which links / buttons does the chaos driver hit most, and which
 * ones disproportionately fail?
 *
 * Pure aggregation over the existing `actions` array -- no extra crawler
 * instrumentation. Run on any historical CrawlReport.
 */
/**
 * Aggregate actions into a per-(type, key) heatmap, sorted by count
 * descending so the most-hit targets surface first. Stable: actions with
 * neither `target` nor `selector` collapse into a single `(unknown)` row.
 */
export function buildActionHeatmap(actions) {
    const buckets = new Map();
    for (const a of actions) {
        const key = a.target ?? a.selector ?? "(unknown)";
        // ActionResult["type"] is a closed union of single-word literals (click,
        // scroll, input, hover, navigate) so a space delimiter is unambiguous.
        const mapKey = `${a.type} ${key}`;
        let entry = buckets.get(mapKey);
        if (!entry) {
            entry = {
                key,
                type: a.type,
                count: 0,
                successCount: 0,
                failureCount: 0,
                blockedExternalCount: 0,
                shardSkippedCount: 0,
            };
            buckets.set(mapKey, entry);
        }
        entry.count++;
        if (a.success)
            entry.successCount++;
        else
            entry.failureCount++;
        if (a.blockedExternal)
            entry.blockedExternalCount++;
        // shardSkipped is a recent ActionResult flag; tolerate older reports.
        const sk = a.shardSkipped;
        if (sk)
            entry.shardSkippedCount++;
    }
    return [...buckets.values()].sort((x, y) => {
        if (y.count !== x.count)
            return y.count - x.count;
        if (y.failureCount !== x.failureCount)
            return y.failureCount - x.failureCount;
        return x.key.localeCompare(y.key);
    });
}
/**
 * Format the heatmap as a fixed-width table for the report. Truncates the
 * key column and limits to `top` rows so noisy reports don't drown the
 * console output.
 */
export function formatHeatmap(entries, top = 20) {
    if (entries.length === 0)
        return "No actions recorded.";
    const slice = entries.slice(0, Math.max(0, top));
    const lines = [];
    lines.push("Top action targets (by frequency):");
    lines.push("-".repeat(78));
    lines.push(`${"Type".padEnd(8)} ${"Count".padStart(6)} ${"OK%".padStart(5)} ${"Fail".padStart(5)} ${"Ext".padStart(4)} ${"Sh".padStart(3)}  Target`);
    lines.push("-".repeat(78));
    for (const e of slice) {
        const okPct = e.count > 0 ? `${Math.round((e.successCount / e.count) * 100)}%` : "--";
        const target = e.key.length > 44 ? e.key.slice(0, 41) + "..." : e.key;
        lines.push([
            e.type.padEnd(8),
            String(e.count).padStart(6),
            okPct.padStart(5),
            String(e.failureCount).padStart(5),
            String(e.blockedExternalCount).padStart(4),
            String(e.shardSkippedCount).padStart(3),
            " ",
            target,
        ].join(" "));
    }
    if (entries.length > slice.length) {
        lines.push(`... (${entries.length - slice.length} more)`);
    }
    return lines.join("\n");
}
