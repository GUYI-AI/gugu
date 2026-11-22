import { afterEach, beforeEach, vi } from 'vitest'
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { layOutScrollers } from './scrollerLayout'
import { installJsdomCanvasStub } from './jsdom-canvas-stub'

// 不在桌面壳里时,消息存储跑在 IndexedDB 上(lib/localMessageStore):每个用例一个空库,用例之间不串数据。
beforeEach(() => { globalThis.indexedDB = new IDBFactory() })
// fake-indexeddb 在 setImmediate 上排它的事务步骤(真 IndexedDB 不受计时器影响)。用例自己没列 toFake 时,
// 假计时器照默认全部伪造,但留下 setImmediate:否则存储的每一步都卡在没人推进的假时钟上。用例明确列了的照列。
const fakeTimers = vi.useFakeTimers.bind(vi)
const fakeable = ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance',
  'requestAnimationFrame', 'cancelAnimationFrame', 'requestIdleCallback', 'cancelIdleCallback'] as const
vi.useFakeTimers = (config?: Parameters<typeof vi.useFakeTimers>[0]) => fakeTimers({ ...config,
  toFake: config?.toFake ?? fakeable.filter(name => name in globalThis) })

// 真 lottie 播放器不进单测进程 —— 它模块顶层那条轮询关不掉,会活过 jsdom 拆除再把无关的 job 判红。
// 机制、为什么两份 setup 都要装、为什么这个名字必须在 vitest 别名表里定死:见替身模块的抬头。
// ⚠️ 出口在**用例自己的文件**里 `vi.unmock`(目前两条:LoadingIndicator / FullScreenLoader)——
//    它们的判据正是「动画真的画出来了」,对着替身断言等于把它们测的那件事取消掉。
vi.mock('lottie-web/build/player/lottie_light', async () => ({
  default: (await import('./lottie-player-stub')).lottiePlayerStub,
}))

// agent 头像的动效运行时同理不进单测进程:它的 rAF 循环在 jsdom 的残缺画布上会抛未捕获异常。机制见替身模块抬头。
vi.mock('../../apps/desktop/src/components/agentAvatar/engine/runtime', async () => ({
  runtime: (await import('./agent-avatar-runtime-stub')).agentAvatarRuntimeStub,
}))

// 这个 setup 同时服务两种环境:`gugu` project 的默认环境是 node(实测 463 个文件里 72% 从不碰 DOM,
// 而每个 jsdom 文件要多付 ~335ms 的建环境开销),只有第一行写了 `// @vitest-environment jsdom`
// 的文件才拿到 window。
// 下面这段是**给 jsdom 补浏览器缺口**用的,node 下没有 window 可补,必须跳过 ——
// ❌ 别删这个判断:node 环境下顶层访问 window 会在 setup 阶段抛 ReferenceError,
// 那不是某个用例红,是整个 project 起不来。
if (typeof window !== 'undefined') {
  // jsdom omits ResizeObserver; ChatAreaPanel's open-at-bottom re-pin observer (#781) uses it.
  // Provide a no-op so component mount tests don't throw. Real Chromium always has it.
  class ResizeObserverMock {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  globalThis.ResizeObserver = ResizeObserverMock as unknown as typeof ResizeObserver
  // Agent conversations now mount the shared transcript in the IM shell as well.
  // jsdom has no font loading; browser geometry is tested in Chromium.
  Object.defineProperty(document, 'fonts', { configurable: true, value: { load: async () => [], ready: Promise.resolve() } })

  // Shared rich-text composers use native caret geometry and popup scrolling. jsdom has no layout.
  Element.prototype.scrollIntoView = () => {}
  Range.prototype.getBoundingClientRect = () => new DOMRect(0, 0, 0, 20)
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList
  document.elementFromPoint = () => null
  // A growing list that scrolls itself mounts the lines that fit (@@@growing-list): give its scroller a window's size.
  layOutScrollers('[data-growing-list]')

  const storage = new Map<string, string>()

  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      get length() {
        return storage.size
      },
      key(index: number) {
        return Array.from(storage.keys())[index] ?? null
      },
      getItem(key: string) {
        return storage.get(key) ?? null
      },
      setItem(key: string, value: string) {
        storage.set(key, value)
      },
      removeItem(key: string) {
        storage.delete(key)
      },
      clear() {
        storage.clear()
      },
    },
  })

  // canvas 的 2D 上下文缺口 —— 说明与「为什么必须每个 project 都装」见该模块抬头。
  installJsdomCanvasStub()
}

beforeEach(async () => {
  const { applyLocalePreference } = await import('../../apps/desktop/src/i18n/runtime')
  await import('../../apps/desktop/src/i18n/registerMainCatalog')
  await import('../../apps/desktop/src/i18n/registerSettingsCatalog')
  await import('../../apps/desktop/src/i18n/registerMessagingCatalog')
  await import('../../apps/desktop/src/i18n/registerContactsCatalog')
  await import('../../apps/desktop/src/i18n/registerAgentsCatalog')
  applyLocalePreference('zh-CN', false)
})

// @@@outbox — the window's one outbox (lib/outbox `outbox()`) is IndexedDB in the product; jsdom has none. Each test gets a
// fresh one over memory, for the account the replica follows (renderWithAppProviders signs in through it). Imported here,
// inside the hook, so a test file's own vi.mock of these modules applies. A test may install its own instead.
let testOutbox: { dispose(): void } | undefined
beforeEach(async () => {
  if (typeof window === 'undefined') return
  const [core, replica] = await Promise.all([import('../../apps/desktop/src/lib/outbox/core'), import('../../apps/desktop/src/lib/replica')])
  // A file that mocks the replica (or the core) away has no outbox to install; a vi.mock throws on a missing export.
  const exported = (module: object, name: string) => { try { return typeof (module as Record<string, unknown>)[name] === 'function' } catch { return false } }
  if (!exported(core, 'createOutbox') || !exported(replica, 'onAccountChange') || !exported(replica, 'replicaAccount')) return
  const { createOutbox } = core, { onAccountChange, replicaAccount } = replica
  const rows = new Map<string, unknown>()
  const box = createOutbox({
    storage: {
      list: async (accountId) => [...rows.entries()].filter(([key]) => key.startsWith(`${accountId}/`)).map(([, row]) => structuredClone(row)) as never,
      write: async (accountId, puts, removes) => {
        for (const item of puts) rows.set(`${accountId}/${item.id}`, structuredClone(item))
        for (const id of removes) rows.delete(`${accountId}/${id}`)
      },
    },
    account: { current: () => replicaAccount().id, onChange: onAccountChange, credential: () => replicaAccount().id },
    online: () => () => {},
  })
  testOutbox = box
  ;(globalThis as Record<string, unknown>).__GUGU_OUTBOX__ = box
})
afterEach(() => {
  testOutbox?.dispose()
  if ((globalThis as Record<string, unknown>).__GUGU_OUTBOX__ === testOutbox) delete (globalThis as Record<string, unknown>).__GUGU_OUTBOX__
  testOutbox = undefined
})
