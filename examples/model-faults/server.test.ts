/**
 * The two app servers run standalone (`pnpm dev`, `tsx redteam/server.ts`)
 * from a checkout whose path has a space and a non-ASCII name.
 *
 * import.meta.url is percent-encoded ("model%20faults%20%C3%A9-") while
 * process.argv[1] is the raw path, so comparing the two said "not main" and
 * the server exited 0 without serving.
 */
import { spawn } from "node:child_process";
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const here = import.meta.dirname;
let work: string;

beforeAll(() => {
  // A copy of just what the two servers read, with the workspace's
  // node_modules for hono.
  work = mkdtempSync(join(tmpdir(), "model faults é-"));
  writeFileSync(join(work, "package.json"), JSON.stringify({ type: "module" }));
  symlinkSync(join(here, "../../node_modules"), join(work, "node_modules"));
  for (const f of ["serve.ts", "server.ts"]) copyFileSync(join(here, f), join(work, f));
  cpSync(join(here, "public"), join(work, "public"), { recursive: true });
  mkdirSync(join(work, "redteam"));
  copyFileSync(join(here, "redteam/server.ts"), join(work, "redteam/server.ts"));
  cpSync(join(here, "redteam/public"), join(work, "redteam/public"), { recursive: true });
});

afterAll(() => {
  rmSync(work, { recursive: true, force: true });
});

/** Run `file` through tsx and resolve with its first line, or how it exited. */
function boot(file: string): Promise<string> {
  const child = spawn(process.execPath, ["--import", "tsx", join(work, file)], {
    cwd: here,
    env: { ...process.env, PORT: "0", FIXED: "0" },
  });
  return new Promise<string>((resolve) => {
    let out = "";
    child.stdout.on("data", (d: Buffer) => {
      out += d.toString();
      if (out.includes("\n")) {
        child.kill();
        resolve(out);
      }
    });
    child.stderr.on("data", (d: Buffer) => {
      out += d.toString();
    });
    child.on("exit", (code) => resolve(`exited ${code} before serving: ${out}`));
  });
}

describe("standalone servers from a path with a space", () => {
  it("server.ts serves", async () => {
    expect(await boot("server.ts")).toMatch(/checkout app \(buggy\) on http:\/\/127\.0\.0\.1:\d+/);
  });

  it("redteam/server.ts serves", async () => {
    expect(await boot("redteam/server.ts")).toMatch(/redteam app \(buggy\) on http:\/\/127\.0\.0\.1:\d+/);
  });
});
