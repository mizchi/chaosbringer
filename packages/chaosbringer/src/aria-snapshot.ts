/**
 * The page as Playwright's accessibility snapshot sees it, turned into
 * things to act on.
 *
 * `page.ariaSnapshot({ mode: "ai" })` (Playwright 1.59) renders the
 * accessibility tree as YAML with a `[ref=eN]` on every node, and
 * `page.locator("aria-ref=eN")` acts on that node until the next snapshot.
 * Compared with scraping the DOM by CSS selector (`action-targets.ts`, and
 * `discoverCandidates` in `recipes/investigate.ts`) it gives:
 *
 * - every role a user can operate, not a fixed list of tags: checkboxes,
 *   radios, tabs, menu items, comboboxes, searchboxes;
 * - the accessible name a screen reader would read, and states (checked,
 *   selected, disabled, a field's current value);
 * - where each control sits: inside which landmark or dialog, under which
 *   heading. "Pay" in the checkout form and "Pay" in a promo banner read
 *   the same in a flat list;
 * - elements with `cursor: pointer` and no role, which the CSS scrape
 *   cannot see (a `<div onclick>`).
 *
 * The parse is of the YAML-ish text format, which is stable across the
 * 1.5x/1.6x releases. Anything it does not recognise is skipped, never
 * guessed.
 */

import type { Page } from "playwright";

/** One node of the snapshot. */
export interface AriaNode {
  role: string;
  name?: string;
  /** `[ref=eN]`: valid for `aria-ref=` until the next snapshot. */
  ref?: string;
  /** `[checked]`, `[level=2]`, `[cursor=pointer]` … (`true` for bare flags). */
  attrs: Record<string, string | true>;
  /** Text after the colon: a field's value, a paragraph's text. */
  text?: string;
  /** `/url:` of a link. */
  url?: string;
  depth: number;
  /** Index of the parent in the node array, -1 at the top. */
  parent: number;
  /** Line in the original snapshot. */
  line: number;
}

/** What acting on a candidate means. */
export type AriaActionType = "link" | "button" | "input" | "select";

export interface AriaCandidate {
  index: number;
  ref: string;
  role: string;
  name?: string;
  type: AriaActionType;
  /**
   * A selector that finds the same element on a later load of the page:
   * `role=button[name="Pay"s] >> nth=1`. `undefined` when there is none
   * (a nameless clickable `generic`): the element can be acted on now, by
   * `ref`, but a recorded step could not find it again.
   */
  selector?: string;
  /** For a model: `button "Pay" — in form, under "Checkout"`. */
  description: string;
  /** A field's current value, a combobox's selected option. */
  value?: string;
  /** A combobox's options, by label. */
  options?: string[];
  href?: string;
  /** Inside a dialog: what the user can act on first. */
  inDialog: boolean;
}

const LINE = /^(\s*)- (.*)$/;
const HEAD = /^([a-z][a-zA-Z]*)(?: ("(?:[^"\\]|\\.)*"))?((?: \[[^\]]*\])*)(?::(?: (.*))?)?$/;
const ATTR = /\[([^\]=]+)(?:=([^\]]*))?\]/g;

/** Parse the snapshot text. Lines it does not understand are dropped. */
export function parseAriaSnapshot(text: string): AriaNode[] {
  const nodes: AriaNode[] = [];
  const stack: { depth: number; index: number }[] = [];
  const lines = text.split("\n");
  lines.forEach((raw, line) => {
    const m = LINE.exec(raw);
    if (!m) return;
    const depth = m[1]!.length / 2;
    const body = m[2]!;
    while (stack.length > 0 && stack[stack.length - 1]!.depth >= depth) stack.pop();
    const parent = stack.length > 0 ? stack[stack.length - 1]!.index : -1;
    if (body.startsWith("/url:")) {
      if (parent >= 0) nodes[parent]!.url = unquote(body.slice(5).trim());
      return;
    }
    if (body.startsWith("/")) return; // other properties (`/placeholder:` …)
    const h = HEAD.exec(body);
    if (!h) return;
    const attrs: Record<string, string | true> = {};
    let ref: string | undefined;
    for (const a of (h[3] ?? "").matchAll(ATTR)) {
      const key = a[1]!.trim();
      const value = a[2];
      if (key === "ref" && value) ref = value;
      else attrs[key] = value ?? true;
    }
    const node: AriaNode = { role: h[1]!, attrs, depth, parent, line };
    if (h[2] !== undefined) node.name = unquote(h[2]);
    if (ref !== undefined) node.ref = ref;
    if (h[4] !== undefined && h[4] !== "") node.text = unquote(h[4]);
    nodes.push(node);
    stack.push({ depth, index: nodes.length - 1 });
  });
  return nodes;
}

