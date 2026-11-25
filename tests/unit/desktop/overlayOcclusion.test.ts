// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { findOcclusion, probeOverlay } from '../../../apps/desktop/src/lib/overlayOcclusion'

// #3857 The probe runs on every overlay that opens, so it also runs in every unit test that renders one. jsdom has no
// layout (no getAnimations, no elementFromPoint): it must judge nothing and never reject — a rejected fire-and-forget
// probe is an unhandled rejection that fails the whole test run.
describe('overlay occlusion probe without layout', () => {
  it('neither rejects nor reports when the DOM cannot hit-test', async () => {
    const popup = document.createElement('div')
    document.body.append(popup)
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(probeOverlay(popup, 'unit')).resolves.toBeUndefined()
    expect(findOcclusion(popup, 'unit')).toBeNull()
    errors.mockRestore()
    popup.remove()
  })
})
