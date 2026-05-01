/**
 * Budget + stall tracking for the action advisor. Both classes are
 * crawler-internal state holders; they are intentionally not exported
 * from `src/index.ts` because users never construct them directly —
 * the crawler owns one of each per run.
 */

export class AdvisorBudget {
  #total = 0;
  #perPage = new Map<string, number>();

  recordCall(url: string): void {
    this.#total += 1;
    this.#perPage.set(url, (this.#perPage.get(url) ?? 0) + 1);
  }

  callsThisCrawl(): number {
    return this.#total;
  }

  callsThisPage(url: string): number {
    return this.#perPage.get(url) ?? 0;
  }

  resetPage(url: string): void {
    this.#perPage.delete(url);
  }
}

export class StallTracker {
  #consecutive = 0;
  #invariantPending = false;

  recordZeroNovelty(): void {
    this.#consecutive += 1;
  }

  recordNovelty(): void {
    this.#consecutive = 0;
  }

  recordInvariantViolation(): void {
    this.#invariantPending = true;
  }

  recordAdvisorPick(): void {
    this.#consecutive = 0;
    this.#invariantPending = false;
  }

  resetForNewPage(): void {
    this.#consecutive = 0;
    this.#invariantPending = false;
  }

  consecutiveZeroNovelty(): number {
    return this.#consecutive;
  }

  invariantViolationPending(): boolean {
    return this.#invariantPending;
  }
}