/** A YAML scalar as the snapshot writes it: bare, `"json-escaped"` or `'single'`. */
function unquote(s: string): string {
  if (s.startsWith('"') && s.endsWith('"')) {
    try {
      return JSON.parse(s) as string;
    } catch {
      return s.slice(1, -1);
    }
  }
  if (s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1).replace(/''/g, "'");
  return s;
}

const CLICK_ROLES = new Set([
  "button",
  "checkbox",
  "radio",
  "switch",
  "tab",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "treeitem",
  "option",
]);
const FILL_ROLES = new Set(["textbox", "searchbox", "spinbutton", "slider"]);
/** Containers a description names: "in dialog \"Cookies\"". */
const CONTEXT_ROLES = new Set([
  "banner",
  "navigation",
  "main",
  "contentinfo",
  "complementary",
  "search",
  "form",
  "dialog",
  "alertdialog",
  "region",
  "menu",
  "menubar",
  "tablist",
  "toolbar",
  "table",
]);

function actionType(node: AriaNode, nodes: readonly AriaNode[], index: number): AriaActionType | null {
  if (node.role === "link") return "link";
  if (node.role === "combobox") return children(nodes, index).some((c) => c.role === "option") ? "select" : "input";
  if (FILL_ROLES.has(node.role)) return "input";
  if (node.role === "option") {
    // A `<select>`'s option is chosen through its combobox, not clicked.
    const p = nodes[node.parent];
    return p?.role === "combobox" ? null : "button";
  }
  if (CLICK_ROLES.has(node.role)) return "button";
  if (node.attrs.cursor === "pointer") return "button";
  return null;
}

function children(nodes: readonly AriaNode[], index: number): AriaNode[] {
  return nodes.filter((n) => n.parent === index);
}

function ancestors(nodes: readonly AriaNode[], index: number): AriaNode[] {
  const out: AriaNode[] = [];
  for (let p = nodes[index]!.parent; p >= 0; p = nodes[p]!.parent) out.push(nodes[p]!);
  return out;
}

/**
 * Inside an iframe, which a page-level selector cannot reach. Read from the
 * tree, not the ref: a frame's refs look like `f1e2`, but so do the main
 * frame's after a navigation (Playwright 1.63).
 */
function inFrame(nodes: readonly AriaNode[], index: number): boolean {
  return ancestors(nodes, index).some((a) => a.role === "iframe");
}

export interface AriaCandidateOptions {
  /** At most this many, dialogs first, then in document order. Default 60. */
  max?: number;
}

/**
 * The operable nodes of `nodes`, in the order a user meets them, with a
 * dialog's controls first (an open dialog is what the user faces).
 *
 * Left out: disabled controls; a `<select>`'s options (chosen through the
 * combobox); a clickable `generic` that wraps a real control (the control is
 * the candidate) or sits inside one; and anything inside an iframe, whose
 * refs a page-level selector cannot reach.
 */
