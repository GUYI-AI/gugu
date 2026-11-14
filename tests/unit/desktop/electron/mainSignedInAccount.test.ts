import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'

// server 没有渲染层推登录态:任务名的属主若取渲染层那份,在 server 上恒为 null,离线改名永远不重发。
it('takes every account owner in the main process from the one signed-in account, the server login included', () => {
  const main = readFileSync(join(__dirname, '../../../../apps/desktop/electron/main.ts'), 'utf8')
  const owners = [...main.matchAll(/setTaskNameOwner\(([^)]*\))\)/g)].map(match => match[1])
  expect(owners.length).toBeGreaterThan(0)
  expect(owners.every(arg => arg === 'signedInAccountId()')).toBe(true)
  expect(main).toMatch(/function signedInAccountId\(\): string \| null \{\n\s+return SERVER_MODE \? serverAuth\?\.signedInUserId\(\) \?\? null : humanAuthUserId\(\)/)
  expect(main).not.toMatch(/function pushedUserId/)
})
