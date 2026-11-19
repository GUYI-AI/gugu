import { describe, expect, it } from 'vitest'
import { EXEMPTIONS, handRetryLines, literalDefaultLines, parseMarker, reactQueryLines, scanEffectFetchState, scanFile, scanHandRetries, scanLiteralDefaults, scanMarkers, scanReactQuery } from '../../../scripts/checks/effect-fetch-state.mts'

/**
 * @@@client-state-model hard rules (there is no baseline): no effect reads
 * into component state, no reading collapsed to a literal default, nothing outside lib/replica.ts reaches react-query.
 * The source is clean, and each rule still catches what it is for (the cases below are injected into it).
 */
describe('the source', () => {
  const rule = 'read what a surface shows through a replica (lib/replica.ts) and branch on unknown / value / error — @@@client-state-model, docs/design/client-state-model.md'
  it('has no effect that fills component state with a read', () => { expect(scanEffectFetchState(), rule).toEqual({}) })
  it('has no reading collapsed to a literal default', () => { expect(scanLiteralDefaults(), rule).toEqual({}) })
  it('reaches react-query only through the replica', () => { expect(scanReactQuery(), rule).toEqual({}) })
  it('hands no reading a retry written by hand', () => { expect(scanHandRetries(), rule).toEqual({}) })
  it('has every exemption marker in a listed category, with its reason', () => { expect(scanMarkers(), 'see EXEMPTIONS in scripts/checks/effect-fetch-state.mts').toEqual({}) })
})

describe('react-query past the replica (what counts)', () => {
  const lines = (code: string, path = 'apps/desktop/src/a.tsx') => reactQueryLines(path, code)
  it('anything imported from react-query but a write (whatever it is renamed to)', () => {
    for (const name of ['useQuery', 'useQueries', 'useInfiniteQuery', 'useSuspenseQuery', 'useIsFetching', 'useQueryClient', 'QueryObserver', 'QueryClient']) {
      expect(lines(`import { ${name} } from '@tanstack/react-query'`), name).toEqual([1])
    }
    expect(lines("import { useQuery as read } from '@tanstack/react-query'\nread({ queryKey: ['a'] })")).toEqual([1])
    expect(lines("import * as rq from '@tanstack/react-query'")).toEqual([1])
    expect(lines("import rq from '@tanstack/react-query'")).toEqual([1])
    expect(lines("export { useQuery } from '@tanstack/react-query'")).toEqual([1])
    expect(lines("import { QueryObserver } from '@tanstack/query-core'")).toEqual([1])
    expect(lines("const m = await import('@tanstack/react-query')")).toEqual([1])
  })
  it('the writes, the provider, the sharing helper and types are allowed', () => {
    expect(lines("import { useMutation, useMutationState, QueryClientProvider, replaceEqualDeep } from '@tanstack/react-query'")).toEqual([])
    expect(lines("import type { QueryKey } from '@tanstack/react-query'\nimport { type UseQueryResult } from '@tanstack/react-query'")).toEqual([])
  })
  it('a method of the client', () => {
    expect(lines("import { queryClient } from '@/lib/replica'\nqueryClient.invalidateQueries({ queryKey: ['a'] })")).toEqual([2])
    expect(lines("queryClient.getQueryCache().subscribe(() => {})")).toEqual([1])
  })
  it('not the replica itself, not a test, and not a write handed the client', () => {
    expect(lines("useQuery({ queryKey: ['a'] })", 'apps/desktop/src/lib/replica.ts')).toEqual([])
    expect(lines("useQuery({ queryKey: ['a'] })", 'apps/desktop/src/a.test.tsx')).toEqual([])
    expect(lines("import { useMutation } from '@tanstack/react-query'\nimport { queryClient } from '@/lib/replica'\nuseMutation({ mutationFn: save }, queryClient)")).toEqual([])
  })
})

