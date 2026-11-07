export type CompatibilitySnapshot = { rows: { id: string; sha256: string }[]; integrity: string; foreignKeyErrors: unknown[];
  newReceiptRows: number; newReceipts: { id: string; sha256: string }[] };
export type CompatibilityAdapter = {
  metadata(): Promise<{ oldSha: string; newSha: string; level: 'source-schema' | 'installed-binary'; oldInitializer: string; newInitializer: string }>;
  seedOld(file: string): Promise<CompatibilitySnapshot>;
  upgradeAndWriteNew(file: string): Promise<CompatibilitySnapshot>;
  openOldAndWrite(file: string): Promise<CompatibilitySnapshot>;
  reopenNew(file: string): Promise<CompatibilitySnapshot>;
};
export function checkCompatibility(adapter: CompatibilityAdapter, directory: string): Promise<{ passed: boolean; level: string;
  meta: Awaited<ReturnType<CompatibilityAdapter['metadata']>>; stages: { name: string; snapshot: CompatibilitySnapshot }[] }>;
