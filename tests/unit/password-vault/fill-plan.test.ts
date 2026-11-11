import { describe, expect, it } from 'vitest'
import type { PasswordItem } from '../../../packages/core/src/shared/passwordBetaProtocol'
import { resolveFill } from '../../../apps/desktop/electron/password-vault/fill-plan'

const item = (extra: Partial<PasswordItem> = {}): PasswordItem => ({ reference: { id: 'c', version: 1, epoch: 'e' }, name: 'OpenAI', origin: 'https://api.openai.com',
  account: 'dev@example.com', maskedAccount: 'd***@example.com', accountSecret: false, hasPassword: true, grants: [], sites: [],
  fields: [{ id: 'f-key', name: 'API Key', secret: true }, { id: 'f-otp', name: 'TOTP', secret: true }, { id: 'f-org', name: 'Org', secret: false, value: 'org-1' }], ...extra })

describe('naming the values an Agent wants filled', () => {
  it('maps 账号/密码 and value names (any case) to the vault plan, in order, with which ones are secret', () => {
    expect(resolveFill(item(), [{ field: 'Account', into: '#a' }, { field: '密码', into: '#p' }, { field: 'api key', into: '#k' }, { field: 'Org', into: '#o' }, { field: 'TOTP', into: '#c', code: true }])).toEqual({
      values: [{ kind: 'account' }, { kind: 'password' }, { kind: 'field', id: 'f-key' }, { kind: 'field', id: 'f-org' }, { kind: 'code', id: 'f-otp' }],
      names: ['账号', '密码', 'API Key', 'Org', 'TOTP 的验证码'], secret: [false, true, true, false, false],
      sources: ['saved', 'saved', 'saved', 'saved', 'saved'], given: [undefined, undefined, undefined, undefined, undefined] })
    expect(resolveFill(item({ accountSecret: true }), [{ field: '账号', into: '#a' }])).toMatchObject({ secret: [true] })
  })
  it('asks the person for what is not saved, takes what the Agent already knows, and never a password from the Agent', () => {
    // The credential has no password: the person types it on the card.
    expect(resolveFill(item({ hasPassword: false }), [{ field: '账号', into: '#a' }, { field: '密码', into: '#p' }])).toMatchObject({
      values: [{ kind: 'account' }, { kind: 'typed' }], sources: ['saved', 'missing'], secret: [false, true] })
    // Nothing saved: the username the Agent knows is given, the password is the person's.
    expect(resolveFill(undefined, [{ field: 'username', into: '#a', value: 'dev@example.com' }, { field: 'password', into: '#p' }])).toMatchObject({
      values: [{ kind: 'typed' }, { kind: 'typed' }], names: ['账号', '密码'], sources: ['given', 'missing'], given: ['dev@example.com', undefined], secret: [false, true] })
    // A new named value is secret until the person says otherwise.
    expect(resolveFill(undefined, [{ field: 'API Key', into: '#k' }])).toMatchObject({ sources: ['missing'], secret: [true] })
    expect(resolveFill(undefined, [{ field: '密码', into: '#p', value: 'hunter2' }])).toMatchObject({ status: 'invalid_request' })
    expect(resolveFill(item(), [{ field: '账号', into: '#a', code: true }])).toMatchObject({ status: 'invalid_request' })
  })
})
