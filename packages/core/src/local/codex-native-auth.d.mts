export const CODEX_NATIVE_AUTH_ENDPOINT: 'GUGU_CODEX_NATIVE_AUTH_ENDPOINT';
export const CODEX_NATIVE_AUTH_BEARER: 'GUGU_CODEX_NATIVE_AUTH_BEARER';
export const CODEX_NATIVE_AUTH_ROOT: 'GUGU_CODEX_NATIVE_AUTH_ROOT';
export const CODEX_REFRESH_WINDOW_MS: number;
export type CodexNativeAccess = {
  identity: string; accessToken: string; chatgptAccountId: string; chatgptPlanType?: string;
  account?: string; expiresAt?: number;
  credentials: { auth_mode: 'chatgpt'; tokens: { id_token: string; access_token: string; account_id: string } };
};
export type CodexNativeAccessRequest = { useToken?: boolean; unauthorizedToken?: string };
export function codexJwtClaims(value: unknown): Record<string, unknown> | null;
export function codexOAuthIdentity(auth: unknown): string | null;
export function codexNativeNeedsRefresh(auth: unknown, now?: number): boolean;
export function codexAccessProjection(auth: unknown, expectedIdentity?: string): CodexNativeAccess;
export function createCodexNativeAuthAuthority(deps: {
  read: () => Promise<unknown>; refresh: (before: { accessToken: string }) => Promise<void>;
  serialize: <T>(work: () => Promise<T>) => Promise<T>; identity?: string; now?: () => number;
}): (request?: CodexNativeAccessRequest) => Promise<CodexNativeAccess | null>;
export function refreshNativeCodexThroughCli(
  run: (work: (server: { request(method: string, params: unknown): Promise<unknown> }) => Promise<void>) => Promise<unknown>,
  source: { read(): Promise<unknown>; identity: string; accessToken: string },
): Promise<void>;
export function requestNativeCodexAccess(env: Record<string, string | undefined>, request?: CodexNativeAccessRequest, timeoutMs?: number): Promise<CodexNativeAccess | null>;
export function nativeCodexSessionArgs(env: Record<string, string | undefined>): string[];
export function initializeNativeCodexSession(
  env: Record<string, string | undefined>, request: (method: string, params: unknown) => Promise<unknown>,
  options?: { platform?: boolean; setRefresh?: (handler: ((params: { previousAccountId?: string | null }) => Promise<unknown>) | null) => void },
): Promise<{ ensure(): Promise<void>; refresh(params: { previousAccountId?: string | null }): Promise<{ accessToken: string; chatgptAccountId: string; chatgptPlanType?: string }> } | null>;
