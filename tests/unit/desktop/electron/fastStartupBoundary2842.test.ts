import { expect, it } from 'vitest'
import { buildInitialSessionDocument } from '../../../../apps/desktop/src/session/shared/core/sessions/initial-session-document'

it.each([
  [null, true, true],
  [null, false, false],
  [{ modelId: 'credits-model' }, true, false],
  [undefined, true, false],
] as const)('only arms explicit own-account Fast in the shared creation document (%j, %s)', (platformModel, fastMode, expected) => {
  const document = buildInitialSessionDocument({
    id: 'fast-task', provider: 'codex', sessionView: 'general', prompt: 'hello',
    permissionMode: 'edit', model: 'native-model', effort: 'high', platformModel, fastMode,
  })
  expect(document.fastMode).toBe(expected)
  expect(document.model).toBe('native-model')
  expect(document.effort).toBe('high')
})