export function ariaCandidates(nodes: readonly AriaNode[], { max = 60 }: AriaCandidateOptions = {}): AriaCandidate[] {
  const picked: { node: AriaNode; i: number; type: AriaActionType }[] = [];
  nodes.forEach((node, i) => {
    if (!node.ref || inFrame(nodes, i) || node.attrs.disabled) return;
    const type = actionType(node, nodes, i);
    if (!type) return;
    if (!CLICK_ROLES.has(node.role) && !FILL_ROLES.has(node.role) && node.role !== "link" && node.role !== "combobox") {
      // A pointer-cursor node: only when it is the control itself.
      if (ancestors(nodes, i).some((a) => actionType(a, nodes, nodes.indexOf(a)) !== null && a.role !== "generic")) return;
      if (descendants(nodes, i).some((d) => d.role === "link" || CLICK_ROLES.has(d.role) || FILL_ROLES.has(d.role))) return;
      // The cursor is inherited: only the outermost node that has it counts.
      if (ancestors(nodes, i).some((a) => a.attrs.cursor === "pointer")) return;
    }
    picked.push({ node, i, type });
  });
  const inDialog = (i: number) => ancestors(nodes, i).some((a) => a.role === "dialog" || a.role === "alertdialog");
  const ordered = [...picked.filter((p) => inDialog(p.i)), ...picked.filter((p) => !inDialog(p.i))].slice(0, max);
  return ordered.map(({ node, i, type }, index) => {
    const opts = type === "select" ? children(nodes, i).filter((c) => c.role === "option") : [];
    const value =
      type === "select" ? opts.find((o) => o.attrs.selected)?.name : type === "input" ? node.text : undefined;
    const candidate: AriaCandidate = {
      index,
      ref: node.ref!,
      role: node.role,
      type,
      description: describe(nodes, i, value, opts),
      inDialog: inDialog(i),
    };
    if (node.name !== undefined) candidate.name = node.name;
    const selector = stableSelector(nodes, i);
    if (selector) candidate.selector = selector;
    if (value !== undefined) candidate.value = value;
    if (opts.length > 0) candidate.options = opts.map((o) => o.name ?? "").filter(Boolean);
    if (node.url !== undefined) candidate.href = node.url;
    return candidate;
  });
}

function descendants(nodes: readonly AriaNode[], index: number): AriaNode[] {
  const out: AriaNode[] = [];
  const depth = nodes[index]!.depth;
  for (let j = index + 1; j < nodes.length && nodes[j]!.depth > depth; j++) out.push(nodes[j]!);
  return out;
}

/**
 * `role=<role>[name="<name>"s] >> nth=<k>`, where k counts the earlier nodes
 * the same selector matches (Playwright's role selector skips hidden nodes,
 * as the snapshot does). A nameless node counts every earlier node of its
 * role. A role-less clickable has no role to select by: `undefined`.
 */
function stableSelector(nodes: readonly AriaNode[], index: number): string | undefined {
  const node = nodes[index]!;
  if (node.role === "generic" || !node.role) return undefined;
  const matches = (n: AriaNode, j: number) => n.role === node.role && (node.name === undefined || n.name === node.name) && !inFrame(nodes, j);
  const k = nodes.slice(0, index).filter(matches).length;
  const base = node.name === undefined ? `role=${node.role}` : `role=${node.role}[name=${JSON.stringify(node.name)}s]`;
  const total = nodes.filter(matches).length;
  return total > 1 ? `${base} >> nth=${k}` : base;
}

const STATES = ["checked", "selected", "pressed", "expanded", "level"] as const;

function describe(nodes: readonly AriaNode[], index: number, value: string | undefined, opts: AriaNode[]): string {
  const node = nodes[index]!;
  const label = node.name ?? (node.role === "generic" ? node.text : undefined);
  let s = node.role === "generic" ? "clickable" : node.role;
  if (label) s += ` ${JSON.stringify(truncate(label, 80))}`;
  for (const k of STATES) {
    const v = node.attrs[k];
    if (v === true) s += ` [${k}]`;
    else if (v !== undefined) s += ` [${k}=${v}]`;
  }
  if (opts.length > 0) {
    s += ` options: ${opts.map((o) => `${o.name ?? ""}${o.attrs.selected ? "*" : ""}`).join(", ")}`;
  } else if (value !== undefined && value !== "") {
    s += ` = ${JSON.stringify(truncate(value, 60))}`;
  }
  if (node.url) s += ` -> ${truncate(node.url, 80)}`;
  const where = context(nodes, index);
  return where ? `${s} — ${where}` : s;
}