describe('what counts', () => {
  const component = (effect: string, above = '') => `
    import { useEffect, useState } from 'react'
    export function Row() {
      const [value, setValue] = useState(null)
      ${above}
      useEffect(() => { ${effect} }, [])
      return value
    }`
  it('an effect that puts an asynchronous answer into state', () => {
    expect(scanFile('a.tsx', component('read().then((v) => setValue(v))'))).toBe(1)
    expect(scanFile('a.tsx', component('void (async () => { setValue(await read()) })()'))).toBe(1)
  })
  // The acceptance probe found these passing the first version of the check.
  it('a setter handed to the continuation, and a function of the component that reads into state', () => {
    expect(scanFile('a.tsx', component('read().then(setValue)'))).toBe(1)
    expect(scanFile('a.tsx', component('void load()', 'const load = async () => setValue(await read())'))).toBe(1)
    expect(scanFile('a.tsx', component('load()', 'const load = useCallback(async () => { setValue(await read()) }, [])'))).toBe(1)
    expect(scanFile('a.tsx', component('load()', 'function load() { read().then(setValue) }'))).toBe(1)
    expect(scanFile('a.tsx', component('outer()', 'const inner = async () => setValue(await read()); const outer = () => { void inner() }'))).toBe(1)
  })
  it('a setter handed to a helper, and useReducer dispatch', () => {
    expect(scanFile('a.tsx', component('load(setValue)'))).toBe(1)
    expect(scanFile('a.tsx', `
    import { useEffect, useReducer } from 'react'
    export function Row() {
      const [value, dispatch] = useReducer(reduce, null)
      useEffect(() => { read().then((v) => dispatch({ v })) }, [])
      return value
    }`)).toBe(1)
  })
  it('not a synchronous update, nor an answer that goes elsewhere', () => {
    expect(scanFile('a.tsx', component('reset()', 'const reset = () => setValue(null)'))).toBe(0)
    expect(scanFile('a.tsx', component('setValue(1)'))).toBe(0)
    expect(scanFile('a.tsx', component('read().then((v) => store.put(v))'))).toBe(0)
  })
  it('a flow says its category and reason; a marker without either still counts', () => {
    expect(scanFile('a.tsx', component('start().then((v) => setValue(v))', '// @@@effect-flow(command) - signing in'))).toBe(0)
    expect(scanFile('a.tsx', component('start().then((v) => setValue(v))', '// @@@effect-flow'))).toBe(1)
    expect(scanFile('a.tsx', component('start().then((v) => setValue(v))', '// @@@effect-flow - signing in'))).toBe(1)
    expect(scanFile('a.tsx', component('start().then((v) => setValue(v))', '// @@@effect-flow(sync) - signing in'))).toBe(1)
    expect(scanFile('a.tsx', component('start().then((v) => setValue(v))', '// @@@effect-flow(command) -'))).toBe(1)
  })
  it('an event exemption puts no pushed data in state (a setter handed to a listener, or its payload set, counts)', () => {
    expect(scanFile('a.tsx', component('return bus.on(setValue)', '// @@@effect-flow(event) - the share sheet'))).toBe(1)
    expect(scanFile('a.tsx', component('return bus.on((payload) => setValue(payload.rows))', '// @@@effect-flow(event) - a revision listener'))).toBe(1)
    expect(scanFile('a.tsx', component('return bus.on(() => setValue(true))', '// @@@effect-flow(event) - a local flag when the share sheet opens'))).toBe(0)
  })
})

