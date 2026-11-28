import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { execFile } from '@gugu/core/local/childProcess'
import type { SshTarget } from './ssh-install/logic'
import { hostForKnownHosts } from './ssh-install/logic'
import type { ServerSshInstallFailure } from '../../src/lib/serverSshInstall'

type Conflict = NonNullable<ServerSshInstallFailure['hostKey']>
const run = promisify(execFile)
const limits = { timeout: 12_000, maxBuffer: 256 * 1024, encoding: 'utf8' } as const

/** Replace entries for exactly the confirmed endpoint. Compound host patterns and
 * authority/revocation entries require the administrator who owns those policies. */
export function replaceVerifiedEntries(contents: string, matches: string, conflict: Conflict, key: string): string | null {
  const fingerprint = /^([\w@.-]+) ([A-Za-z0-9+/]+=*)$/.exec(key)
  if (!fingerprint || !conflict.fingerprint) return null
  const digest = createHash('sha256').update(Buffer.from(fingerprint[2], 'base64')).digest('base64').replace(/=+$/, '')
  if (`SHA256:${digest}` !== conflict.fingerprint) return null
  const lines = contents.split(/(?<=\n)/)
  const matched = Array.from(matches.matchAll(/^# Host .+ found: line (\d+)\s*$/gm), m => Number(m[1]) - 1)
  const oldLine = Number(conflict.location?.match(/:(\d+)$/)?.[1]) - 1
  if (!matched.includes(oldLine)) return null
  let entry = ''
  for (const index of matched) {
    const host = lines[index]?.trim().split(/\s+/)[0]
    if (!host || (host.toLowerCase() !== conflict.host.toLowerCase() && !/^\|1\|[\w+/=]+\|[\w+/=]+$/.test(host))) return null
    if (!entry) entry = `${host} ${key}${lines[index].endsWith('\r\n') ? '\r\n' : '\n'}`
  }
  for (const index of matched) lines[index] = index === oldLine ? entry : ''
  return lines.join('')
}

/** The renderer confirms only a fingerprint. OpenSSH's effective per-user config,
 * the locally observed conflict and a freshly obtained matching public key determine the write. */
export async function updateVerifiedHostKey(target: SshTarget, conflict: Conflict, stillOwned: () => Promise<boolean>): Promise<boolean> {
  const filename = conflict.location?.replace(/:\d+$/, '')
  if (!filename || !path.isAbsolute(filename) || !conflict.fingerprint) return false
  const args = [...(target.options ?? []), ...(target.port ? ['-p', String(target.port)] : []), '--', target.destination]
  const config = (await run('ssh', ['-G', ...args], limits)).stdout
  const value = (name: string) => config.split(/\r?\n/).find(line => line.startsWith(name + ' '))?.slice(name.length + 1).trim()
  const hostname = value('hostname')
  const port = Number(value('port'))
  if (!hostname || !/^[a-z\d:][a-z\d.:%_-]*$/i.test(hostname) || !Number.isInteger(port) || port <= 0 || port > 65535) return false
  // A direct key scan cannot follow a jump/proxy route. Keep the manual verification path there.
  if ([value('proxyjump'), value('proxycommand')].some(v => v && v !== 'none')) return false
  const lookup = value('hostkeyalias') || hostForKnownHosts({ destination: hostname, port, display: hostname })
  if (lookup.toLowerCase() !== conflict.host.toLowerCase()) return false
  const files = (value('userknownhostsfile') ?? '').match(/"[^"]+"|\S+/g) ?? []
  const isConfigured = files.some(f => path.resolve(f.replace(/^"|"$/g, '').replace(/^~(?=[/\\])/, os.homedir())) === path.resolve(filename))
  if (!isConfigured) return false
  const stat = fs.lstatSync(filename)
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > 4 * 1024 * 1024 || (process.getuid && stat.uid !== process.getuid())) return false
  const contents = fs.readFileSync(filename, 'utf8')
  const matches = (await run('ssh-keygen', ['-F', lookup, '-f', filename], limits)).stdout
  const keys = (await run('ssh-keyscan', ['-T', '5', '-p', String(port), hostname], limits)).stdout
  let updated: string | null = null
  for (const line of keys.split(/\r?\n/)) {
    const [, algorithm, encoded] = line.trim().split(/\s+/)
    if (algorithm && encoded) updated = replaceVerifiedEntries(contents, matches, conflict, `${algorithm} ${encoded}`)
    if (updated !== null) break
  }
  if (updated === null || !await stillOwned()) return false
  const temporary = path.join(path.dirname(filename), `.gugu-known-hosts-${randomUUID()}`)
  try {
    fs.writeFileSync(temporary, updated, { flag: 'wx', mode: stat.mode & 0o777 })
    const current = fs.lstatSync(filename)
    if (current.dev !== stat.dev || current.ino !== stat.ino || current.ctimeMs !== stat.ctimeMs || fs.readFileSync(filename, 'utf8') !== contents) return false
    fs.renameSync(temporary, filename)
    return true
  } finally {
    fs.rmSync(temporary, { force: true })
  }
}
