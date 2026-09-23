// A "feature library" imported as a namespace and dispatched dynamically, so the
// bundler can't tree-shake the unused functions — they're shipped in the chunk but
// never executed. This is the classic over-shipping pathology (barrel import of a
// big lib, ~1 function actually used). Each function is distinct, non-trivial code
// so it's real bytes and a real coverage range. The scenario calls only `summary`,
// leaving the rest as detectable dead weight.

export function summary(xs: number[]): number {
  let s = 0;
  for (const x of xs) s += x;
  return Math.round(s / Math.max(1, xs.length));
}
export function variance(xs: number[]): number {
  const m = summary(xs);
  let s = 0;
  for (const x of xs) s += (x - m) * (x - m);
  return s / Math.max(1, xs.length);
}
export function histogram(xs: number[], bins: number): number[] {
  const out = Array.from<number>({ length: bins }).fill(0);
  const max = Math.max(1, ...xs);
  for (const x of xs) out[Math.min(bins - 1, Math.floor((x / max) * bins))]++;
  return out;
}
export function quantile(xs: number[], q: number): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(q * (s.length - 1))] ?? 0;
}
export function movingAverage(xs: number[], w: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < xs.length; i++) {
    let s = 0;
    let n = 0;
    for (let j = Math.max(0, i - w + 1); j <= i; j++) {
      s += xs[j]!;
      n++;
    }
    out.push(s / n);
  }
  return out;
}
export function normalize(xs: number[]): number[] {
  const max = Math.max(1, ...xs);
  return xs.map((x) => x / max);
}
export function dotProduct(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += (a[i] ?? 0) * (b[i] ?? 0);
  return s;
}
export function transpose(m: number[][]): number[][] {
  const out: number[][] = [];
  for (let c = 0; c < (m[0]?.length ?? 0); c++) out.push(m.map((row) => row[c] ?? 0));
  return out;
}
export function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}
export function titleCase(s: string): string {
  return s.replace(/\w\S*/g, (w) => w[0]!.toUpperCase() + w.slice(1).toLowerCase());
}
export function wordCount(s: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const w of s.split(/\s+/)) if (w) out[w] = (out[w] ?? 0) + 1;
  return out;
}
export function levenshtein(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [
    i,
    ...Array.from({ length: b.length }, () => 0),
  ]);
  for (let j = 0; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      d[i]![j] = Math.min(
        d[i - 1]![j]! + 1,
        d[i]![j - 1]! + 1,
        d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
  return d[a.length]![b.length]!;
}
export function rgbToHex(r: number, g: number, b: number): string {
  return "#" + [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("");
}
export function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.replace("#", ""), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
export function lerpColor(a: string, b: string, t: number): string {
  const [r1, g1, b1] = hexToRgb(a);
  const [r2, g2, b2] = hexToRgb(b);
  return rgbToHex(
    Math.round(r1 + (r2 - r1) * t),
    Math.round(g1 + (g2 - g1) * t),
    Math.round(b1 + (b2 - b1) * t),
  );
}
export function fib(n: number): number {
  let a = 0;
  let b = 1;
  for (let i = 0; i < n; i++) [a, b] = [b, a + b];
  return a;
}

// --- bulky, never-called features (embedded data tables) so the chunk has real
// weight and coverage shows most of it shipped-but-unused (the over-shipping case).
const PALETTE: Array<[string, [number, number, number]]> = Array.from(
  { length: 160 },
  (_, i) => [
    `swatch-${i}`,
    [(i * 37) % 256, (i * 53) % 256, (i * 71) % 256] as [number, number, number],
  ],
);
export function nearestSwatch(r: number, g: number, b: number): string {
  let best = PALETTE[0]!;
  let bestD = Infinity;
  for (const s of PALETTE) {
    const [cr, cg, cb] = s[1];
    const d = (r - cr) ** 2 + (g - cg) ** 2 + (b - cb) ** 2;
    if (d < bestD) {
      bestD = d;
      best = s;
    }
  }
  return best[0];
}
export function gradientStops(from: string, to: string, n: number): string[] {
  return Array.from({ length: n }, (_, i) => lerpColor(from, to, i / Math.max(1, n - 1)));
}

const TIMEZONES: Array<[string, number]> = Array.from({ length: 140 }, (_, i) => [
  `Zone/City_${i}`,
  ((i % 27) - 12) * 60 + (i % 2 ? 30 : 0),
]);
export function offsetFor(zone: string): number {
  return TIMEZONES.find(([z]) => z === zone)?.[1] ?? 0;
}
export function formatOffset(min: number): string {
  const sign = min < 0 ? "-" : "+";
  const a = Math.abs(min);
  return `${sign}${String(Math.floor(a / 60)).padStart(2, "0")}:${String(a % 60).padStart(2, "0")}`;
}

const STOPWORDS = new Set(
  Array.from({ length: 120 }, (_, i) => `word${i}`).concat(
    "the a an of to in on for and or but with from by at as is are was were".split(" "),
  ),
);
export function keywords(text: string, top: number): string[] {
  const freq: Record<string, number> = {};
  for (const w of text.toLowerCase().split(/\s+/))
    if (w && !STOPWORDS.has(w)) freq[w] = (freq[w] ?? 0) + 1;
  return Object.entries(freq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, top)
    .map(([w]) => w);
}
export function readingTimeMin(text: string): number {
  return Math.ceil(text.split(/\s+/).length / 200);
}

const CURVE: number[] = Array.from({ length: 256 }, (_, i) =>
  Math.round(255 * Math.pow(i / 255, 1 / 2.2)),
);
export function gammaCorrect(channel: number[]): number[] {
  return channel.map((v) => CURVE[Math.max(0, Math.min(255, v | 0))] ?? 0);
}
export function clampByte(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v | 0;
}
