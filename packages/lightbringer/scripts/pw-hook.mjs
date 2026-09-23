// Node module-customization entry, injected by the CLI via
// NODE_OPTIONS=--import=<this>. It registers a resolver that swaps the user's
// `@playwright/test` `test` export for lightbringer's auto-instrumented one, so an
// existing spec is measured without any edit. See pw-resolver.mjs.
import { register } from "node:module";
register("./pw-resolver.mjs", import.meta.url);
