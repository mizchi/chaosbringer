/**
 * Network throttling presets applied via CDP's `Network.emulateNetworkConditions`.
 * Values are the same ones DevTools uses for its built-in profiles.
 */
const BPS = 1024; // 1 kilobit in bytes (125 B/s) — keep math readable.
const KBPS = 1000 * BPS;
void BPS;
void KBPS;
export function networkConditionsFor(profile) {
    switch (profile) {
        case "offline":
            return { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 };
        case "slow-3g":
            // ~500 kbps down / ~500 kbps up / 2000 ms RTT — Chrome DevTools "Slow 3G".
            return {
                offline: false,
                latency: 2000,
                downloadThroughput: Math.floor((500 * 1024) / 8),
                uploadThroughput: Math.floor((500 * 1024) / 8),
            };
        case "fast-3g":
            // ~1.6 Mbps down / ~750 kbps up / 562 ms RTT — Chrome DevTools "Fast 3G".
            return {
                offline: false,
                latency: 562,
                downloadThroughput: Math.floor((1.6 * 1024 * 1024) / 8),
                uploadThroughput: Math.floor((750 * 1024) / 8),
            };
    }
}
