import { appendFile, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTypingDiagnosticsFile } from '../../../../apps/desktop/electron/typing-diagnostics-file'
import { createBetaTypingDiagnosticsHandler, withTypingDiagnosticPolicy } from '../../../../apps/desktop/electron/beta-typing-diagnostics'
import { createRendererLogForwarder } from '../../../../apps/desktop/electron/local-renderer-diagnostics'
import { TYPING_DIAGNOSTICS_SCOPE } from '../../../../apps/desktop/shared/beta-typing-diagnostics'

const directories = new Set<string>()
const fresh = async () => { const path = await mkdtemp(join(tmpdir(), 'gugu-typing-diag-')); directories.add(path); return path }
afterEach(async () => { for (const path of directories) await rm(path, { recursive: true, force: true }); directories.clear() })
const sender = { id: 17, getOSProcessId: () => 1234 }

describe('local Beta typing sink', () => {
  it('uses real sender identity and a separate content-free file', async () => {
    const directory = await fresh()
    const regular = vi.fn()
    const handler = createBetaTypingDiagnosticsHandler({ enabled: true, directory: () => directory, mainWindowId: () => 17 })
    const forward = createRendererLogForwarder({ getMetrics: () => [], regular, typing: handler })
    expect(await forward(sender, { scope: TYPING_DIAGNOSTICS_SCOPE, fields: { operation: 'config' } }, false)).toMatchObject({ enabled: false })
    expect(await forward(sender, { scope: TYPING_DIAGNOSTICS_SCOPE, fields: { operation: 'config' } }, true)).toEqual({ enabled: true })
    expect(await forward(sender, { scope: TYPING_DIAGNOSTICS_SCOPE, fields: { operation: 'append', records: [{ event: 'long-task', durationMs: 75, rendererPid: 999, text: 'PRIVATE_CANARY' }] } }, true)).toMatchObject({ accepted: true, records: 1 })
    const data = await readFile(join(directory, 'typing-0.jsonl'), 'utf8')
    expect(JSON.parse(data)).toMatchObject({ event: 'long-task', durationMs: 75, rendererPid: 1234 })
    expect(data).not.toContain('PRIVATE_CANARY')
    expect(regular).not.toHaveBeenCalled()
  })

  it('disables production and non-main windows without creating directories or forwarding data', async () => {
    const file = vi.fn(), directory = vi.fn(() => '/unused')
    const off = createBetaTypingDiagnosticsHandler({ enabled: false, directory, mainWindowId: () => 17, file })
    const wrongWindow = createBetaTypingDiagnosticsHandler({ enabled: true, directory, mainWindowId: () => 18, file })
    for (const handler of [off, wrongWindow]) expect(await handler(sender, { operation: 'append', records: [{ event: 'start' }] })).toMatchObject({ enabled: false, accepted: false })
    const regular = vi.fn(), forward = createRendererLogForwarder({ getMetrics: () => [], regular })
    expect(await forward(sender, { scope: TYPING_DIAGNOSTICS_SCOPE, fields: { message: 'PRIVATE_CANARY' } })).toMatchObject({ enabled: false })
    expect(file).not.toHaveBeenCalled(); expect(directory).not.toHaveBeenCalled(); expect(regular).not.toHaveBeenCalled()
  })

  it('rotates UTF-8 lines across fixed slots within the total byte budget, including after restart', async () => {
    const directory = await fresh()
    let file = createTypingDiagnosticsFile(directory, { maxBytes: 600, files: 3 })
    await writeFile(join(directory, 'keep.txt'), 'unrelated')
    for (let index = 0; index < 50; index++) {
      expect(await file.append([{ index, functionName: '函数' }])).toMatchObject({ accepted: true })
      if (index === 25) file = createTypingDiagnosticsFile(directory, { maxBytes: 600, files: 3 })
    }
    const names = (await readdir(directory)).filter(name => name.endsWith('.jsonl'))
    expect(names).toHaveLength(3)
    const contents = await Promise.all(names.map(name => readFile(join(directory, name), 'utf8')))
    expect(contents.reduce((sum, data) => sum + Buffer.byteLength(data), 0)).toBeLessThanOrEqual(600)
    for (const data of contents) { expect(Buffer.byteLength(data)).toBeLessThanOrEqual(200); for (const line of data.trim().split('\n')) expect(() => JSON.parse(line)).not.toThrow() }
    expect((await readFile(join(directory, 'typing-0.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line)).at(-1).index).toBe(49)
    expect(await readFile(join(directory, 'keep.txt'), 'utf8')).toBe('unrelated')
  })

  it('does not concatenate fresh records to a crash-truncated JSON line', async () => {
    const directory = await fresh()
    const first = createTypingDiagnosticsFile(directory, { maxBytes: 600, files: 3 })
    await first.append([{ sequence: 1 }]); await appendFile(join(directory, 'typing-0.jsonl'), '{"partial":')
    const next = createTypingDiagnosticsFile(directory, { maxBytes: 600, files: 3 })
    await next.append([{ sequence: 2 }])
    expect(JSON.parse(await readFile(join(directory, 'typing-0.jsonl'), 'utf8'))).toEqual({ sequence: 2 })
    expect(await readFile(join(directory, 'typing-1.jsonl'), 'utf8')).toContain('partial')
  })

  it('bounds queued writes, rejects oversized lines and exposes storage failure without ordinary logs', async () => {
    const directory = await fresh(), file = createTypingDiagnosticsFile(directory)
    const results = await Promise.all(Array.from({ length: 20 }, (_, index) => file.append([{ index }])))
    expect(results.filter(result => !result.accepted && result.reason === 'busy')).toHaveLength(12)
    expect(await file.append([{ value: 'x'.repeat(64_000) }])).toEqual({ accepted: false, reason: 'oversize' })
    expect(await file.append([{ index: 21 }])).toMatchObject({ accepted: true })
    const blocked = join(directory, 'not-a-directory'); await writeFile(blocked, 'fixture')
    const bad = createBetaTypingDiagnosticsHandler({ enabled: true, directory: () => join(blocked, 'typing'), mainWindowId: () => 17 })
    expect(await bad(sender, { operation: 'append', records: [{ event: 'start' }] })).toEqual({ accepted: false, reason: 'storage' })
    expect(await bad(sender, { operation: 'config' })).toEqual({ enabled: false })
  })

  it('keeps the six-capture launch budget across page identities and reserves a full cooldown', async () => {
    let clock = 0
    const handler = createBetaTypingDiagnosticsHandler({ enabled: true, directory: () => '/unused', mainWindowId: () => 17, now: () => clock })
    for (let capture = 1; capture <= 6; capture++) {
      expect(await handler(sender, { operation: 'claim-profile' })).toEqual({ accepted: true, capture })
      expect(await handler({ ...sender }, { operation: 'claim-profile' })).toEqual({ accepted: false })
      clock += 329_999
      expect(await handler(sender, { operation: 'claim-profile' })).toEqual({ accepted: false })
      clock++
    }
    expect(await handler(sender, { operation: 'claim-profile' })).toEqual({ accepted: false })
    const off = createBetaTypingDiagnosticsHandler({ enabled: false, directory: () => '/unused', mainWindowId: () => 17 })
    expect(await off(sender, { operation: 'claim-profile' })).toMatchObject({ accepted: false })
  })

  it('grants document permission only to the enabled Beta entry, preserving other policy directives', () => {
    const response = new Response('app', { headers: { 'Document-Policy': 'force-load-at-top' } })
    expect(withTypingDiagnosticPolicy(response, 'gugu-app://app/index.html', true).headers.get('Document-Policy')).toBe('force-load-at-top, js-profiling')
    for (const url of ['gugu-app://app/assets/main.js', 'gugu-app://other/index.html', 'https://app/index.html']) expect(withTypingDiagnosticPolicy(response, url, true)).toBe(response)
    expect(withTypingDiagnosticPolicy(response, 'gugu-app://app/index.html', false)).toBe(response)
  })
})
