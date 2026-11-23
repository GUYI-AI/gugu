export const BUMP_BRANCH_PREFIX: string
export type SyncAction =
  | { type: 'tag'; tag: string; sha: string }
  | { type: 'bump'; from: string; to: string; branch: string }
  | { type: 'waiting'; pr: number; to: string }
export function nextVersion(stable: string): string
export function compareVersions(a: string, b: string): number
export function planSync(input: { stable: string; tagSha: string | null; sourceSha: string | null; devVersion: string; openPr?: number }): SyncAction[]
export function bumpPackageJson(text: string, from: string, to: string): string
