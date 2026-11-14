import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { scanEffectFetchState, scanFile } from '../../../scripts/checks/effect-fetch-state.mts'

/**
 * @@@read-model ratchet: the old shape (an effect reads, then puts the answer into component state) only goes down.
 * The baseline is the debt list; a file leaves it when its surfaces read through the read model (lib/readModel.ts).
 */
const BASELINE = 'scripts/checks/effect-fetch-state-baseline.json'
const baseline = JSON.parse(readFileSync(BASELINE, 'utf8')) as Record<string, number>

describe('effect-fetch-state ratchet', () => {
  const actual = scanEffectFetchState()

  it('no file gains the shape, and no new file has it', () => {
    const grown = Object.entries(actual).filter(([file, count]) => count > (baseline[file] ?? 0))
    expect(grown, 'read what a surface shows through a read model (lib/readModel.ts), not an effect into useState').toEqual([])
  })

  it('the baseline records every decrease (so the debt never grows back unnoticed)', () => {
    const stale = Object.entries(baseline).filter(([file, count]) => (actual[file] ?? 0) < count)
    expect(stale, `lower these in ${BASELINE} (node scripts/checks/effect-fetch-state.mts --write)`).toEqual([])
  })

  // The App market and the assistant's connections are drawn inside Settings but belong to the App and assistant domains
  // (PR 3 of open-flicker); they leave the baseline with those domains.
  const OTHER_DOMAINS = new Set([
    'apps/desktop/src/session/renderer/features/settings/components/ExtensionsSettingsCard.tsx',
    'apps/desktop/src/components/settings/MobileAppsSection.tsx',
    'apps/desktop/src/components/settings/channels/useChatChannels.ts',
  ])
  it('the settings surfaces have none left', () => {
    const settings = Object.keys(actual).filter((file) => !OTHER_DOMAINS.has(file)
      && /\/components\/(settings|usage|agentsettings|devices)\/|\/session\/renderer\/features\/settings\//.test(file))
    expect(settings).toEqual([])
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
