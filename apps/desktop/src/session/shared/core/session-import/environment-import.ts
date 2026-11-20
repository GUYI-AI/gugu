/** The renderer receives metadata, never native configuration or source paths. */
export const ENVIRONMENT_IMPORT_CATEGORIES = ['tasks', 'projects', 'memories', 'skills', 'connectors'] as const;
export type EnvironmentImportCategory = typeof ENVIRONMENT_IMPORT_CATEGORIES[number];
export type EnvironmentImportSelection = { localSourceId: string; fingerprint: string };
export type EnvironmentImportItem = {
  localSourceId: string;
  fingerprint: string | null;
  name: string;
  status: 'ready' | 'existing' | 'imported' | 'conflict' | 'skipped' | 'failed';
  reason?: string;
};
export type EnvironmentImportScan = { count: number; items: EnvironmentImportItem[] };
export type EnvironmentImportRequest = {
  requestId: string;
  category: Exclude<EnvironmentImportCategory, 'tasks'>;
  selection: EnvironmentImportSelection[];
};

export function isEnvironmentImportCategory(value: unknown): value is EnvironmentImportCategory {
  return typeof value === 'string' && (ENVIRONMENT_IMPORT_CATEGORIES as readonly string[]).includes(value);
}
