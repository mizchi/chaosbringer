/**
 * Shared budget bookkeeping for drivers that consume external resources
 * (model calls, USD). Independent of the legacy `advisor/budget.ts` so
 * the driver layer has no implicit ordering dependency on advisor wiring.
 */

export interface DriverBudgetOptions {
  /** Hard cap on provider calls in total. Undefined = unlimited. */
  maxCalls?: number;
  /** Hard cap on provider calls per page. Undefined = unlimited. */
  maxCallsPerPage?: number;
  /** Cumulative USD cap. Undefined = unlimited. */
  maxUsd?: number;
}

export class DriverBudget {
  private totalCalls = 0;
  private pageCalls = new Map<string, number>();
  private usdSpent = 0;

  constructor(private readonly opts: DriverBudgetOptions = {}) {}

  /** Returns true if a call is still affordable for this url. */
  canCall(url: string): boolean {
    if (this.opts.maxCalls !== undefined && this.totalCalls >= this.opts.maxCalls) return false;
    if (this.opts.maxCallsPerPage !== undefined) {
      const used = this.pageCalls.get(url) ?? 0;
      if (used >= this.opts.maxCallsPerPage) return false;
    }
    if (this.opts.maxUsd !== undefined && this.usdSpent >= this.opts.maxUsd) return false;
    return true;
  }

  recordCall(url: string): void {
    this.totalCalls++;
    this.pageCalls.set(url, (this.pageCalls.get(url) ?? 0) + 1);
  }

  recordUsd(amount: number): void {
    if (amount > 0) this.usdSpent += amount;
  }

  resetPage(url: string): void {
    this.pageCalls.delete(url);
  }

  callsThisCrawl(): number {
    return this.totalCalls;
  }

  callsThisPage(url: string): number {
    return this.pageCalls.get(url) ?? 0;
  }

  totalUsd(): number {
    return this.usdSpent;
  }

  remainingCalls(): number | undefined {
    if (this.opts.maxCalls === undefined) return undefined;
    return Math.max(0, this.opts.maxCalls - this.totalCalls);
  }

  remainingUsd(): number | undefined {
    if (this.opts.maxUsd === undefined) return undefined;
    return Math.max(0, this.opts.maxUsd - this.usdSpent);
  }
}
