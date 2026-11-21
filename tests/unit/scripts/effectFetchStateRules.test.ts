import { describe, expect, it } from 'vitest'
import { effectLines, exemptionProblems, handRetryLines, literalDefaultLines, reactQueryLines, readExemptions, scanEffectFetchState, scanHandRetries, scanLiteralDefaults, scanReactQuery } from '../../../scripts/checks/effect-fetch-state.mts'

/**
 * @@@client-state-model hard rules (there is no baseline): no effect reads into component state and no reading collapsed
 * to a literal default but what effect-fetch-state-exemptions.txt lists, nothing outside lib/replica.ts reaches react-query.
 * The source is clean, and each rule still catches what it is for (the cases below are injected into it).
 */
describe('the source', () => {
  const rule = 'read what a surface shows through a replica (lib/replica.ts) and branch on unknown / value / error — @@@client-state-model, docs/design/client-state-model.md'
  it('has no effect that fills component state with a read and no reading collapsed to a literal default but the listed', () => {
    expect(exemptionProblems({ 'effect-flow': scanEffectFetchState(), 'reading-default': scanLiteralDefaults() }, readExemptions()), rule).toEqual([])
  })
  it('reaches react-query only through the replica', () => { expect(scanReactQuery(), rule).toEqual({}) })
  it('hands no reading a retry written by hand', () => { expect(scanHandRetries(), rule).toEqual({}) })
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
  const count = (code: string) => effectLines('a.tsx', code).length
  it('an effect that puts an asynchronous answer into state', () => {
    expect(count(component('read().then((v) => setValue(v))'))).toBe(1)
    expect(count(component('void (async () => { setValue(await read()) })()'))).toBe(1)
  })
  // The acceptance probe found these passing the first version of the check.
  it('a setter handed to the continuation, and a function of the component that reads into state', () => {
    expect(count(component('read().then(setValue)'))).toBe(1)
    expect(count(component('void load()', 'const load = async () => setValue(await read())'))).toBe(1)
    expect(count(component('load()', 'const load = useCallback(async () => { setValue(await read()) }, [])'))).toBe(1)
    expect(count(component('load()', 'function load() { read().then(setValue) }'))).toBe(1)
    expect(count(component('outer()', 'const inner = async () => setValue(await read()); const outer = () => { void inner() }'))).toBe(1)
  })
  it('a setter handed to a helper, and useReducer dispatch', () => {
    expect(count(component('load(setValue)'))).toBe(1)
    expect(count(`
    import { useEffect, useReducer } from 'react'
    export function Row() {
      const [value, dispatch] = useReducer(reduce, null)
      useEffect(() => { read().then((v) => dispatch({ v })) }, [])
      return value
    }`)).toBe(1)
  })
  it('not a synchronous update, nor an answer that goes elsewhere', () => {
    expect(count(component('reset()', 'const reset = () => setValue(null)'))).toBe(0)
    expect(count(component('setValue(1)'))).toBe(0)
    expect(count(component('read().then((v) => store.put(v))'))).toBe(0)
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
  it('not null (unknown in the consumer), not a value', () => {
    expect(lines("const xs = r.state === 'value' ? r.value : null")).toHaveLength(0)
    expect(lines("const x = r.state === 'value' ? r.value : other")).toHaveLength(0)
    // `??` on what is not a reading: an ordinary default.
    expect(lines("const value = props.value ?? ''\nconst xs = list ?? []")).toHaveLength(0)
    expect(lines("const fonts = r.state === 'value' ? r.value : null\nconst shown = fonts ?? null")).toHaveLength(0)
  })
})

describe('the exemption list (per file and kind, one entry per finding)', () => {
  const at = (lines: number[]): Record<string, number[]> => lines.length ? { 'apps/desktop/src/a.tsx': lines } : {}
  const found = (flows: number[], defaults: number[] = []) => ({ 'effect-flow': at(flows), 'reading-default': at(defaults) })
  const flow = 'a.tsx: effect-flow(command) - signing in', moment = 'a.tsx: reading-default(moment) - a lookup outside React'
  it('as many entries as findings is clean', () => {
    expect(exemptionProblems(found([3, 9], [5]), [flow, flow, moment])).toEqual([])
    expect(exemptionProblems(found([]), [])).toEqual([])
  })
  it('one finding more than listed is not exempt; one entry more than found is stale', () => {
    expect(exemptionProblems(found([3, 9]), [flow])).toEqual(['a.tsx: effect-flow at line 3, 9: 2 found, 1 listed (an effect fills component state with a read)'])
    expect(exemptionProblems(found([], [5]), [])).toEqual(['a.tsx: reading-default at line 5: 1 found, 0 listed (a reading collapsed to a literal default)'])
    expect(exemptionProblems(found([3]), [flow, flow])).toEqual(['a.tsx: effect-flow: 2 listed, 1 found: remove the stale entry'])
    expect(exemptionProblems(found([3]), [flow, moment])).toEqual(['a.tsx: reading-default: 1 listed, 0 found: remove the stale entry'])
  })
  it('a category not in the list, no reason, a paired entry without its flag, a line not in the form', () => {
    expect(exemptionProblems(found([3]), ['a.tsx: effect-flow(sync) - signing in'])[0]).toMatch(/"sync" is not one of render, dom/)
    expect(exemptionProblems(found([], [5]), ['a.tsx: reading-default(contract) - a list'])[0]).toMatch(/"contract" is not one of moment/)
    expect(exemptionProblems(found([3]), ['a.tsx: effect-flow(command) -'])).toEqual(['a.tsx: effect-flow(command) has no reason'])
    expect(exemptionProblems(found([], [5]), ['a.tsx: reading-default(paired) - the list carries a status'])).toEqual(['a.tsx: a paired exemption names its flag in backticks'])
    expect(exemptionProblems(found([], [5]), ['a.tsx: reading-default(paired) - `known` says whether it was read'])).toEqual([])
    expect(exemptionProblems(found([]), ['a.tsx: effect-flow - signing in'])[0]).toMatch(/^not `<path>/)
  })
})

describe('a reading\'s retry written by hand (what counts)', () => {
  const at = (body: string) => handRetryLines('a.tsx', body)
  it('a retry prop that only refreshes a model, on any element', () => {
    expect(at('const a = <RefreshFailed error={e} onRetry={() => void model.refresh(1)} />')).toEqual([1])
    expect(at('const a = <ReadFailedLine message="x"\n  onRetry={() => { void model.refresh() }} />')).toEqual([2])
  })
  it('a click that only refreshes one entry of a model', () => {
    expect(at('const a = <Button onClick={() => void search.refresh(query)}>Retry</Button>')).toEqual([1])
  })
  it('not the reading\'s own retry, a handler doing several things, or a whole model refreshed by a click', () => {
    expect(at('const a = <RefreshFailed reading={r} />')).toEqual([])
    expect(at('const a = <ReadFailedLine message="x" onRetry={r.retry} />')).toEqual([])
    expect(at('const a = <Button onClick={retryOf(r)} />')).toEqual([])
    expect(at('const a = <RefreshFailed error={e} onRetry={vm.refresh} />')).toEqual([])
    expect(at('const a = <RefreshFailed error={e} onRetry={() => { void one.refresh(); void two.refresh() }} />')).toEqual([])
    expect(at('const a = <IconButton onClick={() => { void counts.refresh() }} />')).toEqual([])
  })
})
