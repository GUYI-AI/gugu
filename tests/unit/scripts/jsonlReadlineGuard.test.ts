import { describe, expect, it } from 'vitest'
import { findReadlineJsonl, isProductionSource } from '../../../scripts/checks/check-jsonl-readline.mts'

describe('production JSONL readline gate', () => {
  it.each([
    "import {createInterface} from 'node:readline'; const r=createInterface({input}); r.on('line', line=>JSON.parse(line));",
    "import {createInterface as lines} from 'readline'; const r=lines({input}); r.once('line', raw=>{ const line=raw.trim(); JSON.parse(line) });",
    "import readline from 'node:readline'; const r=readline.createInterface({input}); r.addListener('line', x=>JSON.parse(x));",
    "import * as readline from 'node:readline'; for await(const line of readline.createInterface({input})) JSON.parse(line);",
    "const {createInterface:make}=require('readline'); const r=make({input}); for await(const raw of r){const line=raw.trim(); JSON.parse(line)}",
    "const rl=require('node:readline'); const r=rl.createInterface({input}); function parseJson(x){try{return JSON.parse(x)}catch{return null}}; for await(const line of r) parseJson(line);",
    "const r=require('node:readline').createInterface({input}); const parse = x=>JSON.parse(x); r.on('line',parse);",
  ])('rejects a JSON consumer (%s)', source => {
    expect(findReadlineJsonl(source)).toHaveLength(1)
  })
  it.each([
    "// readline example only\nconst record=JSON.parse(text);",
    "import {createInterface} from 'node:readline'; const r=createInterface({input}); r.on('line', line=>console.log(line)); const config=JSON.parse(configText);",
    "import readline from 'node:readline/promises'; const r=readline.createInterface({input}); const answer=await r.question('Name?');",
    "import {createJsonlReader} from '@gugu/core/local/jsonl.mjs'; const r=createJsonlReader({input}); r.on('line',line=>JSON.parse(line));",
  ])('allows ordinary text and LF readers (%s)', source => {
    expect(findReadlineJsonl(source)).toEqual([])
  })
  it('scans production paths while excluding test fixtures and declarations', () => {
    expect(['apps/mobile/runtime/agent.mjs', 'packages/core/src/local/reader.ts'].map(isProductionSource)).toEqual([true, true])
    expect(['tests/fixture.js', 'apps/x/reader.test.ts', 'packages/x/fixtures/a.js', 'packages/x/a.d.mts'].map(isProductionSource)).toEqual([false, false, false, false])
  })
})
