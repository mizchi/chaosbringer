import { describe, expect, it } from "vitest";
import { runJourney, type JourneyStep } from "./journey.js";

/**
 * Stateful synthetic server: same factory builds left + right. Each
 * server owns its own todos array, so the journey's per-side cookie
 * jar / state binding can be exercised independently.
 */
function makeServer(opts: { silentlyDropWrites?: boolean } = {}) {
  let nextId = 1;
  const todos: Array<{ id: number; title: string }> = [];
  let cookieSeed = 0;
  return {
    todos,
    handle(url: string, init: RequestInit | undefined): Response {
      const u = new URL(url);
      const cookies = (init?.headers as Headers | undefined)?.get("cookie") ?? "";
      const method = (init?.method ?? "GET").toUpperCase();

      // Session cookie issued on first GET so we can prove the
      // per-side jar binding works end-to-end. Side effects don't
      // depend on the session — the test asserts cookie threading
      // separately.
      const respHeaders = new Headers();
      if (!cookies.includes("sid=")) {
        const sid = `session-${++cookieSeed}`;
        respHeaders.append("set-cookie", `sid=${sid}; Path=/`);
      }

      if (u.pathname === "/api/todos" && method === "POST") {
        const body = JSON.parse(init?.body as string);
        if (opts.silentlyDropWrites) {
          // Bug: return success without persisting.
          return new Response(JSON.stringify({ id: nextId, ...body }), {
            status: 201,
            headers: respHeaders,
          });
        }
        const created = { id: nextId++, ...body };
        todos.push(created);
        return new Response(JSON.stringify(created), {
          status: 201,
          headers: respHeaders,
        });
      }
      if (u.pathname === "/api/todos" && method === "GET") {
        return new Response(JSON.stringify(todos), { status: 200, headers: respHeaders });
      }
      if (u.pathname === "/api/login") {
        respHeaders.append("set-cookie", "auth=token-v1; Path=/");
        return new Response("ok", { status: 200, headers: respHeaders });
      }
      if (u.pathname === "/api/profile") {
        if (!cookies.includes("auth=")) {
          return new Response("unauth", { status: 401, headers: respHeaders });
        }
        return new Response('{"user":"me"}', { status: 200, headers: respHeaders });
      }
      return new Response("not found", { status: 404, headers: respHeaders });
    },
  };
}

function fetcherFor(servers: Record<string, ReturnType<typeof makeServer>>): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const u = new URL(url);
    const base = `${u.protocol}//${u.host}`;
    const server = servers[base];
    if (!server) throw new Error(`unexpected host: ${base}`);
    return server.handle(url, init);
  }) as typeof fetch;
}

