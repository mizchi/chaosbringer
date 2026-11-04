/**
 * Pairs the browser's "Failed to load resource: …" console lines with the
 * responses and failed requests they are about.
 *
 * The line names neither the method nor (beyond its text) the status, and
 * nothing in it says whether one of the run's own fault rules answered the
 * request. Its location is the resource URL, and Playwright's `response` /
 * `requestfailed` events carry the rest. Pairing them, rather than recording
 * the response as an error of its own, keeps one `PageError` per failed
 * request, with the message, and so the cluster key, it always had.
 *
 * A line is paired with an outcome of the same URL and the same kind: a
 * "the server responded with a status of N" line with a response of status
 * N, a "net::ERR_…" line with a failed request. In arrival order: the
 * response almost always comes first, but either can wait for the other.
 * Two requests to one URL can pair crosswise (both lines read the same), so
 * what is exact is the number of lines that pair with a faulted outcome, not
 * which of the two identical lines gets the tag.
 */
import type { PageError } from "./types.js";

/** A response of status >= 400, or a request that failed, of one page. */
export interface ResourceOutcome {
  url: string;
  method: string;
  /** The HTTP status; undefined for a request that failed at the transport level. */
  status?: number;
  /** The page's own main-frame document: its status is the page's, not an HTTP error of it. */
  document: boolean;
  /** The fault that answered the request (`PageError.causedByFault`), if one did. */
  fault?: string;
}

const STATUS_LINE = /^Failed to load resource: the server responded with a status of (\d+)/;
const FAILED_LINE = /^Failed to load resource: net::/;

/**
 * What a console message is, as a resource line: the status it names, a
 * transport failure, or undefined for any other message.
 */
export function resourceLineKind(message: string): { status: number } | { failed: true } | undefined {
  const status = STATUS_LINE.exec(message);
  if (status) return { status: Number(status[1]) };
  return FAILED_LINE.test(message) ? { failed: true } : undefined;
}

function pairs(outcome: ResourceOutcome, line: PageError): boolean {
  if (line.resourceUrl !== outcome.url) return false;
  const kind = resourceLineKind(line.message);
  if (!kind) return false;
  return "status" in kind ? outcome.status === kind.status : outcome.status === undefined;
}

/**
 * One page's lines and outcomes, each waiting for the other. `apply` is
 * called once per pair.
 */
export class ResourceLinePairing {
  private readonly outcomes: ResourceOutcome[] = [];
  private readonly lines: PageError[] = [];

  constructor(private readonly apply: (outcome: ResourceOutcome, line: PageError) => void) {}

  /** A response or failed request: paired with the first waiting line about it, or kept. */
  outcome(outcome: ResourceOutcome): void {
    const at = this.lines.findIndex((line) => pairs(outcome, line));
    if (at < 0) {
      this.outcomes.push(outcome);
      return;
    }
    const [line] = this.lines.splice(at, 1);
    this.apply(outcome, line!);
  }

  /** A console error with a `resourceUrl`: paired with the first waiting outcome, or kept. */
  line(line: PageError): void {
    if (!resourceLineKind(line.message)) return;
    const at = this.outcomes.findIndex((outcome) => pairs(outcome, line));
    if (at < 0) {
      this.lines.push(line);
      return;
    }
    const [outcome] = this.outcomes.splice(at, 1);
    this.apply(outcome!, line);
  }
}

/**
 * Whether an error is the browser's echo of a fault the run injected, which
 * the counts, the clusters and the exit rules leave out.
 */
export function isFaultEcho(error: Pick<PageError, "causedByFault">): boolean {
  return error.causedByFault !== undefined;
}