/** `in dialog "Cookies", under "Checkout"`: the nearest container and heading. */
function context(nodes: readonly AriaNode[], index: number): string {
  const parts: string[] = [];
  const container = ancestors(nodes, index).find((a) => CONTEXT_ROLES.has(a.role));
  if (container) parts.push(`in ${container.role}${container.name ? ` ${JSON.stringify(truncate(container.name, 40))}` : ""}`);
  for (let j = index - 1; j >= 0; j--) {
    const n = nodes[j]!;
    if (n.role === "heading" && (n.name || n.text)) {
      parts.push(`under ${JSON.stringify(truncate((n.name ?? n.text)!, 50))}`);
      break;
    }
  }
  return parts.join(", ");
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

export interface OutlineOptions {
  /** Lines kept. Default 150. */
  maxLines?: number;
}

/**
 * The page as a model should read it: one line per node, indented like the
 * snapshot, refs and urls left out, each candidate tagged `[#index]` so the
 * outline and the candidate list refer to the same things, long text cut.
 */
export function ariaOutline(
  nodes: readonly AriaNode[],
  candidates: ReadonlyArray<Pick<AriaCandidate, "ref" | "index">>,
  { maxLines = 150 }: OutlineOptions = {},
): string {
  const byRef = new Map(candidates.map((c) => [c.ref, c.index]));
  const out = nodes.map((n) => {
    const idx = n.ref === undefined ? undefined : byRef.get(n.ref);
    let line = `${"  ".repeat(n.depth)}- ${idx === undefined ? "" : `[#${idx}] `}`;
    if (n.role === "text") line += `text: ${n.text ?? ""}`;
    else {
      line += n.role;
      if (n.name !== undefined) line += ` ${JSON.stringify(n.name)}`;
      for (const [k, v] of Object.entries(n.attrs)) {
        if (k === "cursor") continue;
        line += v === true ? ` [${k}]` : ` [${k}=${v}]`;
      }
      if (n.text !== undefined) line += `: ${n.text}`;
    }
    return line.length > 160 ? `${line.slice(0, 159)}…` : line;
  });
  if (out.length <= maxLines) return out.join("\n");
  return [...out.slice(0, maxLines), `… (${out.length - maxLines} more lines)`].join("\n");
}

/** One node of `ariaSnapshotJSON` (Playwright 1.63). */
type JsonAriaNode = { role: string; name?: string; ref?: string; text?: string; url?: string; children?: (JsonAriaNode | string)[] } & Record<string, unknown>;

/** `page.ariaSnapshotJSON()`'s tree as the flat node list `parseAriaSnapshot` gives. */
export function nodesFromAriaJSON(roots: unknown): AriaNode[] {
  const nodes: AriaNode[] = [];
  const visit = (n: JsonAriaNode | string, depth: number, parent: number) => {
    if (typeof n === "string") {
      nodes.push({ role: "text", text: n, attrs: {}, depth, parent, line: nodes.length });
      return;
    }
    if (typeof n !== "object" || n === null || typeof n.role !== "string") return;
    const attrs: Record<string, string | true> = {};
    for (const [k, v] of Object.entries(n)) {
      if (k === "role" || k === "name" || k === "ref" || k === "text" || k === "url" || k === "children") continue;
      if (v === true) attrs[k] = true;
      else if (typeof v === "string" || typeof v === "number") attrs[k] = String(v);
      else if (v === "mixed") attrs[k] = "mixed";
    }
    const node: AriaNode = { role: n.role, attrs, depth, parent, line: nodes.length };
    if (typeof n.name === "string" && n.name !== "") node.name = n.name;
    if (typeof n.ref === "string") node.ref = n.ref;
    if (typeof n.text === "string") node.text = n.text;
    if (typeof n.url === "string") node.url = n.url;
    nodes.push(node);
    const index = nodes.length - 1;
    for (const c of n.children ?? []) visit(c, depth + 1, index);
  };
  for (const r of Array.isArray(roots) ? roots : [roots]) visit(r as JsonAriaNode, 0, -1);
  return nodes;
}

export interface AriaView {
  nodes: AriaNode[];
  candidates: AriaCandidate[];
  outline: string;
}

/**
 * Snapshot `page` and read it: `ariaSnapshotJSON` where Playwright has it
 * (1.63+), the YAML snapshot otherwise (1.59+).
 */
export async function readAria(page: Page, options: AriaCandidateOptions & OutlineOptions = {}): Promise<AriaView> {
  const withJson = page as Page & { ariaSnapshotJSON?: (o: { mode: "ai" }) => Promise<unknown> };
  const nodes =
    typeof withJson.ariaSnapshotJSON === "function"
      ? nodesFromAriaJSON(await withJson.ariaSnapshotJSON({ mode: "ai" }))
      : parseAriaSnapshot(await page.ariaSnapshot({ mode: "ai" }));
  const candidates = ariaCandidates(nodes, options);
  return { nodes, candidates, outline: ariaOutline(nodes, candidates, options) };
}
