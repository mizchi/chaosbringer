import { spawn } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const PACKAGE_DIR = join(import.meta.dirname, "../..");

describe("fixtures/site/server.ts run standalone", () => {
  let work: string | undefined;

  afterEach(() => {
    if (work) rmSync(work, { recursive: true, force: true });
    work = undefined;
  });

  it("serves from a checkout whose path has a space and a non-ASCII name", async () => {
    // import.meta.url is percent-encoded ("fixture%20site%20%C3%A9-"), while
    // process.argv[1] is the raw path: comparing the two said "not main" and
    // `pnpm fixture:serve` exited 0 without serving.
    work = mkdtempSync(join(tmpdir(), "fixture site é-"));
    copyFileSync(join(import.meta.dirname, "server.ts"), join(work, "server.ts"));
    writeFileSync(join(work, "package.json"), JSON.stringify({ type: "module" }));

    // tsx resolves from this package, as `pnpm fixture:serve` would.
    const child = spawn(process.execPath, ["--import", "tsx", join(work, "server.ts")], {
      cwd: PACKAGE_DIR,
      env: { ...process.env, PORT: "0" },
    });
    const outcome = await new Promise<string>((resolve) => {
      let out = "";
      child.stdout.on("data", (d: Buffer) => {
        out += d.toString();
        if (out.includes("Fixture server listening on")) resolve(out);
      });
      child.stderr.on("data", (d: Buffer) => {
        out += d.toString();
      });
      child.on("exit", (code) => resolve(`exited ${code} before serving: ${out}`));
    });
    child.kill();

    expect(outcome).toMatch(/Fixture server listening on http:\/\/127\.0\.0\.1:\d+/);
  });
});
