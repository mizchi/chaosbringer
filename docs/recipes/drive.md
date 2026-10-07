# Drive a browser towards a goal

`chaosbringer drive` operates a browser the way a user would, one action at a
time, until a goal holds. The crawl's checks keep running while it does, so a
run that reaches its goal with a broken page on the way says so.

```sh
ANTHROPIC_API_KEY=… chaosbringer drive \
  --url https://shop.example.test/ \
  --goal "add the cheapest T-shirt in size M to the cart" \
  --until-text "1 item in your cart" \
  --exclude /checkout --exclude /logout \
  --video run.webm --out drive-out --save-recipe shop/add-tshirt
```

## What the model sees

Each step, the page goes through Playwright's accessibility snapshot
(`page.ariaSnapshot({ mode: "ai" })`, Playwright 1.59+), not the DOM. That
gives `drive` two things to send the model:

- an **outline** of the page: its landmarks, headings and text, with every
  control it can operate tagged `[#N]`;
- a **candidate list** that repeats those controls with their state and
  where they sit:
  `#3 combobox "Size" options: S, M*, L — in form, under "Classic T-shirt"`.

From these the model answers with one JSON action: `click`, `fill` (with the
text it chose, optionally pressing Enter), `select` an option, `press` a key,
`done`, or `give_up`. Text only by default. `--vision` also sends a
screenshot, for pages whose meaning is in pixels.

Compared with the crawler's CSS scrape, the snapshot also finds every role a
user can operate (checkboxes, tabs, menu items, comboboxes) and elements with
`cursor: pointer` and no role (a `<div onclick>`). Controls inside a dialog
come first. Disabled controls and the inside of iframes are left out.

## What it checks

Every step records the problems it caused:

- uncaught exceptions;
- unhandled rejections;
- console errors;
- failed requests (except those cancelled by navigating on);
- 5xx responses;
- a 4xx on a page load.

The model is shown them as they happen, and the summary lists them by step.

With `--until-url`, `--until-url-matches` or `--until-text`, the model's "done"
is accepted only while that condition holds. If it does not, the model is told
so and keeps going. Without one, "done" ends the run unverified (status
`done`, not `reached`).

`--exclude` URLs are never reached. A link to one is refused, and a step that
lands on one is undone with a history back.

## What it produces

- **A recipe** for a run that reached its goal. Each control is recorded by a
  role selector (`role=button[name="Pay"s] >> nth=1`), which finds it again on
  a later load. The snapshot's refs only last until the next snapshot. A step
  that changed the path waits on replay until it has. Use `--save-recipe
  <name>` to put it in the recipe store, then:

  ```sh
  chaosbringer recipes verify shop/add-tshirt --base-url https://shop.example.test/ --runs 3
  ```

  This replays it and promotes it to verified, after which `recipeDriver`,
  `chaosbringer load` and the rest of the recipe tooling can use it. A run
  that acted on a control with no role and no name cannot be replayed, so it
  produces no recipe, and the summary says which step.
- **A video** with `--video`, recorded with Playwright's `page.screencast`.
  It shows each action annotated on screen and opens with the goal as a
  title card.
- **`drive-report.json`** in `--out`, containing every step, each step's
  problems, the final URL and the model's reasoning.

## Then break it: `--chaos`

A journey `drive` found is a journey worth breaking. `--chaos` replays the
recipe of a run that reached its goal, first clean, then once per fault with
every call the journey made to the app's own API failing. The faults are
`--faults 500,abort,hang`, the same ones the scan's chaos crawls use, and the
endpoints follow the scan's rules: same-origin `fetch`/`xhr`, no static files,
no pages. Each faulted replay is compared with the clean one:

- 🔴 **the app let the failure escape**: an uncaught exception or unhandled
  rejection the clean replay did not have;
- 🟠 **the goal still showed as reached**: with every API call failing, the
  page claims a success the server never confirmed (unless the goal needs no
  API);
- 🟡 **the journey stops at step N**: expected while the API is down. It tells
  you which step depends on which call.

A fault that never fired is reported as such. A journey that calls no API of
its own (a localStorage TodoMVC) is skipped with that reason. `recipeChaos()`
does the same from code, for any recipe.

```sh
chaosbringer drive --url http://localhost:3000/ --goal "add a T-shirt to the cart" \
  --until-text "Added to cart" --chaos --hang-ms 3000
```

Errors this machine causes rather than the site (a proxy that refuses an
analytics host, media the bundled Chromium cannot decode) are kept apart
throughout, using the scan's environment rules. They are neither shown to the
model nor counted as problems.

## Hand the browser to an agent: `--bind`

`--bind` serves the browser `drive` is driving to other Playwright clients
(`browser.bind`, Playwright 1.59+). The attach commands are printed at the
start:

```sh
chaosbringer drive --url … --goal "…" --bind --bind-title shop --keep-open
# in another terminal, or from an agent:
npx playwright cli attach shop
npx playwright cli -s=shop snapshot
# or point an MCP client at it:
npx playwright mcp --endpoint <the printed endpoint>
```

`--keep-open` leaves the browser on the final page until Ctrl-C. An attached
agent can then look at the state a run ended in, or take over where `drive`
stopped. The crawl (`chaosbringer --bind`) and the scan (`chaosbringer scan
--bind`) take the same flag, to watch a crawl's pages live. From code, it is
`bind` on `drive()` and on `CrawlerOptions`.

## Without a model: plans

`--plan plan.json` follows a fixed list of steps against the same snapshot,
with the same checks running. Each step names its control by a substring of
its description, or by a regex written as `"/…/"`:

```json
[
  { "fill": "textbox \"What needs to be done?\"", "value": "Buy milk", "submit": true },
  { "click": "/checkbox \"Toggle Todo\"/" },
  { "click": "link \"Completed\"" }
]
```

A step whose control is not on the page ends the run (`gave-up`, naming the
step). The plan no longer matches the site.

## From code

```ts
import { anthropicDecider, drive, planDecider } from "chaosbringer";

const result = await drive({
  url: "http://localhost:3000/",
  goal: "sign in as the demo user",
  decider: anthropicDecider({ apiKey: process.env.ANTHROPIC_API_KEY! }),
  until: { urlIncludes: "/dashboard" },
  excludePatterns: ["/logout"],
});
if (result.status !== "reached") throw new Error(result.reason);
expect(result.problems).toEqual([]);
```

A `DriveDecider` is one method, `decide(input) => DriveDecision | null`. Write
your own to mix rules and a model. `readAria(page)` gives the same
outline and candidates for use outside `drive`.

Only drive sites you own or are allowed to test. A model fills forms and
presses buttons, so `--exclude` anything destructive.
