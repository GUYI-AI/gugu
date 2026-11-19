/** Exact mise installation versions, including any pinned distribution suffix. */
export type ManagedAgentVersions = { currentVersion: string; versions: string[] };
export type ManagedAgentVersionCleanup = {
  snapshot: ManagedAgentVersions;
  removed: string[];
  failed: Array<{ version: string; error: string }>;
};
