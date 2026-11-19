import { describe, expect, it, vi } from 'vitest'
import { unsupportedAccountClosure } from '@/platform/accountClosure'
import { iosAccountClosure } from '@/platform/iosAccountClosure'

vi.mock('@capacitor/core', () => ({ registerPlugin: () => ({}) }))
const scope = { ownerId: 'owner-A', localOperationId: 'operation-A' }
describe('native account closure boundary', () => {
  it('preserves the exact opaque receipt and scope without a fallback', async () => {
    const put = vi.fn().mockResolvedValue(undefined)
    const get = vi.fn().mockResolvedValue({ value: 'opaque-receipt' })
    const remove = vi.fn().mockResolvedValue(undefined)
    const eraseLocal = vi.fn().mockResolvedValue({ status: 'pending', retainedUnattributed: [] })
    const client = iosAccountClosure({ put, get, remove, eraseLocal })
    await client.receipt.put(scope, 'opaque-receipt')
    expect(put).toHaveBeenCalledExactlyOnceWith({ ...scope, receipt: 'opaque-receipt' })
    expect(await client.receipt.get(scope)).toBe('opaque-receipt')
    expect(await client.eraseLocal(scope)).toEqual({ status: 'pending', retainedUnattributed: [] })
    expect(remove).not.toHaveBeenCalled()
    await client.receipt.remove(scope)
    expect(remove).toHaveBeenCalledExactlyOnceWith(scope)
  })
  it('keeps storage failure distinct from a missing value', async () => {
    const error = new Error('native storage unavailable')
    const client = iosAccountClosure({ put: vi.fn(), get: vi.fn().mockRejectedValue(error), remove: vi.fn(), eraseLocal: vi.fn() })
    await expect(client.receipt.get(scope)).rejects.toBe(error)
  })
  it('rejects a missing retainedUnattributed field rather than claiming complete', async () => {
    const client = iosAccountClosure({ put: vi.fn(), get: vi.fn(), remove: vi.fn(), eraseLocal: vi.fn().mockResolvedValue({ status: 'complete' }) })
    await expect(client.eraseLocal(scope)).rejects.toThrow('Invalid native closure cleanup reply')
  })
  it('rejects unsupported native operations on the remaining shells', async () => {
    await expect(unsupportedAccountClosure.receipt.put(scope, 'opaque')).rejects.toThrow('unsupported')
    await expect(unsupportedAccountClosure.receipt.get(scope)).rejects.toThrow('unsupported')
    await expect(unsupportedAccountClosure.receipt.remove(scope)).rejects.toThrow('unsupported')
    await expect(unsupportedAccountClosure.eraseLocal(scope)).rejects.toThrow('unsupported')
  })
})
