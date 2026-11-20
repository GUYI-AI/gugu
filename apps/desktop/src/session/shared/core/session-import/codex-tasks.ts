/** Local ChatGPT/Codex tasks. Bodies and source database handles stay in a child process. */
export type CodexTaskHistoryFile = {
  relativePath: string;
  nativeId: string;
  cwd: string;
  sizeBytes: number;
  historyBase: { thread_id: string; end_ordinal_exclusive: number; end_byte_offset: number } | null;
};
export type CodexTaskSourceRow = {
  id: string;
  title: string;
  cwd: string;
  relativePath: string;
  updatedAt: number;
  sizeBytes: number;
  revision: string;
  /** Current rollout plus every immutable ancestor needed for native resume. */
  files: CodexTaskHistoryFile[];
};
export type CodexTaskScan = {
  status: 'ready' | 'unavailable';
  reason?: 'missing-index' | 'unsupported-index';
  indexed: number;
  missing: number;
  invalid: number;
  blocked: { id: string; reason: 'missing-original' | 'missing-history' | 'invalid-history' }[];
  rows: CodexTaskSourceRow[];
};
export type ImportCodexTaskParams = { id: string; revision: string };
export type CodexTaskImportResult = {
  items: ({ id: string } & ({ status: 'imported' | 'existing'; sessionId: string }
    | { status: 'changed' | 'missing' | 'failed'; message?: string }))[];
};
