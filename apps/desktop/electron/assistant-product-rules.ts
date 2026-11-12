// #1931 Reads an installed App's personal-assistant product rules (`contributes.assistantRules`) from disk into the typed
// rules (@gugu/core/shared/assistantRulesFormat), through the one validator (@shared/extensions/assistant-rules-parse).
// Text and data only: nothing here runs App code.
//
// This module validates; it does not decide whom to believe: assistant-rules-resolver.ts reads a folder only from the App
// assistant-rules-trust.ts believes, and reads its own last good copy (and the copy packaged with this release) back
// through here too. On disk the folder must hold regular files only: no links, no sub-folders.
import { lstat, readdir, readFile } from 'node:fs/promises'
import { ASSISTANT_RULES_FORMAT, type AssistantProductRules } from '@gugu/core/shared/assistantRulesFormat'
import { resolvesInside } from '@shared/extensions/path-containment'
import { bundlePathSchema, type ExtensionManifest } from '@shared/extensions/manifest'
import { ASSISTANT_RULES_FILES, AssistantRulesError, parseAssistantRulesFolder } from '@shared/extensions/assistant-rules-parse'

export { AssistantRulesError, type AssistantRulesErrorCode } from '@shared/extensions/assistant-rules-parse'

/**
 * Reads and validates the rules folder `folder` (bundle-relative, as the manifest names it) of the App installed at
 * `rootDir`. Throws AssistantRulesError naming the file and reason; returns frozen rules otherwise.
 */
export async function readAssistantProductRules(rootDir: string, folder: string): Promise<AssistantProductRules> {
  if (!bundlePathSchema.safeParse(folder).success) throw new AssistantRulesError('escape', null, `folder "${folder}" is not a bundle-relative path`)
  const dir = resolvesInside(rootDir, folder)
  if (!dir) throw new AssistantRulesError('escape', null, `folder "${folder}" leaves the App's bundle`)
  let entries
  try {
    if (!(await lstat(dir)).isDirectory()) throw new AssistantRulesError('invalid', null, `"${folder}" is not a folder`)
    entries = await readdir(dir, { withFileTypes: true })
  } catch (error) {
    if (error instanceof AssistantRulesError) throw error
    throw new AssistantRulesError('unreadable', null, `folder "${folder}" cannot be read (${(error as NodeJS.ErrnoException).code ?? String(error)})`)
  }
  for (const entry of entries) {
    if (!ASSISTANT_RULES_FILES.has(entry.name)) throw new AssistantRulesError('invalid', entry.name, `is not part of format ${ASSISTANT_RULES_FORMAT}`)
    if (!entry.isFile()) throw new AssistantRulesError(entry.isSymbolicLink() ? 'escape' : 'invalid', entry.name, 'must be a regular file')
  }
  const files = new Map<string, Uint8Array>()
  for (const entry of entries) {
    const path = resolvesInside(dir, entry.name)
    if (!path) throw new AssistantRulesError('escape', entry.name, 'leaves the rules folder')
    files.set(entry.name, await readFile(path).catch((error: NodeJS.ErrnoException) => {
      throw new AssistantRulesError('unreadable', entry.name, `cannot be read (${error.code ?? String(error)})`)
    }))
  }
  return parseAssistantRulesFolder(files)
}

/** The rules an installed App declares, or null when its manifest declares none. Trust is the caller's decision. */
export function readDeclaredAssistantRules(rootDir: string, manifest: Pick<ExtensionManifest, 'contributes'>): Promise<AssistantProductRules> | null {
  const folder = manifest.contributes.assistantRules
  return folder === undefined ? null : readAssistantProductRules(rootDir, folder)
}
