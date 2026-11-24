/** The preference is scoped to the harness and the picker ID, including the connection or Gugu prefix. */
export function contextThresholdKey(harness: string, model: string): string {
  return JSON.stringify([harness, model]);
}

export function supportsContextThreshold(harness: string): boolean {
  return harness === 'codex' || harness === 'claude' || harness === 'opencode' || harness === 'pi';
}

export const CONTEXT_THRESHOLD_ENV = 'GUGU_MODEL_CONTEXT_THRESHOLD';

export interface ContextThresholdPreference {
  tokens: number;
  maximum: number;
}

export const CONTEXT_WINDOW_ENV = 'GUGU_MODEL_CONTEXT_WINDOW';

export function contextCompactionSettings(env: Record<string, string | undefined>, currentWindow?: number | null) {
  const tokens = Number(env[CONTEXT_THRESHOLD_ENV]);
  const maximum = currentWindow || Number(env[CONTEXT_WINDOW_ENV]);
  if (!Number.isSafeInteger(tokens) || !Number.isSafeInteger(maximum) || tokens <= 0 || tokens >= maximum) return undefined;
  return { tokens, reserve: maximum - tokens };
}