describe("runJourney", () => {
  const writeThenReadSteps: JourneyStep[] = [
    { method: "POST", path: "/api/todos", body: { title: "x" }, label: "create" },
    { method: "GET", path: "/api/todos", label: "list" },
  ];

  it("matches both sides when state is symmetric", async () => {
    const left = makeServer();
    const right = makeServer();
    const report = await runJourney({
      left: "http://left",
      right: "http://right",
      steps: writeThenReadSteps,
      fetcher: fetcherFor({ "http://left": left, "http://right": right }),
    });
    expect(report.mismatches).toHaveLength(0);
    expect(report.matches).toHaveLength(2);
    // Both sides actually persisted the write.
    expect(left.todos).toEqual([{ id: 1, title: "x" }]);
    expect(right.todos).toEqual([{ id: 1, title: "x" }]);
  });

  it("flags the read step when right silently drops the write", async () => {
    // The canonical bug class journey is built to catch: POST returns
    // 201 on both sides (identical status / body), but right doesn't
    // actually persist. The subsequent GET shows the divergence.
    const left = makeServer();
    const right = makeServer({ silentlyDropWrites: true });
    const report = await runJourney({
      left: "http://left",
      right: "http://right",
      steps: writeThenReadSteps,
      fetcher: fetcherFor({ "http://left": left, "http://right": right }),
    });
    expect(report.mismatches).toHaveLength(1);
    expect(report.mismatches[0].index).toBe(1);
    expect(report.mismatches[0].label).toBe("list");
    expect(report.mismatches[0].kind).toBe("body");
  });

  it("threads per-side cookies — auth set in step 1 visible to step 2", async () => {
    // Asserts the cookie jar works: a server that 401s without an auth
    // cookie would fail step 2 if step 1's Set-Cookie wasn't carried
    // through.
    const left = makeServer();
    const right = makeServer();
    const steps: JourneyStep[] = [
      { method: "GET", path: "/api/login", label: "login" },
      { method: "GET", path: "/api/profile", label: "profile" },
    ];
    const report = await runJourney({
      left: "http://left",
      right: "http://right",
      steps,
      fetcher: fetcherFor({ "http://left": left, "http://right": right }),
    });
    expect(report.mismatches).toHaveLength(0);
    // Step 2 returned 200, proving the auth cookie was replayed.
    expect(report.matches[1].left.status).toBe(200);
  });

  it("stopOnMismatch halts after the first divergence", async () => {
    const left = makeServer();
    const right = makeServer({ silentlyDropWrites: true });
    // Three steps; mismatch will fire at index 1. With stopOnMismatch
    // we never run index 2 (a 3rd POST).
    const steps: JourneyStep[] = [
      ...writeThenReadSteps,
      { method: "POST", path: "/api/todos", body: { title: "y" } },
    ];
    const report = await runJourney({
      left: "http://left",
      right: "http://right",
      steps,
      stopOnMismatch: true,
      fetcher: fetcherFor({ "http://left": left, "http://right": right }),
    });
    expect(report.stepsChecked).toBe(2);
    // The 3rd POST was skipped entirely — neither side received it.
    expect(left.todos).toHaveLength(1);
    expect(right.todos).toHaveLength(0); // right always drops
  });

  it("JSON object bodies get auto-stringified with application/json", async () => {
    // Round-trip check: the server's parsed body matches what the
    // caller passed.
    const seen: Array<{ headers: Record<string, string>; body: string }> = [];
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers: Record<string, string> = {};
      if (init?.headers instanceof Headers) {
        init.headers.forEach((v, k) => {
          headers[k] = v;
        });
      }
      seen.push({ headers, body: init?.body as string });
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    await runJourney({
      left: "http://l",
      right: "http://r",
      steps: [{ method: "POST", path: "/x", body: { hi: "there" } }],
      fetcher,
    });
    expect(seen).toHaveLength(2);
    expect(seen[0].headers["content-type"]).toBe("application/json");
    expect(JSON.parse(seen[0].body)).toEqual({ hi: "there" });
  });

  it("string bodies are sent verbatim with no auto content-type", async () => {
    const seen: Array<{ headers: Record<string, string>; body: string | undefined }> = [];
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers: Record<string, string> = {};
      if (init?.headers instanceof Headers) {
        init.headers.forEach((v, k) => {
          headers[k] = v;
        });
      }
      seen.push({ headers, body: init?.body as string | undefined });
      return new Response("ok", { status: 200 });
    }) as typeof fetch;
    await runJourney({
      left: "http://l",
      right: "http://r",
      steps: [{ method: "POST", path: "/x", body: "raw=value" }],
      fetcher,
    });
    expect(seen[0].body).toBe("raw=value");
    expect(seen[0].headers["content-type"]).toBeUndefined();
  });

  it("status mismatch wins over body mismatch on the same step", async () => {
    const fetcher = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      return new URL(url).host === "left"
        ? new Response("a", { status: 200 })
        : new Response("b", { status: 500 });
    }) as typeof fetch;
    const report = await runJourney({
      left: "http://left",
      right: "http://right",
      steps: [{ method: "GET", path: "/x" }],
      fetcher,
    });
    expect(report.mismatches[0].kind).toBe("status");
  });

  it("--no-check-body equivalent: checkBody=false skips body hashing", async () => {
    const fetcher = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      return new URL(url).host === "left"
        ? new Response("a", { status: 200 })
        : new Response("b", { status: 200 });
    }) as typeof fetch;
    const report = await runJourney({
      left: "http://left",
      right: "http://right",
      steps: [{ method: "GET", path: "/x" }],
      checkBody: false,
      fetcher,
    });
    // Status matched and body wasn't checked → match.
    expect(report.mismatches).toHaveLength(0);
    expect(report.matches[0].left.bodyHash).toBeUndefined();
  });
});
