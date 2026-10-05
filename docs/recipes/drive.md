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
