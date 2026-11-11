// #1931 Reads an installed App's personal-assistant product rules (`contributes.assistantRules`) into the same typed
// rules the host's built-in copy has (@gugu/core/shared/assistantRulesFormat). Text and data only: nothing here runs App code.
//
// This module validates; it does not decide whom to believe: assistant-rules-resolver.ts reads a folder only from the App
// assistant-rules-trust.ts believes, and reads its own last good copy back through here too. Everything that is not
// exactly the format is refused with the file and the reason — never repaired, defaulted or partly accepted.
import { lstat, readdir, readFile } from 'node:fs/promises'
import { z } from 'zod'
import {
  ASSISTANT_RULES_DATA_FILE, ASSISTANT_RULES_FORMAT, ASSISTANT_RULES_LABEL_SLOTS, ASSISTANT_RULES_TEXT_SLOTS,
  assistantRuleSlots, assistantRuleTextFile,
  type AssistantProductRules, type AssistantRulesLabelKey, type AssistantRulesTextKey,
} from '@gugu/core/shared/assistantRulesFormat'
import { resolvesInside } from '@shared/extensions/path-containment'
import { bundlePathSchema, type ExtensionManifest } from '@shared/extensions/manifest'

/** One text file, `rules.json`, and the whole folder: the built-in rules are about a quarter of these. */
export const ASSISTANT_RULE_TEXT_MAX_BYTES = 64 * 1024
export const ASSISTANT_RULES_DATA_MAX_BYTES = 16 * 1024
export const ASSISTANT_RULES_MAX_BYTES = 256 * 1024
const LABEL_MAX_CHARS = 200

export type AssistantRulesErrorCode = 'unreadable' | 'escape' | 'unsupported-format' | 'invalid' | 'too-large' | 'encoding'

export class AssistantRulesError extends Error {
  constructor(readonly code: AssistantRulesErrorCode, readonly file: string | null, detail: string) {
    super(`assistant rules${file ? ` ${file}` : ''}: ${detail}`)
    this.name = 'AssistantRulesError'
  }
}

/** Whether a text has a C0 control character or DEL other than the ones allowed. */
function hasControl(text: string, allowed: string): boolean {
  for (const char of text) {
    const code = char.codePointAt(0)!
    if ((code < 0x20 || code === 0x7f) && !allowed.includes(char)) return true
  }
  return false
}

const singleLine = z.string().min(1).max(LABEL_MAX_CHARS)
  .refine(value => !hasControl(value, '') && !value.includes('\u2028') && !value.includes('\u2029'), 'must be one line without control characters')
const rulesDataSchema = z.strictObject({
  format: z.literal(ASSISTANT_RULES_FORMAT),
  rulesVersion: z.string().regex(/^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/),
  defaults: z.strictObject({
    childHarness: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/),
    defaultModel: z.string().regex(/^\S{1,128}$/),
    deniedTools: z.array(z.string().regex(/^\S{1,128}$/)).max(32).refine(tools => new Set(tools).size === tools.length, 'must not repeat a tool'),
    profileRulesVersion: z.number().int().min(1).max(2 ** 31 - 1),
  }),
  labels: z.strictObject(Object.fromEntries(Object.keys(ASSISTANT_RULES_LABEL_SLOTS).map(key => [key, singleLine])) as Record<AssistantRulesLabelKey, typeof singleLine>),
  intro: z.record(
    z.string().regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8}){0,2}$/),
    z.strictObject({ title: singleLine, summary: singleLine, desktopBody: singleLine, phoneBody: singleLine }),
  ).refine(intro => Object.keys(intro).length <= 16, 'names at most 16 locales').optional(),
})

const textKeys = Object.keys(ASSISTANT_RULES_TEXT_SLOTS) as AssistantRulesTextKey[]
const EXPECTED_FILES = new Set([ASSISTANT_RULES_DATA_FILE, ...textKeys.map(assistantRuleTextFile)])

function decode(bytes: Uint8Array, file: string): string {
  let text: string
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) }
  catch { throw new AssistantRulesError('encoding', file, 'is not valid UTF-8') }
  if (text.startsWith('\uFEFF')) throw new AssistantRulesError('encoding', file, 'starts with a byte-order mark')
  if (text.includes('\r')) throw new AssistantRulesError('encoding', file, 'has a carriage return; lines end with LF only')
  if (hasControl(text, '\t\n')) throw new AssistantRulesError('encoding', file, 'has a control character other than tab or newline')
  return text
}

