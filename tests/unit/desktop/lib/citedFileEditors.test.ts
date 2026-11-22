import { beforeEach, expect, it, vi } from 'vitest'

const rows = vi.hoisted(() => ({
  items: {} as Record<string, { created_by: string | null; updated_by: string | null }>,
  versions: {} as Record<string, { made_by: string | null }[]>,
  calls: [] as { fn: string; args: Record<string, string> }[],
}))
vi.mock('@/lib/supabase', () => ({
  chatDb: {
    rpc: (fn: string, args: Record<string, string>) => {
      rows.calls.push({ fn, args })
      if (fn === 'workspace_get_as') return { select: () => ({ single: async () => ({ data: rows.items[args.p_item_id], error: null }) }) }
      return Promise.resolve({ data: rows.versions[args.p_item_id] ?? [], error: null })
    },
  },
}))

const { citedFileEditorIds } = await import('@/lib/citedFileEditors')

const A = '0b6f6c1e-58a4-4a39-9a37-3f1f4c7a2d10'
const B = '5d1e2c3b-4a59-4f6e-8d7c-9b0a1f2e3d4c'

beforeEach(() => {
  rows.calls.length = 0
  rows.items = { [A]: { created_by: 'maker', updated_by: 'agent' }, [B]: { created_by: 'other', updated_by: null } }
  rows.versions = { [A]: [{ made_by: 'agent' }, { made_by: 'reviser' }, { made_by: null }] }
})

it('collects creators, last editors and version authors of every cited file, once each', async () => {
  const text = `see @[a.md](gugu-file://${A}?v=2#L3-5) and @[a.md](gugu-file://${A}) and @[b.png](gugu-file://${B}?v=1)`
  expect((await citedFileEditorIds(text, 'me')).sort()).toEqual(['agent', 'maker', 'other', 'reviser'])
  expect(rows.calls.filter((call) => call.fn === 'workspace_get_as').map((call) => call.args)).toEqual([
    { p_item_id: A, p_as_user_id: 'me' }, { p_item_id: B, p_as_user_id: 'me' },
  ])
})

it('reads nothing for a message without file links', async () => {
  expect(await citedFileEditorIds('plain words, https://example.com', 'me')).toEqual([])
  expect(rows.calls).toEqual([])
})
