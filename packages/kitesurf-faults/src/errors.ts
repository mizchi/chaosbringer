/**
 * The one error type this package throws.
 *
 * `code` is what a caller branches on; the message always starts with
 * `kitesurf-faults: ` so it can be told apart in a workerd log, where only the
 * message survives.
 */

export type KitesurfFaultsErrorCode =
  /** The factory refused the options. Thrown synchronously. */
  | "invalid-config"
  /** An `abort` fault fired: the request failed on purpose. */
  | "injected-abort"
  /** The session was disposed before or while handling the request. */
  | "disposed";

/**
 * Message of an injected `abort`. Kept as a constant because the integration
 * gate matches it in workerd's log: workerd reports every error a Service
 * Binding throws as `Uncaught Error: <message>`, and an injected abort must be
 * told apart from a real one.
 */
export const INJECTED_ABORT_MARKER = "kitesurf-faults: injected abort";

export class KitesurfFaultsError extends Error {
  readonly code: KitesurfFaultsErrorCode;
  /**
   * For `injected-abort` only: the `Fault.errorCode` it stands for. Always
   * `"failed"` — a Workers transport can make a fetch fail, but not with one
   * of Chromium's specific network error codes.
   */
  readonly errorCode?: "failed";

  constructor(code: KitesurfFaultsErrorCode, message: string) {
    super(message);
    this.name = "KitesurfFaultsError";
    this.code = code;
    if (code === "injected-abort") this.errorCode = "failed";
  }
}