function checkSlots(template: string, allowed: readonly string[], file: string, where: string): void {
  const unknown = assistantRuleSlots(template).filter(slot => !allowed.includes(slot))
  if (unknown.length) {
    throw new AssistantRulesError('invalid', file, `${where} names ${unknown.map(slot => `{{${slot}}}`).join(', ')}; it may use ${allowed.length ? allowed.map(slot => `{{${slot}}}`).join(', ') : 'no slots'}`)
  }
}

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
    if (!EXPECTED_FILES.has(entry.name)) throw new AssistantRulesError('invalid', entry.name, `is not part of format ${ASSISTANT_RULES_FORMAT}`)
    if (!entry.isFile()) throw new AssistantRulesError(entry.isSymbolicLink() ? 'escape' : 'invalid', entry.name, 'must be a regular file')
  }
  const present = new Set(entries.map(entry => entry.name))
  const missing = [...EXPECTED_FILES].filter(name => !present.has(name))
  if (missing.length) throw new AssistantRulesError('invalid', missing[0]!, `is missing (format ${ASSISTANT_RULES_FORMAT} needs ${[...EXPECTED_FILES].join(', ')})`)

  let total = 0
  const read = async (file: string, limit: number): Promise<string> => {
    const path = resolvesInside(dir, file)
    if (!path) throw new AssistantRulesError('escape', file, 'leaves the rules folder')
    const bytes = await readFile(path).catch((error: NodeJS.ErrnoException) => {
      throw new AssistantRulesError('unreadable', file, `cannot be read (${error.code ?? String(error)})`)
    })
    if (bytes.length > limit) throw new AssistantRulesError('too-large', file, `is ${bytes.length} bytes; at most ${limit}`)
    total += bytes.length
    if (total > ASSISTANT_RULES_MAX_BYTES) throw new AssistantRulesError('too-large', file, `brings the folder over ${ASSISTANT_RULES_MAX_BYTES} bytes`)
    return decode(bytes, file)
  }

  let raw: unknown
  try { raw = JSON.parse(await read(ASSISTANT_RULES_DATA_FILE, ASSISTANT_RULES_DATA_MAX_BYTES)) }
  catch (error) {
    if (error instanceof AssistantRulesError) throw error
    throw new AssistantRulesError('invalid', ASSISTANT_RULES_DATA_FILE, 'is not JSON')
  }
  // The format number decides how the rest is read: a newer one is named as such, not as a pile of unknown keys.
  const format = (raw as { format?: unknown } | null)?.format
  if (typeof format !== 'number') throw new AssistantRulesError('invalid', ASSISTANT_RULES_DATA_FILE, 'has no numeric "format"')
  if (format !== ASSISTANT_RULES_FORMAT) throw new AssistantRulesError('unsupported-format', ASSISTANT_RULES_DATA_FILE, `is format ${format}; this host reads format ${ASSISTANT_RULES_FORMAT}`)
  const parsed = rulesDataSchema.safeParse(raw)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!
    throw new AssistantRulesError('invalid', ASSISTANT_RULES_DATA_FILE, `${issue.path.join('.') || '(top)'}: ${issue.message}`)
  }
  for (const key of Object.keys(ASSISTANT_RULES_LABEL_SLOTS) as AssistantRulesLabelKey[]) {
    checkSlots(parsed.data.labels[key], ASSISTANT_RULES_LABEL_SLOTS[key], ASSISTANT_RULES_DATA_FILE, `labels.${key}`)
  }

  const texts = {} as Record<AssistantRulesTextKey, string>
  for (const key of textKeys) {
    const file = assistantRuleTextFile(key)
    const content = await read(file, ASSISTANT_RULE_TEXT_MAX_BYTES)
    // A text file ends with one newline that is not part of the text.
    const text = content.endsWith('\n') ? content.slice(0, -1) : content
    if (!text.trim()) throw new AssistantRulesError('invalid', file, 'is empty')
    checkSlots(text, ASSISTANT_RULES_TEXT_SLOTS[key], file, 'the text')
    texts[key] = text
  }

  const { defaults, labels, intro } = parsed.data
  return Object.freeze({
    format: ASSISTANT_RULES_FORMAT,
    rulesVersion: parsed.data.rulesVersion,
    defaults: Object.freeze({ ...defaults, deniedTools: Object.freeze([...defaults.deniedTools]) }),
    labels: Object.freeze({ ...labels }),
    ...(intro ? { intro: Object.freeze(Object.fromEntries(Object.entries(intro).map(([locale, copy]) => [locale, Object.freeze({ ...copy })]))) } : {}),
    texts: Object.freeze(texts),
  })
}

/** The rules an installed App declares, or null when its manifest declares none. Trust is the caller's decision. */
export function readDeclaredAssistantRules(rootDir: string, manifest: Pick<ExtensionManifest, 'contributes'>): Promise<AssistantProductRules> | null {
  const folder = manifest.contributes.assistantRules
  return folder === undefined ? null : readAssistantProductRules(rootDir, folder)
}
