import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { replaceVerifiedEntries } from '../../../../apps/desktop/electron/server/ssh-host-key-recovery'

const bytes = Buffer.from('independently verified test key')
const key = 'ssh-ed25519 ' + bytes.toString('base64')
const host = '[host.example]:2222'
const conflict = { host, fingerprint: 'SHA256:' + createHash('sha256').update(bytes).digest('base64url').replace(/-/g, '+').replace(/_/g, '/'), location: '/fixture/known_hosts:2' }
const original = 'other ssh-ed25519 AAAA\r\n' + host + ' ssh-rsa BBBB\r\n' + host + ' ssh-ed25519 CCCC\r\n'
const matches = '# Host [host.example]:2222 found: line 2\n# Host [host.example]:2222 found: line 3\n'
describe('an independently verified replacement host key', () => {
  it('replaces only the matched host and port, preserving unrelated bytes', () => {
    expect(replaceVerifiedEntries(original, matches, conflict, key)).toBe('other ssh-ed25519 AAAA\r\n' + host + ' ' + key + '\r\n')
  })
  it('rejects a second key change, a stale line, compound hosts and revocation records', () => {
    expect(replaceVerifiedEntries(original, matches, conflict, 'ssh-ed25519 AAAA')).toBeNull()
    expect(replaceVerifiedEntries(original, matches, { ...conflict, location: '/fixture/known_hosts:1' }, key)).toBeNull()
    for (const entry of [host + ',other', '@revoked ' + host, '*.example']) {
      expect(replaceVerifiedEntries(original.replace(host, entry), matches, conflict, key)).toBeNull()
    }
  })
})
