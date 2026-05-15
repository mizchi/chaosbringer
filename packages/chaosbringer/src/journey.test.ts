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
    expect(report.mismatches[0].kinds[0]).toBe("body");
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
    expect(report.mismatches[0].kinds[0]).toBe("status");
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

  describe("capture + template substitution", () => {
    /**
     * Stateful synthetic server with create-then-read-by-id flow.
     * Both sides assign IDs independently, so the per-side var bag
     * has to resolve the right template.
     */
    function makeIdServer(opts: { wrongTitleOnGet?: boolean } = {}) {
      const todos: Record<number, { id: number; title: string }> = {};
      let nextId = 1;
      return (url: string, init: RequestInit | undefined): Response => {
        const u = new URL(url);
        const method = (init?.method ?? "GET").toUpperCase();
        if (u.pathname === "/api/todos" && method === "POST") {
          const body = JSON.parse(init?.body as string);
          const id = nextId++;
          todos[id] = { id, ...body };
          return new Response(JSON.stringify(todos[id]), { status: 201 });
        }
        const matchId = u.pathname.match(/^\/api\/todos\/(\d+)$/);
        if (matchId && method === "GET") {
          const id = Number.parseInt(matchId[1], 10);
          const todo = todos[id];
          if (!todo) return new Response("not found", { status: 404 });
          if (opts.wrongTitleOnGet) {
            return new Response(JSON.stringify({ ...todo, title: "WRONG" }), { status: 200 });
          }
          return new Response(JSON.stringify(todo), { status: 200 });
        }
        return new Response("not found", { status: 404 });
      };
    }

    function fetcherForHandlers(handlers: Record<string, ReturnType<typeof makeIdServer>>): typeof fetch {
      return (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        const base = `${new URL(url).protocol}//${new URL(url).host}`;
        const handler = handlers[base];
        if (!handler) throw new Error(`unexpected host: ${base}`);
        return handler(url, init);
      }) as typeof fetch;
    }

    it("captures body.<dotpath> from step N and substitutes in step N+1's path", async () => {
      const leftHandler = makeIdServer();
      const rightHandler = makeIdServer();
      const steps: JourneyStep[] = [
        {
          method: "POST",
          path: "/api/todos",
          body: { title: "x" },
          capture: [{ from: "body.id", as: "todoId" }],
          label: "create",
        },
        { method: "GET", path: "/api/todos/{{todoId}}", label: "read-by-id" },
      ];
      const report = await runJourney({
        left: "http://left",
        right: "http://right",
        steps,
        fetcher: fetcherForHandlers({ "http://left": leftHandler, "http://right": rightHandler }),
      });
      expect(report.mismatches).toHaveLength(0);
      expect(report.matches[1].request.path).toBe("/api/todos/{{todoId}}");
      // Both sides resolved {{todoId}} → 1 and got 200 with matching body.
      expect(report.matches[1].left.status).toBe(200);
    });

    it("flags the read step when v2 returns a wrong title on the captured id", async () => {
      // Per-side captures both yield id=1, but v2's read by id returns
      // a mutated title. The body hash diverges on step 1.
      const steps: JourneyStep[] = [
        {
          method: "POST",
          path: "/api/todos",
          body: { title: "buy milk" },
          capture: [{ from: "body.id", as: "todoId" }],
        },
        { method: "GET", path: "/api/todos/{{todoId}}" },
      ];
      const report = await runJourney({
        left: "http://left",
        right: "http://right",
        steps,
        fetcher: fetcherForHandlers({
          "http://left": makeIdServer(),
          "http://right": makeIdServer({ wrongTitleOnGet: true }),
        }),
      });
      expect(report.mismatches).toHaveLength(1);
      expect(report.mismatches[0].kinds[0]).toBe("body");
      expect(report.mismatches[0].index).toBe(1);
    });

    it("template substitution works in headers (bearer-token flow)", async () => {
      // capture Authorization-bound token from a login response;
      // substitute it into the next step's Authorization header.
      const seen: string[] = [];
      const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.endsWith("/login")) {
          return new Response(JSON.stringify({ token: "abc123" }), { status: 200 });
        }
        const auth = (init?.headers as Headers).get("authorization") ?? "";
        seen.push(auth);
        return new Response("{}", { status: 200 });
      }) as typeof fetch;
      const steps: JourneyStep[] = [
        {
          method: "POST",
          path: "/login",
          body: {},
          capture: [{ from: "body.token", as: "tok" }],
        },
        {
          method: "GET",
          path: "/profile",
          headers: { authorization: "Bearer {{tok}}" },
        },
      ];
      await runJourney({
        left: "http://l",
        right: "http://r",
        steps,
        fetcher,
      });
      // Both sides sent the substituted header verbatim.
      expect(seen).toContain("Bearer abc123");
      expect(seen.filter((s) => s === "Bearer abc123")).toHaveLength(2);
    });

    it("template substitution works inside JSON object bodies", async () => {
      const seen: string[] = [];
      const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.endsWith("/seed")) {
          return new Response(JSON.stringify({ ref: "ref-7" }), { status: 200 });
        }
        seen.push(init?.body as string);
        return new Response("{}", { status: 200 });
      }) as typeof fetch;
      const steps: JourneyStep[] = [
        {
          method: "POST",
          path: "/seed",
          body: {},
          capture: [{ from: "body.ref", as: "ref" }],
        },
        {
          method: "POST",
          path: "/use",
          body: { parent: "{{ref}}", nested: { also: "{{ref}}" } },
        },
      ];
      await runJourney({
        left: "http://l",
        right: "http://r",
        steps,
        fetcher,
      });
      const parsed = JSON.parse(seen[0]);
      expect(parsed.parent).toBe("ref-7");
      expect(parsed.nested.also).toBe("ref-7");
    });

    it("captures from response headers (header.<name>)", async () => {
      const seen: string[] = [];
      const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.endsWith("/start")) {
          return new Response("", {
            status: 200,
            headers: { "x-trace-id": "trace-42" },
          });
        }
        const traceHeader = (init?.headers as Headers).get("x-trace") ?? "";
        seen.push(traceHeader);
        return new Response("{}", { status: 200 });
      }) as typeof fetch;
      await runJourney({
        left: "http://l",
        right: "http://r",
        steps: [
          {
            method: "GET",
            path: "/start",
            capture: [{ from: "header.x-trace-id", as: "trace" }],
          },
          { method: "GET", path: "/follow", headers: { "x-trace": "{{trace}}" } },
        ],
        fetcher,
      });
      expect(seen).toContain("trace-42");
    });

    it("a failed capture leaves the var unset; downstream {{var}} renders as literal", async () => {
      // The journey doesn't lie about missing data. A path containing
      // an unresolved {{var}} goes out garbled and the server's response
      // (or lack thereof) shows up in the SideResult.
      const seen: string[] = [];
      const fetcher = (async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        seen.push(url);
        if (url.endsWith("/seed")) {
          return new Response("not-json", { status: 200 });
        }
        return new Response("{}", { status: 200 });
      }) as typeof fetch;
      await runJourney({
        left: "http://l",
        right: "http://r",
        steps: [
          {
            method: "GET",
            path: "/seed",
            // Body isn't JSON → parse fails → capture skipped.
            capture: [{ from: "body.id", as: "todoId" }],
          },
          { method: "GET", path: "/items/{{todoId}}" },
        ],
        fetcher,
      });
      expect(seen).toContain("http://l/items/%7B%7BtodoId%7D%7D");
    });

    it("per-actor cookie jars stay isolated within one side", async () => {
      const seenCookies: string[] = [];
      const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        const cookie = (init?.headers as Headers).get("cookie") ?? "";
        if (url.endsWith("/login/alice")) {
          return new Response("", { status: 200, headers: { "set-cookie": "u=alice; Path=/" } });
        }
        if (url.endsWith("/login/bob")) {
          return new Response("", { status: 200, headers: { "set-cookie": "u=bob; Path=/" } });
        }
        seenCookies.push(cookie);
        return new Response("ok", { status: 200 });
      }) as typeof fetch;
      await runJourney({
        left: "http://l",
        right: "http://r",
        steps: [
          { method: "GET", path: "/login/alice", actor: "alice" },
          { method: "GET", path: "/login/bob", actor: "bob" },
          { method: "GET", path: "/whoami", actor: "bob" },
        ],
        fetcher,
      });
      expect(seenCookies.some((c) => c.includes("u=bob"))).toBe(true);
      expect(seenCookies.every((c) => !c.includes("u=alice"))).toBe(true);
    });

    it("per-actor vars stay isolated within one side", async () => {
      const calls: string[] = [];
      const fetcher = (async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("/create/alice")) return new Response(JSON.stringify({ id: 1 }), { status: 200 });
        if (url.includes("/create/bob")) return new Response(JSON.stringify({ id: 2 }), { status: 200 });
        calls.push(url);
        return new Response("ok", { status: 200 });
      }) as typeof fetch;
      await runJourney({
        left: "http://l",
        right: "http://r",
        steps: [
          {
            method: "POST", path: "/create/alice", body: {},
            actor: "alice", capture: [{ from: "body.id", as: "todoId" }],
          },
          {
            method: "POST", path: "/create/bob", body: {},
            actor: "bob", capture: [{ from: "body.id", as: "todoId" }],
          },
          { method: "GET", path: "/read/{{todoId}}", actor: "alice" },
          { method: "GET", path: "/read/{{todoId}}", actor: "bob" },
        ],
        fetcher,
      });
      const reads = calls.filter((u) => u.includes("/read/"));
      expect(reads).toContain("http://l/read/1");
      expect(reads).toContain("http://l/read/2");
      expect(reads).toContain("http://r/read/1");
      expect(reads).toContain("http://r/read/2");
    });

    it("flags a body mismatch when v2 leaks actor A's data into actor B's read", async () => {
      function makeTenantServer(opts: { leakAcrossUsers?: boolean } = {}) {
        const byUser = new Map<string, Array<{ title: string }>>();
        return (url: string, init: RequestInit | undefined): Response => {
          const u = new URL(url);
          const cookie = (init?.headers as Headers).get("cookie") ?? "";
          const userMatch = cookie.match(/u=(\w+)/);
          const user = userMatch ? userMatch[1] : "anon";
          const method = (init?.method ?? "GET").toUpperCase();
          if (u.pathname === "/login" && method === "POST") {
            const body = JSON.parse(init?.body as string);
            return new Response("ok", {
              status: 200,
              headers: { "set-cookie": `u=${body.user}; Path=/` },
            });
          }
          if (u.pathname === "/todos" && method === "POST") {
            const body = JSON.parse(init?.body as string);
            const list = byUser.get(user) ?? [];
            list.push({ title: body.title });
            byUser.set(user, list);
            return new Response("ok", { status: 200 });
          }
          if (u.pathname === "/todos" && method === "GET") {
            if (opts.leakAcrossUsers) {
              const all: Array<{ title: string }> = [];
              for (const v of byUser.values()) all.push(...v);
              return new Response(JSON.stringify(all), { status: 200 });
            }
            return new Response(JSON.stringify(byUser.get(user) ?? []), { status: 200 });
          }
          return new Response("not found", { status: 404 });
        };
      }
      const leftHandler = makeTenantServer();
      const rightHandler = makeTenantServer({ leakAcrossUsers: true });
      const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        const host = new URL(url).host;
        const h = host === "left" ? leftHandler : rightHandler;
        return h(url, init);
      }) as typeof fetch;
      const steps: JourneyStep[] = [
        { method: "POST", path: "/login", body: { user: "alice" }, actor: "alice" },
        { method: "POST", path: "/todos", body: { title: "alice-secret" }, actor: "alice" },
        { method: "POST", path: "/login", body: { user: "bob" }, actor: "bob" },
        { method: "GET", path: "/todos", actor: "bob", label: "bob-lists" },
      ];
      const report = await runJourney({
        left: "http://left",
        right: "http://right",
        steps,
        fetcher,
      });
      expect(report.mismatches).toHaveLength(1);
      expect(report.mismatches[0].label).toBe("bob-lists");
      expect(report.mismatches[0].kinds).toContain("body");
    });

    it("per-side vars stay isolated — left's capture does not leak to right", async () => {
      // Each side captures id=1 from its own POST. If they shared a
      // var bag, a race would let one side see the other's id.
      const calls: string[] = [];
      const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        const host = new URL(url).host;
        const method = (init?.method ?? "GET").toUpperCase();
        if (url.endsWith("/api/todos") && method === "POST") {
          // Left assigns id=100, right assigns id=200.
          const id = host === "l" ? 100 : 200;
          return new Response(JSON.stringify({ id }), { status: 201 });
        }
        calls.push(url);
        return new Response("{}", { status: 200 });
      }) as typeof fetch;
      await runJourney({
        left: "http://l",
        right: "http://r",
        steps: [
          {
            method: "POST",
            path: "/api/todos",
            body: { title: "x" },
            capture: [{ from: "body.id", as: "todoId" }],
          },
          { method: "GET", path: "/api/todos/{{todoId}}" },
        ],
        fetcher,
      });
      // Each side resolved its OWN id, not the other's.
      expect(calls).toContain("http://l/api/todos/100");
      expect(calls).toContain("http://r/api/todos/200");
    });
  });
});
