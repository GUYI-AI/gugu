import { expect, it } from 'vitest'
import { codexStartupFastTier } from '../../../../apps/desktop/electron/sessionpage/codex-startup-fast-tier'

const catalog = {
  kind: 'ready' as const, selected: 'native-a', models: [], efforts: [], selectedEffort: null,
  fastMode: { configId: 'fast', selected: 'off', available: [{ id: 'off', name: 'Off' }, { id: 'on', name: 'On' }] },
}
it('pins the native Fast tier only for a verified own-account target, clearing a global default otherwise', () => {
  const input = { enabled: true, model: 'native-a', credits: false, catalog }
  expect(codexStartupFastTier(input)).toBe('priority')
  expect(codexStartupFastTier({ ...input, enabled: false })).toBe('default')
  expect(codexStartupFastTier({ ...input, credits: true })).toBe('default')
  expect(codexStartupFastTier({ ...input, model: 'unsupported-target' })).toBe('default')
  expect(codexStartupFastTier({ ...input, catalog: null })).toBe('default')
  expect(codexStartupFastTier({ ...input, catalog: { ...catalog, fastMode: undefined } })).toBe('default')
})
