export type CodexProviderStartupKind = 'provider-missing' | 'provider-mismatch' | 'provider-policy'
export type CodexStartupKind = 'version' | 'missing' | 'permission' | 'configuration' | 'protocol' | 'exited' | 'timeout' | 'unknown' | CodexProviderStartupKind
export declare const CODEX_PROVIDER_STARTUP_KINDS: readonly CodexProviderStartupKind[]
export declare function isCodexProviderStartupKind(value: unknown): value is CodexProviderStartupKind
export declare function codexProviderFailureCode(kind: CodexProviderStartupKind): string
export declare const CODEX_STARTUP_KINDS: readonly CodexStartupKind[]
export declare function codexStartupKind(value: unknown, native?: boolean, depth?: number): CodexStartupKind | null
export declare function tagCodexStartupFailure<T extends Error>(value: T, kind?: CodexStartupKind): T & { data: { codexStartupKind: CodexStartupKind } }
