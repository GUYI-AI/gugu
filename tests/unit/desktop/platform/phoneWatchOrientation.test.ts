import { describe, expect, it, vi } from 'vitest'
import { createPhoneWatchOrientation, type PhoneWatchOrientationBridge } from '@/platform/phoneWatchOrientation'

vi.mock('@capacitor/core', () => ({ Capacitor: {}, registerPlugin: () => ({}) }))

function bridge() {
  return { set: vi.fn<PhoneWatchOrientationBridge['set']>().mockResolvedValue(undefined),
    release: vi.fn<PhoneWatchOrientationBridge['release']>().mockResolvedValue({ released: true }) }
}

describe('the phone viewing window orientation', () => {
  it('uses the same lease for both orientations and restores it only once', async () => {
    const native = bridge()
    const viewer = createPhoneWatchOrientation(native)
    await viewer.set('landscape')
    await viewer.set('portrait')
    await viewer.release()
    await viewer.release()
    const id = native.set.mock.calls[0]![0].id
    expect(native.set.mock.calls.map(([options]) => options)).toEqual([{ id, orientation: 'landscape' }, { id, orientation: 'portrait' }])
    expect(native.release.mock.calls).toEqual([[{ id }]])
    await expect(viewer.set('landscape')).rejects.toThrow('closed')
  })

  it('waits for the old request and release before the next conversation requests its orientation', async () => {
    let finish!: () => void
    const order: string[] = []
    const native = bridge()
    native.set.mockImplementationOnce(async () => { order.push('old'); await new Promise<void>(resolve => { finish = resolve }) })
      .mockImplementationOnce(async () => { order.push('new') })
    native.release.mockImplementationOnce(async () => { order.push('release') })
    const old = createPhoneWatchOrientation(native)
    const next = createPhoneWatchOrientation(native)
    const pending = old.set('landscape')
    await Promise.resolve()
    const release = old.release()
    const set = next.set('portrait')
    expect(order).toEqual(['old'])
    finish()
    await Promise.all([pending, release, set])
    expect(order).toEqual(['old', 'release', 'new'])
    expect(native.set.mock.calls[0]![0].id).not.toBe(native.set.mock.calls[1]![0].id)
    await next.release()
  })

  it('still releases after a rejected native request and reports the rejection to its caller', async () => {
    const native = bridge()
    native.set.mockRejectedValueOnce(new Error('Activity unavailable'))
    const viewer = createPhoneWatchOrientation(native)
    await expect(viewer.set('landscape')).rejects.toThrow('Activity unavailable')
    await viewer.release()
    expect(native.release).toHaveBeenCalledTimes(1)
  })

  it('does not touch native orientation if the person never requested a rotation', async () => {
    const native = bridge()
    await createPhoneWatchOrientation(native).release()
    expect(native.set).not.toHaveBeenCalled()
    expect(native.release).not.toHaveBeenCalled()
  })
})
