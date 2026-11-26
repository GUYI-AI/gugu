/** The preference is scoped to the harness and the picker ID, including the connection or Gugu prefix. */
export function contextThresholdKey(harness: string, model: string): string {
  return JSON.stringify([harness, model]);
}

export function supportsContextThreshold(harness: string): boolean {
  return harness === 'codex' || harness === 'claude' || harness === 'opencode' || harness === 'pi';
}

export function contextThresholdMinimum(harness: string): number {
  // CLAUDE_CODE_AUTO_COMPACT_WINDOW has a native 100K floor.
  return harness === 'claude' ? 100_000 : 8_000;
}

export function modelContextLengths(lengths: unknown, defaultLength: unknown, maximum?: number | null) {
  if (!Array.isArray(lengths) || !lengths.length || typeof defaultLength !== 'number' || !lengths.includes(defaultLength)) return null;
  if (lengths.some(value => !Number.isSafeInteger(value) || value <= 0 || (maximum != null && value > maximum))) return null;
  return { contextLengths: [...new Set(lengths as number[])], defaultContextLength: defaultLength };
}

export const CONTEXT_THRESHOLD_ENV = 'GUGU_MODEL_CONTEXT_THRESHOLD';

export interface ContextThresholdPreference {
  tokens: number;
  maximum: number;
}

/** A smaller window preserves an existing threshold as far as the new strict bound permits. */
export function contextThresholdForWindow(
  previous: ContextThresholdPreference,
  maximum: number,
): ContextThresholdPreference {
  return { tokens: Math.min(previous.tokens, maximum - 1), maximum };
}

export const CONTEXT_WINDOW_ENV = 'GUGU_MODEL_CONTEXT_WINDOW';

export function contextCompactionSettings(env: Record<string, string | undefined>, currentWindow?: number | null) {
  const tokens = Number(env[CONTEXT_THRESHOLD_ENV]);
  const configuredWindow = Number(env[CONTEXT_WINDOW_ENV]);
  const maximum = currentWindow || configuredWindow;
  const selectedLimit = configuredWindow > 0 ? Math.min(maximum, configuredWindow) : maximum;
  if (!Number.isSafeInteger(tokens) || !Number.isSafeInteger(selectedLimit) || !Number.isSafeInteger(maximum)
    || tokens <= 0 || tokens >= selectedLimit) return undefined;
  return { tokens, reserve: maximum - tokens };
}
