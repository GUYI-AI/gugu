export type CodexStartupKind = 'version' | 'missing' | 'permission' | 'configuration' | 'protocol' | 'exited' | 'timeout' | 'unknown'
export declare const CODEX_STARTUP_KINDS: readonly CodexStartupKind[]
export declare function codexStartupKind(value: unknown, native?: boolean, depth?: number): CodexStartupKind | null
export declare function tagCodexStartupFailure<T extends Error>(value: T, kind?: CodexStartupKind): T & { data: { codexStartupKind: CodexStartupKind } }
