import { describe, expect, it } from 'vitest'
import { createContactQrPayload, createGroupInviteQrPayload, createGuguQrUrl } from '@gugu/core/shared/qrPayload'
import { resolveQrScanRoute } from '../../../../apps/desktop/src/lib/qrScanRoute'

const TOKEN = '9f86d081884c7d659a2feaa0c55ad015'

describe('short QR link', () => {
  it('a group invite is ≤ 60 chars: base, public_id, token as base64url', () => {
    const link = createGuguQrUrl(createGroupInviteQrPayload(208803, TOKEN))
    expect(link).toBe('https://gugu.nextmind.space/j/?208803.n4bQgYhMfWWaL-qgxVrQFQ')
    expect(link.length).toBeLessThanOrEqual(60)
    expect(resolveQrScanRoute(link)).toEqual({ nav: 'group_join', publicId: 208803, joinToken: TOKEN })
  })

  it('a contact is the bare 咕咕号', () => {
    const link = createGuguQrUrl(createContactQrPayload(123456789))
    expect(link).toBe('https://gugu.nextmind.space/j/?123456789')
    expect(resolveQrScanRoute(link)).toEqual({ nav: 'add_friend', query: '123456789' })
  })

  it('the site hands the same code to the App on its own scheme', () => {
    expect(resolveQrScanRoute(`gugu://gugu.nextmind.space/j/?208803.n4bQgYhMfWWaL-qgxVrQFQ`))
      .toEqual({ nav: 'group_join', publicId: 208803, joinToken: TOKEN })
  })

  it('refuses to encode a token the database never makes', () => {
    expect(() => createGuguQrUrl(createGroupInviteQrPayload(1, 'not-hex'))).toThrow(/32-hex/)
    expect(() => createGuguQrUrl(createGroupInviteQrPayload(1))).toThrow(/32-hex/)
  })

  it('a malformed short code resolves to nothing', () => {
    expect(resolveQrScanRoute('https://gugu.nextmind.space/j/?208803.short')).toBeNull()
    expect(resolveQrScanRoute('https://gugu.nextmind.space/j/?')).toBeNull()
    expect(resolveQrScanRoute('https://gugu.nextmind.space/zh/?208803')).toBeNull()
  })
})

describe('legacy ?gugu_qr= codes (already printed) still scan', () => {
  const legacy = (base: string, payload: object) => `${base}?gugu_qr=${encodeURIComponent(JSON.stringify(payload))}`

  it('the poster code on the APK download URL joins the group', () => {
    const link = legacy('https://download.gugu.nextmind.space/releases/android/latest/gugu-android.apk',
      { version: 1, kind: 'group_invite', group_public_id: 208803, join_token: TOKEN })
    expect(resolveQrScanRoute(link)).toEqual({ nav: 'group_join', publicId: 208803, joinToken: TOKEN })
  })

  it('reads the payload on any origin and path (#3303), contacts included', () => {
    expect(resolveQrScanRoute(legacy('https://sender.example/some/other/path', { version: 1, kind: 'group_invite', group_public_id: 33, join_token: 'cross-base' })))
      .toEqual({ nav: 'group_join', publicId: 33, joinToken: 'cross-base' })
    expect(resolveQrScanRoute(legacy('https://app.gugu.nextmind.space/invite', { version: 1, kind: 'contact', gugu_number: 42 })))
      .toEqual({ nav: 'add_friend', query: '42' })
  })

  it('a plain URL or a malformed payload resolves to nothing, without throwing', () => {
    expect(resolveQrScanRoute('https://example.com')).toBeNull()
    expect(resolveQrScanRoute('https://app.gugu.nextmind.space/invite?gugu_qr=%7Bbad-json')).toBeNull()
  })
})
