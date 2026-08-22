// Types for bridge.mjs. It stays plain JS so `chaosbringer model run
// --config` can `import()` it under bare node, with no TS loader.
import type { RunPlanOptions } from "chaosbringer";

declare const bridge: Omit<RunPlanOptions, "baseUrl" | "rules"> & {
  rules: Record<string, RegExp | string | { urlPattern: RegExp | string; methods?: string[] }>;
};
export default bridge;
