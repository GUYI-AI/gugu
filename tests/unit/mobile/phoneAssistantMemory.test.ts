import { describe, expect, it, vi } from 'vitest'

// #7199 手机助理那一层自己的几页:删一条记忆连同 MEMORY.md 索引、录音条失败那一句、健康读不到时分哪一种。
// 全用一台假的机器(内存里的文件),❌ 碰真数据。

vi.mock('@capacitor/core', () => ({ registerPlugin: () => ({}) }))

import { assistantPaths } from '../../../apps/desktop/src/session/renderer/features/assistant/assistant-files'
import type { AssistantMachine, MachineRpc } from '../../../apps/desktop/src/session/renderer/features/assistant/assistant-machine-core'
import { deleteMemoryNote } from '../../../apps/desktop/src/mobile/assistant/phoneMemoryData'
import { voiceFailureText } from '../../../apps/desktop/src/mobile/assistant/phoneVoiceNotesData'
import { readPhoneHealthView } from '../../../apps/desktop/src/mobile/assistant/phoneHealthView'
import type { NativeHealthStatus } from '../../../apps/desktop/src/mobile/phone-device/nativePhoneActions'
import type { HealthSummary } from '@gugu/core/shared/healthSummary'

// ── 一台假机器:路径 → 文件 / 文件夹,动词与 assistant-machine-core 用到的那几个同名同形 ─────────────────

type Node = { kind: 'dir' } | { kind: 'file'; content: string; binary?: boolean; size?: number }

const HOME = '/home/u'
const WORKDIR = '/home/u/assistant'

function fakeMachine(initial: Record<string, string | Node>) {
  const fs = new Map<string, Node>()
  const writes: string[] = []
  const put = (path: string, node: Node) => {
    fs.set(path, node)
    // 上面每一层都算文件夹(真机器上就是这样)。
    for (let at = path.lastIndexOf('/'); at > 0; at = path.lastIndexOf('/', at - 1)) {
      const dir = path.slice(0, at)
      if (!fs.has(dir)) fs.set(dir, { kind: 'dir' })
    }
  }
  for (const [path, value] of Object.entries(initial)) put(path, typeof value === 'string' ? { kind: 'file', content: value } : value)
  const children = (dir: string) =>
    [...fs.entries()]
      .filter(([path]) => path.slice(0, path.lastIndexOf('/')) === dir)
      .map(([path, node]) => ({
        path,
        name: path.slice(path.lastIndexOf('/') + 1),
        type: node.kind === 'dir' ? ('directory' as const) : ('file' as const),
        size: node.kind === 'file' ? node.size ?? node.content.length : 0,
        modifiedAt: new Date('2026-10-16T08:00:00Z'),
      }))
  const chunks = new Map<string, string>()
  const rpc = {
    files: {
      browseDirectory: async ({ path }: { path: string }) => {
        const node = fs.get(path)
        if (!node) return { success: false, error: { type: 'filesystem-error', path, message: `ENOENT: no such file or directory, scandir '${path}'` } }
        if (node.kind === 'file') return { success: false, error: { type: 'filesystem-error', path, message: `ENOTDIR: not a directory, scandir '${path}'` } }
        return { success: true, data: children(path) }
      },
    },
    workspace: {
      files: {
        readExternalFile: async (_project: string, _workspace: string, path: string, maxBytes: number) => {
          const node = fs.get(path)
          if (!node) return { success: false, error: { type: 'fs_error', message: `ENOENT: no such file or directory, open '${path}'` } }
          if (node.kind === 'dir') return { success: false, error: { type: 'fs_error', message: `EISDIR: ${path}` } }
          const totalSize = node.size ?? node.content.length
          if (totalSize > maxBytes) return { success: true, data: { content: '', truncated: true, totalSize } }
          if (node.binary) return { success: true, data: { content: '', binary: true, truncated: false, totalSize } }
          return { success: true, data: { content: node.content, truncated: false, totalSize } }
        },
        writeExternalFile: async (_project: string, _workspace: string, path: string, content: string) => {
          writes.push(path)
          put(path, { kind: 'file', content })
          return { success: true, data: {} }
        },
        removeFile: async (_project: string, _workspace: string, path: string, { recursive }: { recursive: boolean }) => {
          const node = fs.get(path)
          if (!node) return { success: true, data: { success: false, error: { type: 'not_found', message: 'ENOENT' } } }
          if (node.kind === 'dir' && !recursive) return { success: true, data: { success: false, error: { type: 'fs_error', message: 'EISDIR' } } }
          for (const key of [...fs.keys()]) if (key === path || key.startsWith(`${path}/`)) fs.delete(key)
          return { success: true, data: { success: true } }
        },
        createEntry: async (_project: string, _workspace: string, dir: string, name: string) => {
          const path = `${dir}/${name}`
          if (fs.has(path)) return { success: false, error: { type: 'exists' } }
          put(path, { kind: 'dir' })
          return { success: true, data: { path } }
        },
        writeChunk: async (_project: string, _workspace: string, chunk: { path: string; data: string; final: boolean }) => {
          const so_far = (chunks.get(chunk.path) ?? '') + Buffer.from(chunk.data, 'base64').toString('utf8')
          chunks.set(chunk.path, so_far)
          if (chunk.final) put(chunk.path, { kind: 'file', content: so_far })
          return { success: true, data: {} }
        },
      },
    },
  }
  const machine: AssistantMachine = {
    deviceId: 'cloud',
    rpc: rpc as unknown as MachineRpc,
    home: HOME,
    projectId: 'p1',
    workspaceId: 'w1',
    paths: assistantPaths(HOME, WORKDIR),
  }
  return { machine, fs, writes }
}

