import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// A surface that shows an opening's 「↑ N 条新消息」 (MessageList `unreadAbove`) is where that opening ends: it must hand the entry
// to usePresentedUnreadEntry, or leaving the conversation through that surface leaves the entry alive and the pill comes back on
// return. Ending it anywhere else (the account's observer, one entry point among many) misses the paths that bypass it.
const root = fileURLToPath(new URL('../../../', import.meta.url))
const guide = 'A surface that passes unreadAbove to MessageList must call usePresentedUnreadEntry with the same entry and its own visibility.'

function sources(directory: string): string[] {
  if (!existsSync(directory)) return []
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (['node_modules', 'tests', 'test', '__tests__'].includes(entry.name)) return []
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return sources(path)
    return /\.tsx$/.test(entry.name) && !/\.(test|spec)\./.test(entry.name) ? [path] : []
  })
}

describe('unread entry presenters', () => {
  it('ends the entry on every surface that presents it', () => {
    const presenters = sources(join(root, 'apps/desktop/src'))
      .filter((file) => /\bunreadAbove=\{/.test(readFileSync(file, 'utf8')))
      .map((file) => relative(root, file).replaceAll('\\', '/')).sort()
    expect(presenters).toEqual(['apps/desktop/src/components/ChatAreaPanel.tsx', 'apps/desktop/src/components/chat/TopicSplitPane.tsx'])
    const missing = presenters.filter((file) => !/\busePresentedUnreadEntry\(/.test(readFileSync(join(root, file), 'utf8')))
    expect(missing, guide).toEqual([])
  })
})
