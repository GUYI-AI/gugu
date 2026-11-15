import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { literalDefaultLines, scanEffectFetchState, scanFile, scanLiteralDefaults } from '../../../scripts/checks/effect-fetch-state.mts'

/**
 * @@@replica ratchet: the old shape (an effect reads, then puts the answer into component state) only goes down.
 * The baseline is the debt list; a file leaves it when its surfaces read through the replica (lib/replica.ts).
 */
const BASELINE = 'scripts/checks/effect-fetch-state-baseline.json'
const baseline = JSON.parse(readFileSync(BASELINE, 'utf8')) as Record<string, number>

describe('effect-fetch-state ratchet', () => {
  const actual = scanEffectFetchState()

  it('no file gains the shape, and no new file has it', () => {
    const grown = Object.entries(actual).filter(([file, count]) => count > (baseline[file] ?? 0))
    expect(grown, 'read what a surface shows through a replica (lib/replica.ts), not an effect into useState — @@@client-state-model, docs/design/client-state-model.md').toEqual([])
  })

  it('the baseline records every decrease (so the debt never grows back unnoticed)', () => {
    const stale = Object.entries(baseline).filter(([file, count]) => (actual[file] ?? 0) < count)
    expect(stale, `lower these in ${BASELINE} (node scripts/checks/effect-fetch-state.mts --write)`).toEqual([])
  })

  it('the settings surfaces have none left', () => {
    const settings = Object.keys(actual).filter((file) => /\/components\/(settings|usage|agentsettings|devices)\/|\/session\/renderer\/features\/settings\//.test(file))
    expect(settings, 'Settings reads through replicas only — @@@client-state-model, docs/design/client-state-model.md').toEqual([])
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
  it('a flow says so with its reason; a bare marker still counts', () => {
    expect(scanFile('a.tsx', component('start().then((v) => setValue(v))', '// @@@effect-flow - signing in'))).toBe(0)
    expect(scanFile('a.tsx', component('start().then((v) => setValue(v))', '// @@@effect-flow'))).toBe(1)
  })
})

describe('a reading collapsed to a literal default (@@@client-state-model)', () => {
  it('none in the source: branch on the three states, or say why with @@@reading-default', () => {
    expect(scanLiteralDefaults(), 'an unknown reading must not draw like a stored empty value — docs/design/client-state-model.md').toEqual({})
  })
  const lines = (code: string) => literalDefaultLines('a.ts', code)
  it('counts the literal defaults', () => {
    expect(lines("const xs = r.state === 'value' ? r.value : []")).toHaveLength(1)
    expect(lines("const n = r.state === 'value' ? r.value.length : 0")).toHaveLength(1)
    expect(lines("const t = r.state === 'value' ? r.value : EMPTY_TOPICS")).toHaveLength(1)
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
    expect(lines("// @@@reading-default - a lookup outside React\nconst xs = r.state === 'value' ? r.value : []")).toHaveLength(0)
    expect(lines("// @@@reading-default\nconst xs = r.state === 'value' ? r.value : []")).toHaveLength(1)
    // `??` on what is not a reading: an ordinary default.
    expect(lines("const value = props.value ?? ''\nconst xs = list ?? []")).toHaveLength(0)
    expect(lines("const fonts = r.state === 'value' ? r.value : null\nconst shown = fonts ?? null")).toHaveLength(0)
  })
})
