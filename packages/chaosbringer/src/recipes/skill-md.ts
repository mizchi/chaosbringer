/**
 * `skill-md` — parse `skills/*.md` files into "seed recipes" that the
 * AI driver can use as targets for Phase A discovery.
 *
 * Inspired by browser-harness's `SKILL.md` pattern: domain experts /
 * non-developers write **prose** instructions for what to test; the
 * AI compiles them into a concrete `ActionRecipe` by running with
 * the seed as the Goal's `objective`.
 *
 * File format — YAML-ish frontmatter + Markdown body:
 *
 *   ```
 *   ---
 *   name: shop/buy-tshirt
 *   goal: completion
 *   urlPattern: ^https?://[^/]+/?$
 *   success:
 *     urlContains: /thanks
 *   ---
 *   # Buy a T-shirt
 *
 *   1. From the home page, click any T-shirt product card.
 *   2. On the product page, click "Buy".
 *   3. You should land on /thanks.
 *   ```
 *
 * `parseSkillMarkdown(text)` returns a `SkillSeed`. `seedToGoal(seed)`
 * builds a `Goal` from it. `seedToCandidateRecipe(seed, trace)`
 * combines the trace produced by an AI run with the seed metadata
 * into a `markdown-seed`-origin recipe.
 *
 * We do NOT ship a full YAML parser — frontmatter is restricted to a
 * small grammar (key: value, two-space-indented sub-keys, no anchors,
 * no flow). For richer schemas, consume the markdown body yourself
 * and call the lower-level constructors.
 */
import type {
  ActionRecipe,
  ActionTrace,
  ExpectClause,
  RecipePrecondition,
} from "./types.js";
import { emptyStats } from "./types.js";
import type { Goal, GoalContext } from "./types.js";

export interface SkillSeed {
  /** Stable recipe name. Required. */
  name: string;
  /** Goal name carried through to captured trace + AI prompt. */
  goal?: string;
  /** Free-form persona override. */
  persona?: string;
  /** Auto-derived URL precondition. */
  urlPattern?: string;
  /** Success check expressed as an ExpectClause. */
  success?: {
    urlContains?: string;
    urlNotContains?: string;
    hasSelector?: string;
    hidesSelector?: string;
  };
  /** Extra preconditions beyond `urlPattern`. */
  preconditions?: RecipePrecondition[];
  /** Markdown body — fed verbatim to the AI's prompt context. */
  body: string;
  /** Raw frontmatter, for callers who need extra fields. */
  raw: Record<string, unknown>;
}

/**
 * Parse `---\n<frontmatter>\n---\n<body>`. Returns the seed.
 * Throws on malformed frontmatter; bad files should fail loudly,
 * not silently produce empty seeds.
 */
export function parseSkillMarkdown(text: string): SkillSeed {
  const trimmed = text.replace(/^﻿/, "");
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(trimmed);
  if (!match) {
    throw new Error(
      "parseSkillMarkdown: missing or malformed frontmatter (expected `---` delimiters at top of file)",
    );
  }
  const frontmatter = parseFrontmatter(match[1]!);
  const body = match[2]!.trimEnd();

  const name = stringOf(frontmatter.name);
  if (!name) {
    throw new Error("parseSkillMarkdown: frontmatter is missing `name`");
  }

  const seed: SkillSeed = {
    name,
    body,
    raw: frontmatter,
  };
  if (frontmatter.goal !== undefined) seed.goal = stringOf(frontmatter.goal);
  if (frontmatter.persona !== undefined) seed.persona = stringOf(frontmatter.persona);
  if (frontmatter.urlPattern !== undefined) seed.urlPattern = stringOf(frontmatter.urlPattern);
  if (frontmatter.success && typeof frontmatter.success === "object") {
    const s = frontmatter.success as Record<string, unknown>;
    seed.success = {};
    if (s.urlContains !== undefined) seed.success.urlContains = stringOf(s.urlContains);
    if (s.urlNotContains !== undefined) seed.success.urlNotContains = stringOf(s.urlNotContains);
    if (s.hasSelector !== undefined) seed.success.hasSelector = stringOf(s.hasSelector);
    if (s.hidesSelector !== undefined) seed.success.hidesSelector = stringOf(s.hidesSelector);
  }
  return seed;
}

/**
 * Build a `Goal` from the seed. `objective` is the markdown body —
 * the AI gets the natural-language instructions verbatim, plus the
 * persona override if present.
 */
