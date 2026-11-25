import { expect, it } from 'vitest'
import { parseAssistantPanelSnapshot } from '../../packages/core/src/cloud/assistantPanel'

const item = { assistant_user_id: 'assistant', owner_user_id: 'owner', domain: 'memory', resource_key: 'note.md',
  device_id: 'device', revision: '4', data: {}, body_item_id: null, body_sha256: null,
  deleted_at: '2026-11-25', observed_at: null, updated_at: '2026-11-25' }
const parse = (origin: object) => parseAssistantPanelSnapshot({ version: 1, revision: '4', items: [{ ...item, ...origin }], application: [] }, 'owner', 'assistant')

it('accepts legacy responses without implying a right to recreate', () => {
  expect(parse({}).items[0]).not.toHaveProperty('deletion_source')
  expect(parse({ deletion_source: null, deletion_runtime_instance_id: null }).items[0]?.deletion_source).toBeNull()
})
it('retains an authenticated runtime deletion origin from the resource response', () => {
  expect(parse({ deletion_source: 'runtime', deletion_runtime_instance_id: 'runtime' }).items[0])
    .toMatchObject({ deletion_source: 'runtime', deletion_runtime_instance_id: 'runtime', revision: '4' })
})
it.each([
  { deletion_source: 'runtime' },
  { deletion_source: 'runtime', deletion_runtime_instance_id: '' },
  { deletion_source: 'panel', deletion_runtime_instance_id: 'runtime' },
  { deletion_runtime_instance_id: 'runtime' },
  { deletion_source: 'unknown', deletion_runtime_instance_id: null },
  { deleted_at: null, deletion_source: 'runtime', deletion_runtime_instance_id: 'runtime' },
])('rejects inconsistent deletion provenance instead of trusting it: %j', origin => {
  expect(() => parse(origin)).toThrow('Assistant panel data could not be read')
})
