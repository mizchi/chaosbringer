import { definePattern, handler, html, json, page, type Variant } from "../pattern.js";

const CONTACTS = 1000;

// "Sync contacts" downloads the address book (1,000 contacts), stores it in
// IndexedDB for offline use, and when the local copy is written tells the
// server it can mark the sync done (POST /api/sync/ack). Both pages store
// the same records in the same object store.
//
// The slow page opens one readwrite transaction per contact: 1,000
// transactions, each scheduled, committed and reported back on its own, and
// on one store they run one after another. The fixed page puts all 1,000 in
// one transaction and waits for its single complete event.
//
// IndexedDB work is asynchronous and happens off the page's main thread,
// and the crawl's settle does not wait for it (only for requests). The ack
// the page sends once the write has committed is what puts the write's
// duration inside the click's span: network.settledMs is when the span's
// last request ended, and the ack is it.
const writers: Record<Variant, string> = {
  slow: `
    function store(db, contacts) {
      return Promise.all(contacts.map((c) => new Promise((resolve, reject) => {
        const tx = db.transaction("contacts", "readwrite");
        tx.objectStore("contacts").put(c);
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      })));
    }`,
  fixed: `
    function store(db, contacts) {
      return new Promise((resolve, reject) => {
        const tx = db.transaction("contacts", "readwrite");
        const os = tx.objectStore("contacts");
        for (const c of contacts) os.put(c);
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
    }`,
};

const contacts = Array.from({ length: CONTACTS }, (_, i) => ({
  id: i + 1,
  name: `Contact ${i + 1}`,
  email: `contact${i + 1}@example.com`,
  phone: `+1 555 01${String(i).padStart(3, "0")}`,
  notes: "Met at the spring conference; follow up about the integration pilot and the pricing questions.",
}));

export default definePattern({
  id: "idb-transaction-per-item",
  title: "One IndexedDB transaction per record",
  category: "main-thread",
  description: `"Sync contacts" takes several times longer than it should to save ${CONTACTS} contacts for offline use. The page writes them to IndexedDB with one readwrite transaction per record: ${CONTACTS} transactions on the same store, each scheduled, committed and acknowledged one after another, where one transaction would commit them all at once.`,
  fix: "Batch writes into one transaction (put every record on one objectStore, await one oncomplete), or a few bounded chunks for very large imports; libraries such as idb / Dexie's bulkPut do this.",
  routes: (variant) => ({
    "/": html(
      page(
        "Contacts",
        `<h1>Contacts</h1>
<button id="sync" type="button">Sync contacts</button>
<p id="out"></p>
<script>
    ${writers[variant]}
    // A fresh database per page visit, so every crawl writes into an empty store.
    const dbName = "contacts-" + Math.random().toString(36).slice(2);
    const opened = new Promise((resolve, reject) => {
      const req = indexedDB.open(dbName, 1);
      req.onupgradeneeded = () => req.result.createObjectStore("contacts", { keyPath: "id" });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    document.getElementById("sync").addEventListener("click", async () => {
      const out = document.getElementById("out");
      out.textContent = "Syncing…";
      const [db, contacts] = await Promise.all([opened, fetch("/api/contacts").then((r) => r.json())]);
      await store(db, contacts);
      await fetch("/api/sync/ack", { method: "POST" });
      out.textContent = contacts.length + " contacts saved offline";
    });
</script>`,
      ),
    ),
    "/api/contacts": json(contacts),
    "/api/sync/ack": handler((req, res) => {
      req.resume();
      res.writeHead(204, { "cache-control": "no-store" });
      res.end();
    }),
  }),
  crawl: {
    maxPages: 1,
    maxActionsPerPage: 1,
    seed: 1,
    // A 1.2 s quiet window: the settle waits for no IndexedDB work, so the
    // window after the contacts download must outlast the slow write (~350 ms
    // here) for its ack to land inside the span.
    settle: 1200,
    actionWeights: { scroll: 0 },
  },
  expect: {
    key: "/ :: click *",
    metric: "network.settledMs",
    direction: "lower",
    // slow: the ack ends ~450 ms into the span (1,000 commits in a row);
    // fixed: ~145 ms (the download, one commit, the ack, and the crawl's
    // own overhead, which both variants pay).
    minImprovement: { ratio: 1.8, absolute: 150 },
  },
});