export function seedToGoal(seed: SkillSeed): Goal {
  const success = seed.success;
  const successCheck = async (ctx: GoalContext): Promise<boolean> => {
    if (!success) return false;
    if (success.urlContains && !ctx.url.includes(success.urlContains)) return false;
    if (success.urlNotContains && ctx.url.includes(success.urlNotContains)) return false;
    if (success.hasSelector) {
      const visible = await ctx.page
        .locator(success.hasSelector)
        .first()
        .isVisible({ timeout: 200 })
        .catch(() => false);
      if (!visible) return false;
    }
    if (success.hidesSelector) {
      const visible = await ctx.page
        .locator(success.hidesSelector)
        .first()
        .isVisible({ timeout: 200 })
        .catch(() => false);
      if (visible) return false;
    }
    return true;
  };
  return {
    name: seed.goal ?? "skill-md",
    persona: seed.persona ?? "a domain expert following the steps documented in a skill markdown file",
    objective: seed.body,
    successCheck,
  };
}

/**
 * Turn a captured trace + the seed into a candidate `ActionRecipe`
 * (origin: `markdown-seed`). Caller decides whether to upsert.
 */
export function seedToCandidateRecipe(
  seed: SkillSeed,
  trace: ActionTrace,
): ActionRecipe {
  if (!trace.successful) {
    throw new Error(`seedToCandidateRecipe: refusing to use unsuccessful trace for ${seed.name}`);
  }
  const preconditions: RecipePrecondition[] = [
    ...(seed.urlPattern ? [{ urlPattern: seed.urlPattern }] : []),
    ...(seed.preconditions ?? []),
  ];
  const postconditions: RecipePrecondition[] = seedPostconditions(seed.success);
  return {
    name: seed.name,
    description: firstParagraph(seed.body),
    goal: seed.goal,
    preconditions,
    steps: trace.steps,
    postconditions,
    requires: [],
    stats: emptyStats(),
    origin: "markdown-seed",
    status: "candidate",
    version: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

function seedPostconditions(success: SkillSeed["success"]): RecipePrecondition[] {
  if (!success) return [];
  const out: RecipePrecondition[] = [];
  if (success.urlContains) out.push({ urlPattern: escapeForRegex(success.urlContains) });
  if (success.hasSelector) out.push({ hasSelector: success.hasSelector });
  if (success.hidesSelector) out.push({ hidesSelector: success.hidesSelector });
  return out;
}

function escapeForRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function firstParagraph(body: string): string {
  // Skip leading heading lines, take the first non-blank prose line.
  for (const line of body.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    if (t.startsWith("#")) continue;
    return t.slice(0, 200);
  }
  return body.slice(0, 200);
}

// -------- frontmatter parser --------

interface ParsedRecord {
  [k: string]: unknown;
}

function parseFrontmatter(src: string): ParsedRecord {
  const lines = src.split(/\r?\n/);
  return parseBlock(lines, 0).record;
}

interface ParsedBlock {
  record: ParsedRecord;
  /** Line index past the end of this block. */
  end: number;
}

function parseBlock(lines: ReadonlyArray<string>, startIndent: number): ParsedBlock {
  const record: ParsedRecord = {};
  let i = 0;
  while (i < lines.length) {
    const raw = lines[i]!;
    if (raw.trim() === "" || raw.trimStart().startsWith("#")) {
      i++;
      continue;
    }
    const indent = leadingSpaces(raw);
    if (indent < startIndent) break;
    if (indent > startIndent) {
      // Sub-block belongs to the preceding key — but we already
      // consumed that key in the previous iteration. Skip over.
      i++;
      continue;
    }
    const line = raw.slice(startIndent);
    const colon = line.indexOf(":");
    if (colon < 0) {
      throw new Error(`parseFrontmatter: expected "key: value", got "${raw}"`);
    }
    const key = line.slice(0, colon).trim();
    const rest = line.slice(colon + 1).trim();
    if (rest === "") {
      // Nested block.
      const sub = parseBlock(lines.slice(i + 1), startIndent + 2);
      record[key] = sub.record;
      i = i + 1 + sub.end;
    } else {
      record[key] = parseScalar(rest);
      i++;
    }
  }
  return { record, end: i };
}

function leadingSpaces(line: string): number {
  let n = 0;
  for (const ch of line) {
    if (ch !== " ") break;
    n++;
  }
  return n;
}

function parseScalar(value: string): unknown {
  // Strip surrounding quotes.
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null") return null;
  if (/^-?\d+$/.test(value)) return Number(value);
  if (/^-?\d+\.\d+$/.test(value)) return Number(value);
  return value;
}

function stringOf(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}