const paths = assistantPaths(HOME, WORKDIR)
const memory = (name: string) => `${paths.memoryDir}/${name}`

describe('deleteMemoryNote', () => {
  it('删掉那条记忆,并且只拿掉 MEMORY.md 里指向它的那一行', async () => {
    const index = ['# Memory', '- [咖啡](coffee.md) — 爱喝美式', '- [作息](sleep.md) — 晚睡'].join('\n')
    const { machine, fs } = fakeMachine({ [memory('coffee.md')]: 'x', [memory('sleep.md')]: 'y', [memory('MEMORY.md')]: index })
    await deleteMemoryNote(machine, { path: memory('coffee.md'), file: 'coffee.md' })
    expect(fs.has(memory('coffee.md'))).toBe(false)
    expect(fs.has(memory('sleep.md'))).toBe(true)
    const next = (fs.get(memory('MEMORY.md')) as { content: string }).content
    expect(next).not.toContain('coffee.md')
    expect(next).toContain('- [作息](sleep.md) — 晚睡')
  })

  it('索引里没有它 / 没有索引:不改写索引', async () => {
    const { machine, writes } = fakeMachine({ [memory('a.md')]: 'x', [memory('MEMORY.md')]: '- [B](b.md)' })
    await deleteMemoryNote(machine, { path: memory('a.md'), file: 'a.md' })
    expect(writes).toEqual([])
    const bare = fakeMachine({ [memory('a.md')]: 'x' })
    await deleteMemoryNote(bare.machine, { path: memory('a.md'), file: 'a.md' })
    expect(bare.writes).toEqual([])
    expect(bare.fs.has(memory('a.md'))).toBe(false)
  })

  it('文件没删成就抛出来(页面留在确认卡上说没删成),❌ 当作删掉了', async () => {
    const { machine } = fakeMachine({ [memory('MEMORY.md')]: '' })
    await expect(deleteMemoryNote(machine, { path: memory('gone.md'), file: 'gone.md' })).rejects.toThrow()
  })
})

describe('录音条失败那一句', () => {
  it('失败那一句:原话 > 原因码 > 读不懂 > 按环节', () => {
    const t = (key: string, values?: Record<string, string>) => (values?.name ? `${key}(${values.name})` : key)
    expect(voiceFailureText(t, { stage: 'transcribe', notice: '额度用完了', code: 'membership-required', message: '' }, '小咕')).toBe('额度用完了')
    expect(voiceFailureText(t, { stage: 'transcribe', notice: null, code: 'membership-required', message: '' }, '小咕')).toBe('failure.code.membership-required')
    expect(voiceFailureText(t, { stage: 'transcribe', notice: null, code: null, message: 'unreadable' }, '小咕')).toBe('failure.unreadable')
    expect(voiceFailureText(t, { stage: 'summarize', notice: null, code: 'weird', message: 'x' }, '小咕')).toBe('failure.summarize(小咕)')
  })
})

describe('readPhoneHealthView', () => {
  const status = (over: Partial<NativeHealthStatus> = {}): NativeHealthStatus => ({
    supported: true,
    granted_types: ['steps'],
    background_supported: true,
    background_granted: false,
    ...over,
  })
  const summary = { v: 1 } as unknown as HealthSummary
  const read = (over: Partial<Parameters<typeof readPhoneHealthView>[0]>) =>
    readPhoneHealthView({ platform: 'android', healthStatus: async () => status(), readSummary: async () => summary, ...over })

  it('读到了', async () => {
    await expect(read({})).resolves.toEqual({ state: 'ok', summary })
  })

  it('不在安卓 App 里:不去问原生(网页版没有),如实说', async () => {
    const healthStatus = vi.fn(async () => status())
    await expect(read({ platform: 'web', healthStatus })).resolves.toEqual({ state: 'not-android' })
    expect(healthStatus).not.toHaveBeenCalled()
  })

  it('咕咕太旧 / 没有 Health Connect / 一类没给,各说各的', async () => {
    await expect(read({ healthStatus: async () => Promise.reject(Object.assign(new Error('not implemented'), { code: 'UNIMPLEMENTED' })) })).resolves.toEqual({ state: 'old-app' })
    await expect(read({ healthStatus: async () => status({ supported: false, old_app: true }) })).resolves.toEqual({ state: 'old-app' })
    await expect(read({ healthStatus: async () => status({ supported: false }) })).resolves.toEqual({ state: 'unsupported' })
    await expect(read({ healthStatus: async () => status({ granted_types: [] }) })).resolves.toEqual({ state: 'not-granted' })
  })

  it('读的时候系统不让 / 别的失败:分开说,❌ 当成没有数据', async () => {
    await expect(read({ readSummary: async () => Promise.reject(Object.assign(new Error('denied'), { code: 'os_permission' })) })).resolves.toEqual({
      state: 'os-permission',
      message: 'denied',
    })
    await expect(read({ readSummary: async () => Promise.reject(new Error('boom')) })).resolves.toEqual({ state: 'failed', message: 'boom' })
    await expect(read({ healthStatus: async () => Promise.reject(new Error('binder died')) })).resolves.toEqual({ state: 'failed', message: 'binder died' })
  })
})
