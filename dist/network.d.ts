/**
 * Network throttling presets applied via CDP's `Network.emulateNetworkConditions`.
 * Values are the same ones DevTools uses for its built-in profiles.
 */
import type { NetworkProfile } from "./types.js";
export interface NetworkConditions {
    offline: boolean;
    /** Extra round-trip latency added to every request, in ms. */
    latency: number;
    /** Download throughput in bytes / second; -1 disables throttling. */
    downloadThroughput: number;
    /** Upload throughput in bytes / second; -1 disables throttling. */
    uploadThroughput: number;
}
export declare function networkConditionsFor(profile: NetworkProfile): NetworkConditions;
//# sourceMappingURL=network.d.ts.map