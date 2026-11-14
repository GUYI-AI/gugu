export interface NpmBundleFile {
  path: string
  size: number
  mode: number
  sha256: string
}
export interface NpmBundleManifest {
  format: 1
  archive: 'npm.zip'
  version: string
  sha256: string
  files: NpmBundleFile[]
  bundledDependencies: string[]
}
export const ARCHIVE_NAME: 'npm.zip'
export const MANIFEST_NAME: 'npm.json'
export const FORMAT_VERSION: 1
export function safeRelativePath(value: unknown): value is string
export function parseBundleManifest(value: unknown): NpmBundleManifest
