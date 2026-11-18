import { describe, expect, it } from 'vitest'
import type { SessionpageSessionCreateModels } from '@gugu/session-core/session-record/contract'
import { creationThinking } from '../../../apps/desktop/src/mobile/agent-watch/creation-thinking'

const selection = { harness: 'codex', model: 'native', effort: 'vendor-level', permissionMode: null, fastMode: true }
const models: SessionpageSessionCreateModels = {
  harness: 'codex', transport: 'acp', models: [], selected: 'native', selectedEffort: 'vendor-level',
  efforts: [{ id: 'vendor-level', name: 'Native level' }], harnessState: 'ready', harnessReason: null, guguReason: null,
  fast: { model: 'native', selected: 'on', available: [{ id: 'on', name: 'On' }, { id: 'off', name: 'Off' }] },
}
describe('phone creation thinking facts', () => {
  it('preserves advertised native level and Fast intent', () => {
    expect(creationThinking(models, selection)).toMatchObject({ effortOptions: { 'vendor-level': { name: 'Native level' } }, selectedEffort: 'vendor-level', defaultEffort: 'vendor-level', fastMode: true })
  })
  it('defaults a new Fast draft off despite a globally enabled vendor', () => {
    expect(creationThinking(models, { ...selection, fastMode: undefined }).fastMode).toBe(false)
  })
  it.each([null, 'another', 'platform:paid'])('does not reuse Fast across native/default/platform targets %s', model => {
    expect(creationThinking(models, { ...selection, model }).fastMode).toBeUndefined()
  })
  it('does not reuse another provider or an old host capability', () => {
    expect(creationThinking({ ...models, harness: 'claude' }, selection)).toMatchObject({ effortOptions: null, fastMode: undefined })
    expect(creationThinking({ ...models, fast: undefined }, selection).fastMode).toBeUndefined()
  })
})
