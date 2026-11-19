/** Local ChatGPT/Codex tasks. Bodies and source database handles stay in a child process. */
export type CodexTaskSourceRow = {
  id: string;
  title: string;
  cwd: string;
  relativePath: string;
  updatedAt: number;
  sizeBytes: number;
  revision: string;
};
export type CodexTaskScan = {
  status: 'ready' | 'unavailable';
  reason?: 'missing-index' | 'unsupported-index';
  indexed: number;
  missing: number;
  invalid: number;
  rows: CodexTaskSourceRow[];
};
export type ImportCodexTaskParams = { id: string; revision: string };
export type CodexTaskImportResult = {
  items: ({ id: string } & ({ status: 'imported' | 'existing'; projectId: string; sessionId: string }
    | { status: 'changed' | 'missing' | 'failed'; message?: string }))[];
};