describe('a reading collapsed to a literal default (@@@client-state-model)', () => {
  const lines = (code: string) => literalDefaultLines('a.ts', code)
  it('counts the literal defaults', () => {
    expect(lines("const xs = r.state === 'value' ? r.value : []")).toHaveLength(1)
    expect(lines("const n = r.state === 'value' ? r.value.length : 0")).toHaveLength(1)
    expect(lines("const t = r.state === 'value' ? r.value : EMPTY_TOPICS")).toHaveLength(1)
    expect(lines("const c = r.state === 'value' ? r.value : NO_PLATFORM_CATALOG")).toHaveLength(1)
    expect(lines("const s = r.state === 'value' ? r.value.name : ''")).toHaveLength(1)
    expect(lines("const on = r.state === 'value' ? r.value.on : false")).toHaveLength(1)
    expect(lines("const o = r.state === 'value' ? r.value : {}")).toHaveLength(1)
  })
  it('counts every spelling of the check and of the fold', () => {
    expect(lines("const xs = r.state !== 'value' ? [] : r.value")).toHaveLength(1)
    expect(lines("const xs = !(r.state === 'value') ? [] : r.value")).toHaveLength(1)
    expect(lines("const xs = 'value' === r.state ? r.value : []")).toHaveLength(1)
    expect(lines("const r = useReplica(m, [])\nconst xs = r.value ?? []")).toEqual([2])
    expect(lines("if (r.state === 'value') use(r.value)\nconst xs = r.value ?? []")).toEqual([2])
    expect(lines("const xs = (r.state === 'value' && r.value) || []")).toHaveLength(1)
    // The two-step fold: unknown kept as null, then collapsed downstream.
    expect(lines("const fonts = r.state === 'value' ? r.value : null\nconst names = fonts ?? []")).toEqual([2])
    expect(lines("const hosts = r.state === 'value' ? r.value : null\nconst n = hosts?.length ?? 0")).toEqual([2])
    expect(lines("const v = r.state === 'value' ? r.value : null\nconst list = v || []")).toEqual([2])
  })
  it('not null (unknown in the consumer), not a value, and not a marked exception', () => {
    expect(lines("const xs = r.state === 'value' ? r.value : null")).toHaveLength(0)
    expect(lines("const x = r.state === 'value' ? r.value : other")).toHaveLength(0)
    expect(lines("// @@@reading-default(moment) - a lookup outside React\nconst xs = r.state === 'value' ? r.value : []")).toHaveLength(0)
    expect(lines("// @@@reading-default\nconst xs = r.state === 'value' ? r.value : []")).toHaveLength(1)
    expect(lines("// @@@reading-default - a lookup outside React\nconst xs = r.state === 'value' ? r.value : []")).toHaveLength(1)
    // `??` on what is not a reading: an ordinary default.
    expect(lines("const value = props.value ?? ''\nconst xs = list ?? []")).toHaveLength(0)
    expect(lines("const fonts = r.state === 'value' ? r.value : null\nconst shown = fonts ?? null")).toHaveLength(0)
  })
})

describe('exemption markers (coordinator 2026-11-16: a fixed list of categories)', () => {
  it('no category, a category not in the list, an empty reason: each is a finding', () => {
    expect(parseMarker('// @@@effect-flow - signing in')?.problem).toBe('no category')
    expect(parseMarker('// @@@reading-default - a lookup')?.problem).toBe('no category')
    expect(parseMarker('// @@@effect-flow(subscribe) - a listener')?.problem).toMatch(/not one of/)
    expect(parseMarker('// @@@reading-default(contract) - a list')?.problem).toMatch(/not one of/)
    expect(parseMarker('// @@@effect-flow(command) - ')?.problem).toBe('no reason')
    expect(parseMarker('// @@@reading-default(moment)')?.problem).toBe('no reason')
  })
  it('a paired exemption names its flag', () => {
    expect(parseMarker('// @@@reading-default(paired) - the list carries a status')?.problem).toMatch(/flag/)
    expect(parseMarker('// @@@reading-default(paired) - `known` says whether it was read')?.problem).toBeNull()
  })
  it('each listed category is a valid exemption', () => {
    const legal: Record<string, string> = { paired: '`ready` says whether it was read' }
    for (const [kind, categories] of Object.entries(EXEMPTIONS)) {
      for (const category of Object.keys(categories)) {
        expect(parseMarker(`// @@@${kind}(${category}) - ${legal[category] ?? 'a reason'}`), `${kind}(${category})`).toMatchObject({ category, problem: null })
      }
    }
  })
})

describe('a reading\'s retry written by hand (what counts)', () => {
  const at = (body: string) => handRetryLines('a.tsx', body)
  it('a RefreshFailed / ReadFailedLine whose onRetry only refreshes a model', () => {
    expect(at('const a = <RefreshFailed error={e} onRetry={() => void model.refresh(1)} />')).toEqual([1])
    expect(at('const a = <ReadFailedLine message="x"\n  onRetry={() => { void model.refresh() }} />')).toEqual([1])
  })
  it('not the reading\'s own retry, a retry doing several things, or another element', () => {
    expect(at('const a = <RefreshFailed reading={r} />')).toEqual([])
    expect(at('const a = <ReadFailedLine message="x" onRetry={r.retry} />')).toEqual([])
    expect(at('const a = <RefreshFailed error={e} onRetry={() => { void one.refresh(); void two.refresh() }} />')).toEqual([])
    expect(at('const a = <Button onRetry={() => void model.refresh()} />')).toEqual([])
  })
})
