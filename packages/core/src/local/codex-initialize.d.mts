export declare const CODEX_INITIALIZE_PROGRESS_MS = 120000
export declare const CODEX_PREPARATION_PREFIX: string
export type CodexPreparation = { phase: 'preparing' | 'history'; startedAt: number; attempt: number }
export declare function codexBackfillWaiting(error: unknown): boolean
export declare function parseCodexPreparation(line: string): CodexPreparation | null | undefined
export declare function retryCodexPreparation<T>(start: () => Promise<T>, options?: {
  stop?: () => Promise<void>; onProgress?: (progress: CodexPreparation | null) => void;
  signal?: AbortSignal; wait?: (ms: number, signal?: AbortSignal) => Promise<unknown>; retryDelayMs?: number
}): Promise<T>
