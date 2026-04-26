/**
 * Group similar PageError entries into clusters so a run with 100 identical
 * `console.error("Failed to load X")` calls becomes one cluster with count=100
 * instead of 100 lines.
 *
 * A "fingerprint" normalises the message — strips URLs, numbers, and stack
 * locations — so that `HTTP 500 on /api/users/42` and `HTTP 500 on /api/users/99`
 * collapse to the same cluster but don't swallow unrelated errors.
 */
/** Normalise an error message to its fingerprint. */
export function fingerprintError(err) {
    let msg = err.message ?? "";
    msg = msg
        // URLs in message bodies vary per run — collapse them.
        .replace(/https?:\/\/[^\s"'()<>]+/g, "<url>")
        // Source locations like `foo.js:123:45`
        .replace(/:\d+:\d+/g, ":<loc>")
        // Ephemeral ports (4-5 digits). Keep 6+ digit numbers; they're rarely a port.
        .replace(/:\d{4,5}\b/g, ":<port>")
        // Any other long-ish number run — ids, counts, timestamps
        .replace(/\b\d{3,}\b/g, "<n>")
        // Collapse whitespace
        .replace(/\s+/g, " ")
        .trim();
    // Keep the prefix so messages of different shapes don't collide.
    return msg.slice(0, 160);
}
/** Collapse a list of errors into stable clusters. */
export function clusterErrors(errors) {
    const bucket = new Map();
    for (const err of errors) {
        const fp = fingerprintError(err);
        const key = `${err.type}|${fp}`;
        const existing = bucket.get(key);
        if (existing) {
            existing.count++;
            if (err.url && !existing.urls.includes(err.url))
                existing.urls.push(err.url);
            if (err.invariantName && existing.invariantNames && !existing.invariantNames.includes(err.invariantName)) {
                existing.invariantNames.push(err.invariantName);
            }
        }
        else {
            bucket.set(key, {
                key,
                type: err.type,
                fingerprint: fp,
                sample: err,
                count: 1,
                urls: err.url ? [err.url] : [],
                invariantNames: err.invariantName ? [err.invariantName] : undefined,
            });
        }
    }
    // Sort by count descending — most frequent first, which is the priority for triage.
    return [...bucket.values()].sort((a, b) => b.count - a.count);
}
