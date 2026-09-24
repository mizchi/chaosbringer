// Zero-dependency static server for the sample app. Serves app/index.html and a
// synthetic /api/items?page=N endpoint with a small artificial delay, so the
// lightbringer report shows real network requests / waves / latency.
//
//   node serve.mjs            # http://localhost:4321
//   PORT=5050 node serve.mjs
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? "4321");
const PAGE_SIZE = 300;
const LATENCY_MS = 120; // pretend the API is on a real network

const ADJ = ["Vintage", "Eco", "Compact", "Premium", "Wireless", "Matte", "Solar", "Smart"];
const NOUN = ["Lamp", "Mug", "Chair", "Bottle", "Speaker", "Notebook", "Backpack", "Clock"];

function makePage(page) {
  const start = page * PAGE_SIZE;
  return Array.from({ length: PAGE_SIZE }, (_, i) => {
    const id = start + i;
    return {
      id,
      name: `${ADJ[id % ADJ.length]} ${NOUN[(id >> 3) % NOUN.length]} #${id}`,
      price: ((id * 37) % 9000) / 100 + 1,
    };
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === "/api/items") {
    const page = Number(url.searchParams.get("page") ?? "0");
    await new Promise((r) => setTimeout(r, LATENCY_MS));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(makePage(page)));
    return;
  }

  if (url.pathname === "/" || url.pathname === "/index.html") {
    const html = await readFile(join(here, "app", "index.html"));
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
    return;
  }

  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found");
});

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`sample app on http://localhost:${PORT}`);
});
