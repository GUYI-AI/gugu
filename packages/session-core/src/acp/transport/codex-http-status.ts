/**
 * The HTTP status on a Codex turn error. app-server nests it one level down, under the failure kind
 * (`codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 401 } }`, read on d22 with Codex 0.172, 2026-11-26). The host
 * keeps one level of `data` (`toSerializedError`), so the bridge lifts it with `withCodexHttpStatus` before the error leaves.
 */
export function codexHttpStatus(error: unknown): number | null {
  const info = error && typeof error === 'object' ? (error as { codexErrorInfo?: unknown }).codexErrorInfo : undefined;
  if (!info || typeof info !== 'object') return null;
  for (const detail of Object.values(info)) {
    const status = detail && typeof detail === 'object' ? (detail as { httpStatusCode?: unknown }).httpStatusCode : undefined;
    if (typeof status === 'number' && Number.isInteger(status)) return status;
  }
  return null;
}

/** The turn error with its HTTP status at the top level, where the turn failure classifier reads it. */
export function withCodexHttpStatus<T extends object>(error: T): T & { httpStatusCode?: number } {
  const status = codexHttpStatus(error);
  return status === null ? error : { ...error, httpStatusCode: status };
}

/**
 * A Codex retry that cannot succeed: the address refused the key (401/403), and each retry sends the same key to the same
 * address (#3939). Codex 0.172 retries a plain 401/403 like a dropped connection: `UnexpectedStatus` takes
 * `RetryPolicy::Backoff` (`codex-rs/protocol/src/error.rs`), five more times by default. Its own token refresh on a 401 has
 * already run in the HTTP client (`core/src/client.rs`, `handle_unauthorized`) before the stream retry loop sees the error.
 */
export function isCodexKeyRefusal(error: unknown): boolean {
  const status = codexHttpStatus(error);
  return status === 401 || status === 403;
}
