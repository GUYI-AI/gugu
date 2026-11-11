// #1931 The last rules the host read from the trusted assistant App, kept in the host's own user data: switching the App
// off, uninstalling it or a later version whose folder is not valid then changes nothing. The rules are product-wide, not
// per account. One folder per rulesVersion, in the App's own format (assistantRulesFiles), read back through the same
// validator as the App's folder; `last-good.json` names the folder in use and the App version it came from.
import { randomBytes } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { assistantRulesFiles, type AssistantProductRules } from '@gugu/core/shared/assistantRulesFormat'
import { readAssistantProductRules } from './assistant-product-rules'

export interface LastGoodAssistantRules {
  rules: AssistantProductRules
  /** The assistant App version the rules were read from. */
  appVersion: string
}

export interface AssistantRulesLastGoodStore {
  /** The copy kept, validated as an App's folder is; null when none was kept. Throws when the kept copy is not valid. */
  read(): Promise<LastGoodAssistantRules | null>
  /** Keeps these rules (already validated) as the copy in use, replacing the one before. */
  write(value: LastGoodAssistantRules): Promise<void>
}

const POINTER_FILE = 'last-good.json'
const pointerSchema = z.strictObject({ rulesVersion: z.string().min(1), appVersion: z.string().min(1), savedAt: z.string() })

const isMissing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT'
const stagingName = (kind: string) => `.${kind}-${randomBytes(4).toString('hex')}`

/** The store in `dir` (created on the first write). `dir` is resolved when used: user data is settled after start. */
export function assistantRulesLastGoodStore(dir: () => string, now: () => string = () => new Date().toISOString()): AssistantRulesLastGoodStore {
  return {
    async read() {
      const root = dir()
      let text: string
      try { text = await readFile(join(root, POINTER_FILE), 'utf8') }
      catch (error) { if (isMissing(error)) return null; throw error }
      const pointer = pointerSchema.parse(JSON.parse(text))
      const rules = await readAssistantProductRules(root, pointer.rulesVersion)
      if (rules.rulesVersion !== pointer.rulesVersion) throw new Error(`${POINTER_FILE} names ${pointer.rulesVersion}; its folder holds ${rules.rulesVersion}`)
      return { rules, appVersion: pointer.appVersion }
    },

    async write({ rules, appVersion }) {
      const root = dir()
      await mkdir(root, { recursive: true })
      const target = join(root, rules.rulesVersion)
      const kept = await readAssistantProductRules(root, rules.rulesVersion).catch(() => null)
      if (!isDeepStrictEqual(kept, rules)) {
        // Written whole beside it, then swapped in by rename: a reader never sees a folder half written.
        const staging = join(root, stagingName('staging'))
        await mkdir(staging)
        for (const [name, content] of Object.entries(assistantRulesFiles(rules))) await writeFile(join(staging, name), content, 'utf8')
        const old = join(root, stagingName('old'))
        await rename(target, old).catch(error => { if (!isMissing(error)) throw error })
        await rename(staging, target)
        await rm(old, { recursive: true, force: true })
      }
      const pointer = join(root, stagingName('pointer'))
      await writeFile(pointer, `${JSON.stringify({ rulesVersion: rules.rulesVersion, appVersion, savedAt: now() }, null, 2)}\n`, 'utf8')
      await rename(pointer, join(root, POINTER_FILE))
      // Only the copy in use is kept: an older version's folder, and whatever a write cut off left behind, go.
      for (const entry of await readdir(root, { withFileTypes: true })) {
        if (entry.name !== POINTER_FILE && entry.name !== rules.rulesVersion) await rm(join(root, entry.name), { recursive: true, force: true })
      }
    },
  }
}
