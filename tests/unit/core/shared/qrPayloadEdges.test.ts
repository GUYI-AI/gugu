import { describe, expect, it } from 'vitest'
import { createContactQrPayload, createGroupInviteQrPayload, createGuguQrUrl, parseGuguQrPayload } from '@gugu/core/shared/qrPayload'

describe('QR payload boundaries', () => {
  it('does not read inherited fields or arrays as payload objects', () => {
    const prototype = { version: 1, kind: 'contact', gugu_number: 7 }
    expect(parseGuguQrPayload(Object.create(prototype))).toBeNull()
    expect(parseGuguQrPayload(Object.assign([], prototype))).toBeNull()
    expect(parseGuguQrPayload({ payload: Object.create(prototype) })).toBeNull()
    expect(parseGuguQrPayload({ payload: Object.assign([], prototype) })).toBeNull()
    expect(parseGuguQrPayload({ payload: { ...prototype } })).toMatchObject(prototype)
    expect(parseGuguQrPayload({ ...prototype })).toMatchObject(prototype)
  })
  it('validates ids when URL input was constructed without the payload factories', () => {
    expect(() => createGuguQrUrl({ version: 1, kind: 'contact', gugu_number: 0 })).toThrow()
    expect(() => createGuguQrUrl({ version: 1, kind: 'group_invite', group_public_id: -1, join_token: 'a'.repeat(32) })).toThrow()
  })
  it('rejects ids that cannot be represented without rounding', () => {
    const id = Number.MAX_SAFE_INTEGER + 1
    expect(parseGuguQrPayload(`https://example.test/j/?${id}`)).toBeNull()
    expect(parseGuguQrPayload({ version: 1, kind: 'contact', gugu_number: id })).toBeNull()
    expect(() => createContactQrPayload(id)).toThrow()
    expect(() => createGroupInviteQrPayload(id, 'a'.repeat(32))).toThrow()
    expect(parseGuguQrPayload(`https://example.test/j/?${Number.MAX_SAFE_INTEGER}`)).toMatchObject({ gugu_number: Number.MAX_SAFE_INTEGER })
  })
})
