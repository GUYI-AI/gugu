import { readFile } from 'node:fs/promises'
import { hostname, platform } from 'node:os'
import { resolve, sep } from 'node:path'

export const LEGACY_MAX_BYTES = 100_000_000
export function assertLegacySize(bytes: number): void {
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes >= LEGACY_MAX_BYTES) {
    throw new Error('Legacy whole-read comparison requires a source smaller than 100 MB')
  }
}
export function checkScopeLimits(memory: string, cpu: string): void {
  const maximum = Number(memory.trim())
  const [quota, period] = cpu.trim().split(/\s+/).map(Number)
  if (!Number.isSafeInteger(maximum) || maximum <= 0 || maximum > 4 * 1024 ** 3) throw new Error('MemoryMax must be at most 4G')
  if (!Number.isSafeInteger(quota) || !Number.isSafeInteger(period) || quota <= 0 || period <= 0 || quota / period > 2) {
    throw new Error('CPUQuota must be at most 200%')
  }
}
/** Check effective cgroup limits, rather than trusting the launch command's spelling. */
export async function assertAcceptanceScope(expectedHost: string): Promise<string> {
  if (platform() !== 'linux' || !expectedHost || hostname() !== expectedHost) throw new Error('An explicitly admitted Linux host is required')
  const group = (await readFile('/proc/self/cgroup', 'utf8')).split('\n').find(line => line.startsWith('0::'))?.slice(3)
  if (!group?.endsWith('.scope')) throw new Error('The whole acceptance process must run in a systemd scope')
  const base = '/sys/fs/cgroup'
  const directory = resolve(base, `.${group}`)
  if (!directory.startsWith(base + sep)) throw new Error('Invalid cgroup path')
  const [memory, cpu] = await Promise.all([readFile(`${directory}/memory.max`, 'utf8'), readFile(`${directory}/cpu.max`, 'utf8')])
  checkScopeLimits(memory, cpu)
  return directory
}
