import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createRoot, type Root } from 'react-dom/client'
import { useState } from 'react'
import { ComposerModelMenu } from '@gugu/session-ui/react/components'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import type { AgentPayload } from '@shared/core/agents/agent-payload'
import type { HarnessConnection } from '@gugu/session-core/workspace-server/agent-config'
import { AgentDetailModal } from '@renderer/features/settings/agents-page/AgentDetailModal'
import { useConnectionPanel } from '@renderer/features/settings/subscriptions/use-connection-panel'
import { subscriptionKey } from '@renderer/features/settings/subscriptions/subscription-queries'
import { SessionLocalizationProvider } from '@renderer/localization/localization-provider'
import { setLocalePreference } from '@/i18n'
import { modalStore } from '@renderer/lib/modal/modal-store'
import { ModalRenderer } from '@renderer/lib/modal/modal-renderer'
import { until, untilStable } from '../../../../../../../tests/support/awaitCondition'
import { runInAction } from 'mobx'
import { remoteHostsStore } from '@renderer/features/remote-hosts/remote-hosts-store'
import '@/styles/tokens.css'
import '@renderer/index.css'

const control = vi.hoisted(() => ({
  state: 'unauthenticated',
  /** 「现有 CLI 配置」那一份的登录读数(按连接问);缺席时与 `state` 一样。 */
  nativeState: null as string | null,
  payer: 'not-signed-in',
  hold: null as Promise<void> | null,
  connections: [] as HarnessConnection[],
  created: null as Record<string, unknown> | null,
  /** 宿主读 `{地址}/models` 的答复;缺席时答「这个地址不报清单」(表单退回手填)。 */
  modelList: null as { kind: 'listed'; models: string[] } | null,
  modelReads: [] as Record<string, unknown>[],
  updatedModels: null as Record<string, unknown> | null,
  selected: '',
  rejectSelect: false,
  busy: false,
  removed: [] as Array<{ connectionId: string; stopBusySessions?: boolean }>
}))

const NAMES: Record<string, string> = { codex: 'Codex', claude: 'Claude', pi: 'Pi', opencode: 'OpenCode', amp: 'Amp' }

function agent(id: string): AgentPayload {
  // #2507:Pi 只能接 API Key;OpenCode 能登它 CLI 自己那一份,也能接 API Key;Amp 两样都没有。
  const login = id === 'pi' || id === 'amp'
    ? { kind: 'none' }
    : { kind: 'supported', methods: [{ kind: 'cli-login', id: `${id}-login`, name: id, args: ['login'] }] }
  // Pi 的声明照它真的那份(#2507 第 6 轮):官方地址预填、模型从地址读、接口由宿主按地址探。
  const apiKeyConnection = id === 'pi'
    ? {
        kind: 'supported',
        delivery: 'model-injection',
        endpoint: 'required',
        officialEndpoint: 'https://api.openai.com/v1',
        model: 'required',
        protocol: 'openai-responses',
        protocols: ['openai-responses', 'openai-chat-completions'],
        evidence: 'test'
      }
    : id === 'opencode'
      ? { kind: 'supported', endpoint: 'none', model: 'none', evidence: 'test' }
      : { kind: 'none' }
  return {
    id,
    name: NAMES[id] ?? id,
    status: 'available',
    reading: 'installed',
    command: id,
    installOptions: [],
    capabilities: {
      hostDependency: { updates: { kind: 'none' }, uninstall: { kind: 'none' } },
      hooks: { kind: 'none' },
      sessions: { kind: 'stateless' },
      auth: login,
      apiKeyConnection
    }
  } as unknown as AgentPayload
}

// Only the host boundary answers fixtures. The detail, menu, nested form and all
// Base UI portals are real components, with the product styles and localization.
vi.mock('@renderer/lib/ipc', async (original) => {
  const actual = await original<typeof import('@renderer/lib/ipc')>()
  const pending = () => new Promise(() => {})
  const agents = {
    getManagement: async (id: string) => agent(id),
    list: async () => [agent('claude'), agent('codex')],
    listIcons: async () => ({}),
    listAgentInstallationStatus: async () => [],
    getSettings: async () => null,
    modelCatalog: async () => ({ state: { kind: 'ready', models: [] }, refreshing: false })
  }
  return {
    ...actual,
    rpcOn: () => ({ agents }),
    onMachineEvent: () => () => {},
    events: { on: () => () => {} },
    rpc: new Proxy(
      {},
      { get: (_, key) => (key === 'agents' ? agents : new Proxy({}, { get: () => pending })) }
    )
  }
})

vi.mock('@renderer/lib/agent-config/runtime-client', () => ({
  getAgentConfigRuntimeClient: async () => ({
    refreshAuthStatus: async ({ connectionId }: { connectionId?: string }) => {
      if (!connectionId && control.hold) await control.hold
      return {
        success: true,
        data: { kind: connectionId === 'native' ? (control.nativeState ?? control.state) : control.state }
      }
    },
    listConnections: async () => ({ success: true, data: [...control.connections] }),
    readSubscription: async () => {
      if (control.hold) await control.hold
      return { success: true, data: { payer: control.payer } }
    },
    readSubscriptionUsage: async () => ({
      success: true,
      data: { kind: 'unavailable', reason: 'not-signed-in' }
    }),
    listConnectionModels: async (input: Record<string, unknown>) => {
      control.modelReads.push(input)
      return { success: true, data: control.modelList ?? { kind: 'unlisted', reason: 'no-list' } }
    },
    updateConnectionModels: async (input: { connectionId: string; models: string[] }) => {
      control.updatedModels = input
      control.connections = control.connections.map((c) => (c.id === input.connectionId ? { ...c, models: input.models } : c))
      return { success: true, data: control.connections.find((c) => c.id === input.connectionId)! }
    },
    createConnection: async (input: Record<string, unknown>) => {
      control.created = input
      const created: HarnessConnection = {
        id: 'api',
        kind: 'api-key',
        name: 'Saved API',
        ...(Array.isArray(input.models) ? { models: input.models as string[] } : {}),
        current: false
      }
      control.connections.push(created)
      return { success: true, data: created }
    },
    // 宿主那一层的规矩(host.connections.db.test.ts 实跑):删当前连接 = 切回原生,有会话在忙先拒,带「关掉」才删。
    removeConnection: async (input: { providerId: string; connectionId: string; stopBusySessions?: boolean }) => {
      control.removed.push({ connectionId: input.connectionId, ...(input.stopBusySessions ? { stopBusySessions: true } : {}) })
      const target = control.connections.find((c) => c.id === input.connectionId)
      if (target?.current && control.busy && !input.stopBusySessions) {
        return {
          success: false,
          error: { type: 'invalid-state', message: 'busy', sessionsBusy: { providerId: input.providerId, count: 1 } }
        }
      }
      control.connections = control.connections
        .filter((c) => c.id !== input.connectionId)
        .map((c) => (target?.current ? { ...c, current: c.id === 'native' } : c))
      return { success: true }
    },
    selectConnection: async ({ connectionId, stopBusySessions }: { connectionId: string; stopBusySessions?: boolean }) => {
      // 「关掉并切换」= 正在工作的也关掉:宿主不再以「在忙」拒。
      if (control.rejectSelect && !(control.busy && stopBusySessions)) {
        control.selected = 'rejected'
        return {
          success: false,
          error: {
            type: 'invalid-state',
            message: 'Connection could not switch',
            ...(control.busy ? { sessionsBusy: { providerId: 'codex', count: 2 } } : {})
          }
        }
      }
      control.selected = connectionId
      control.state = 'authenticated'
      control.connections = control.connections.map((c) => ({
        ...c,
        current: c.id === connectionId
      }))
      return { success: true }
    }
  })
}))

// 登录态那份 live store 走另一条宿主通道;这里只要它不答(状态那一行由套餐读数说)。
vi.mock('@renderer/lib/stores/use-agent-auth-status', () => ({
  useAgentAuthStatus: () => ({ auth: null, refresh: async () => {} }),
  useAgentAuthStatuses: (_: string, programs: unknown[]) => ({ auths: programs.map(() => null), refresh: async () => {} }),
  useExpiredAgentIds: () => new Set()
}))

vi.mock('@renderer/lib/acp/auth-login-binding', () => ({
  AcpAuthLoginBinding: {
    create: async () => ({
      sendInput: () => {},
      resize: () => {},
      markUrlHandled: () => {},
      dispose: () => {},
      status: { current: () => ({ status: { kind: 'unauthenticated' }, login: null }) }
    })
  }
}))

let root: Root
let host: HTMLDivElement
let client: QueryClient
beforeEach(() => {
  setLocalePreference('en-US')
  control.state = 'unauthenticated'
  control.nativeState = null
  control.payer = 'not-signed-in'
  control.hold = null
  control.created = null
  control.modelList = null
  control.modelReads = []
  control.updatedModels = null
  control.selected = ''
  control.rejectSelect = false
  control.busy = false
  control.removed = []
  control.connections = [{ id: 'native', kind: 'native', name: 'CLI', current: true }]
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  host = document.createElement('div')
  host.className = 'gugu-skin emlight'
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  modalStore.closeModal()
  root.unmount()
  client.clear()
  host.remove()
})

function render(node: React.ReactNode) {
  root.render(
    <QueryClientProvider client={client}>
      <SessionLocalizationProvider>{node}</SessionLocalizationProvider>
    </QueryClientProvider>
  )
}

const box = (element: Element) => {
  const { x, y, width, height } = element.getBoundingClientRect()
  return { x, y, width, height }
}

it.each([1440, 390])(
  'connection fields remain accessible above the detail at %ipx',
  async (width) => {
    await page.viewport(width, 900)
    render(<AgentDetailModal agentId="codex" onClose={vi.fn()} />)
    await userEvent.click(page.getByRole('button', { name: 'Add', exact: true }))
    const dialog = page.getByRole('dialog', { name: 'Codex', exact: true })
    await expect.element(dialog).toBeVisible()
    await expect
      .element(page.getByRole('tab', { name: 'Account sign-in', exact: true }))
      .toBeVisible()
    await userEvent.click(page.getByRole('tab', { name: 'API Key', exact: true }))
    await expect.element(page.getByLabelText('API Key', { exact: true })).toBeVisible()
    // 地址 + Key 是主体:地址一直摆着,一开始就是官方地址;❌「使用第三方 API」勾选。
    expect(document.querySelector('.subscription-connection-form input[type="checkbox"]')).toBeNull()
    await expect
      .element(page.getByRole('textbox', { name: 'API address', exact: true }))
      .toHaveValue('https://api.openai.com/v1')
    await expect
      .element(page.getByRole('button', { name: 'Save connection', exact: true }))
      .toBeVisible()
    const form = document.querySelector('.subscription-connection-form')!
    expect(form.closest('[aria-hidden="true"], [inert]')).toBeNull()
    expect(form.closest('[role="dialog"]')?.parentElement?.closest('[role="dialog"]')).toBeNull()
  }
)

// 「现有 CLI 配置」登上了才列(owner 2026-11-12);列着的时候，后台重读(登录、套餐)不许让详情跳。
it.each([1440, 390])(
  'detail keeps cached connection controls during background checks at %ipx',
  async (width) => {
    await page.viewport(width, 900)
    control.state = 'authenticated'
    control.payer = 'subscription'
    for (const id of ['codex', 'claude']) {
      render(<AgentDetailModal key={id} agentId={id} onClose={vi.fn()} />)
      const detail = page.getByRole('dialog', {
        name: id === 'codex' ? 'Codex' : 'Claude',
        exact: true
      })
      const connection = detail.getByRole('combobox', { name: 'Current connection', exact: true })
      await expect.element(connection).toBeEnabled()
      await until('the first readings settle', () => client.isFetching({ queryKey: subscriptionKey(null, id) }) === 0)
      for (const advanced of [false, true]) {
        if (advanced)
          await userEvent.click(page.getByRole('button', { name: 'Advanced', exact: true }))
        await untilStable('detail animation settled', () => box(detail.element()))
        const initial = box(detail.element())
        const connectionBox = box(connection.element())
        let finish!: () => void
        control.hold = new Promise<void>((resolve) => {
          finish = resolve
        })
        const pending = client.invalidateQueries({ queryKey: subscriptionKey(null, id) })
        await until(
          'background readings start',
          () => client.isFetching({ queryKey: subscriptionKey(null, id) }) > 0
        )
        await expect.element(connection).toBeEnabled()
        expect(connection.element().textContent).toContain('Existing CLI configuration')
        expect(box(detail.element())).toEqual(initial)
        expect(box(connection.element())).toEqual(connectionBox)
        finish()
        await pending
        control.hold = null
        // 状态那一行换了说法(谁在付钱):字数不同、窄屏可能多折一行,当前连接那一格不缩、不挪到别的列、一直能点。
        for (const payer of ['api-key', 'unknown', 'subscription']) {
          control.payer = payer
          await client.invalidateQueries({ queryKey: [...subscriptionKey(null, id), 'plan'] })
          await untilStable('payer layout settled', () => box(detail.element()))
          const { x, width } = box(connection.element())
          expect({ x, width }).toEqual({ x: connectionBox.x, width: connectionBox.width })
          expect(box(detail.element()).width).toBe(initial.width)
          await expect.element(connection).toBeEnabled()
        }
      }
    }
  }
)

function TaskDraft({ id = 'codex', machine = null }: { id?: string; machine?: string | null }) {
  const [prompt, setPrompt] = useState('Original draft')
  const panel = useConnectionPanel()
  return (
    <>
      <input aria-label="Task draft" value={prompt} onChange={(e) => setPrompt(e.target.value)} />
      <ComposerModelMenu
        panel={{ kind: 'shown', modelRow: 'list' }}
        modelItems={[]}
        effortItems={[]}
        modelUnlock={{ groupLabel: `Your ${NAMES[id]} models`, label: 'Go sign in' }}
        onModelUnlock={(anchor) => panel.show(agent(id), machine, anchor)}
      />
      {panel.panel}
    </>
  )
}

it('a task overlays the same connection form and returns to its draft after API selection', async () => {
  // 「现有 CLI 配置」登上了 ⇒ 列着它,面板是那份菜单。
  control.nativeState = 'authenticated'
  render(<TaskDraft />)
  const href = location.href
  await userEvent.fill(page.getByRole('textbox', { name: 'Task draft' }), 'Keep this draft')
  await userEvent.click(page.getByTestId('composer-model-trigger'))
  await userEvent.click(page.getByRole('button', { name: 'Go sign in', exact: true }))
  // 「Go sign in」 leaves with the model list; the connection menu sits at the model trigger that stays, not at a
  // detached element (the corner) and not closed.
  await until('the connection menu sits at the model trigger', () => {
    const menu = document.querySelector('.subscription-connection-menu')?.getBoundingClientRect()
    const trigger = document.querySelector('[data-testid="composer-model-trigger"]')?.getBoundingClientRect()
    return !!menu && !!trigger && menu.width > 0 && Math.min(Math.abs(menu.top - trigger.bottom), Math.abs(trigger.top - menu.bottom)) < 40
  })
  await until('the existing CLI configuration is listed', () => !!document.querySelector('[data-testid="connection-native"]'))
  await userEvent.click(page.getByRole('menuitem', { name: 'Add connection', exact: true }))
  await userEvent.click(page.getByRole('tab', { name: 'API Key', exact: true }))
  await userEvent.fill(page.getByLabelText('API Key', { exact: true }), 'fixture-key')
  await userEvent.click(page.getByRole('button', { name: 'Save connection', exact: true }))
  await until(
    'saved API is selectable',
    () => !!document.querySelector('[data-testid="connection-use-api"]')
  )
  await userEvent.click(page.getByTestId('connection-use-api'))
  await until('the selected connection is committed', () => control.selected === 'api')
  await expect
    .element(page.getByRole('textbox', { name: 'Task draft' }))
    .toHaveValue('Keep this draft')
  expect(location.href).toBe(href)
  expect(control.created).toMatchObject({ providerId: 'codex', apiKey: 'fixture-key' })
})

// owner 2026-11-12:「我其实这个 pi 也没配置过，但是你却让我选它的配置……应该是添加连接呀」——
// 一个连接都没有时「去登录」直接是「添加连接」表单,❌ 先弹一个只有空占位的菜单;存好之后回到原草稿。
it.each(['codex', 'pi'])('with nothing configured, %s Go sign in opens Add connection directly and keeps the draft', async (id) => {
  render(<TaskDraft id={id} />)
  const href = location.href
  await userEvent.fill(page.getByRole('textbox', { name: 'Task draft' }), 'Keep this draft')
  await userEvent.click(page.getByTestId('composer-model-trigger'))
  await userEvent.click(page.getByRole('button', { name: 'Go sign in', exact: true }))
  const dialog = page.getByRole('dialog', { name: `Add a ${NAMES[id]} connection`, exact: true })
  await expect.element(dialog).toBeVisible()
  expect(document.querySelector('[data-testid="connection-native"]')).toBeNull()
  const methods = [...document.querySelectorAll('.subscription-connection-form [role="tab"]')].map((b) => b.textContent)
  // 只有一种方式(Pi)不画分段,直接是那一种表单。
  expect(methods).toEqual(id === 'pi' ? [] : ['Account sign-in', 'API Key'])
  if (id !== 'pi') await userEvent.click(page.getByRole('tab', { name: 'API Key', exact: true }))
  await userEvent.fill(page.getByLabelText('API Key', { exact: true }), 'fixture-key')
  if (id === 'pi') {
    await userEvent.fill(page.getByRole('textbox', { name: 'API address', exact: true }), 'https://gateway.example/v1')
    await userEvent.fill(page.getByRole('textbox', { name: 'Models', exact: true }), 'fixture-model')
  }
  await userEvent.click(page.getByRole('button', { name: 'Save connection', exact: true }))
  // 当前是「没有」:存好的这一把直接成为当前连接(走切换那条路),❌ 再让人去菜单里选一次。
  await until('the saved key becomes the current connection', () => control.selected === 'api')
  expect(document.querySelector('[data-testid="connection-native"]')).toBeNull()
  await expect.element(page.getByRole('textbox', { name: 'Task draft' })).toHaveValue('Keep this draft')
  expect(location.href).toBe(href)
  expect(control.created).toMatchObject({ providerId: id, kind: 'api-key', apiKey: 'fixture-key' })
})

// 面板(新建任务、会话里打开的那份)同一条:第一把 key 被「在忙」拒了,菜单打开,里面同一句、同一个「关掉并切换」。
it('a task panel shows the busy refusal of its first key with Close and switch', async () => {
  control.rejectSelect = true
  control.busy = true
  render(<TaskDraft />)
  await userEvent.click(page.getByTestId('composer-model-trigger'))
  await userEvent.click(page.getByRole('button', { name: 'Go sign in', exact: true }))
  await expect.element(page.getByRole('dialog', { name: 'Add a Codex connection', exact: true })).toBeVisible()
  await userEvent.click(page.getByRole('tab', { name: 'API Key', exact: true }))
  await userEvent.fill(page.getByLabelText('API Key', { exact: true }), 'fixture-key')
  await userEvent.click(page.getByRole('button', { name: 'Save connection', exact: true }))
  await until('the menu carries the refusal and its way out', () =>
    !!document.querySelector('.subscription-connection-menu [data-testid="subscription-close-and-switch"]'))
  expect(document.querySelector('.subscription-connection-menu [role="status"]')?.textContent).toContain('2 Codex sessions')
  expect(control.connections.find((c) => c.current)?.id).toBe('native')
  await userEvent.click(page.getByTestId('subscription-close-and-switch'))
  await until('the key becomes current', () => control.selected === 'api')
})

it('a rejected task connection remains visible with its cause and keeps the original draft and connection', async () => {
  control.nativeState = 'authenticated'
  control.rejectSelect = true
  control.connections.push({ id: 'api', kind: 'api-key', name: 'Saved API', current: false })
  render(<TaskDraft />)
  await userEvent.click(page.getByTestId('composer-model-trigger'))
  await userEvent.click(page.getByRole('button', { name: 'Go sign in', exact: true }))
  await userEvent.click(page.getByTestId('connection-use-api'))
  await until('the host refused the switch', () => control.selected === 'rejected')
  await until(
    'the refusal is shown',
    () =>
      document
        .querySelector('.subscription-connection-menu [role="alert"]')
        ?.textContent?.includes('Connection could not switch') === true
  )
  // The refusal stays where it was asked: the menu is still open, not exit-animating with the notice inside it.
  expect(document.querySelector('.subscription-connection-menu')?.hasAttribute('data-open')).toBe(
    true
  )
  expect(control.connections.find((c) => c.current)?.id).toBe('native')
  expect((host.querySelector('input') as HTMLInputElement).value).toBe('Original draft')
})

it.each([1440, 1024, 800, 390])(
  'an unsigned saved account keeps its real login action while an unsigned native is not listed at %ipx',
  async (width) => {
    await page.viewport(width, 900)
    control.connections.push({
      id: 'saved-account',
      kind: 'account',
      name: 'Saved account',
      current: false
    })
    render(<AgentDetailModal agentId="codex" onClose={vi.fn()} />)
    const detail = page.getByRole('dialog', { name: 'Codex', exact: true })
    const configure = detail.getByRole('combobox', { name: 'Current connection', exact: true })
    await expect.element(configure).toBeVisible()
    await untilStable('the complete detail content settles', () => box(detail.element()))
    const bounds = detail.element().getBoundingClientRect()
    const buttonBounds = configure.element().getBoundingClientRect()
    expect(buttonBounds.top).toBeGreaterThanOrEqual(bounds.top)
    expect(buttonBounds.bottom).toBeLessThanOrEqual(bounds.bottom)
    await userEvent.click(page.getByRole('combobox', { name: 'Current connection', exact: true }))
    await until(
      'the saved account is listed',
      () => !!document.querySelector('[data-testid="connection-saved-account"]')
    )
    // 「现有 CLI 配置」没登上就不列(owner 2026-11-12),更谈不上在它身上登录。
    expect(document.querySelector('[data-testid="connection-native"]')).toBeNull()
    await userEvent.click(
      page.getByRole('button', { name: 'Options for Saved account', exact: true })
    )
    const signIn = page.getByRole('menuitem', { name: 'Sign in', exact: true })
    await expect.element(signIn).toBeVisible()
    const item = signIn.element()
    await untilStable('the sign-in item settles', () => box(item))
    const rect = item.getBoundingClientRect()
    expect(
      item.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2))
    ).toBe(true)
    await userEvent.click(page.getByRole('menuitem', { name: 'Sign in', exact: true }))
    expect(modalStore.activeModalId).toBe('agentSignInModal')
    expect(modalStore.activeModalArgs).toMatchObject({
      providerId: 'codex',
      connectionId: 'saved-account',
      steps: [{ methodId: 'codex-login' }]
    })
    expect(modalStore.activeModalArgs).not.toHaveProperty('portalContainer')
  }
)

it('working sessions refuse a task connection switch with a calm status and keep the native connection', async () => {
  control.nativeState = 'authenticated'
  control.rejectSelect = true
  control.busy = true
  control.connections.push({ id: 'api', kind: 'api-key', name: 'Saved API', current: false })
  render(<TaskDraft />)
  await userEvent.click(page.getByTestId('composer-model-trigger'))
  await userEvent.click(page.getByRole('button', { name: 'Go sign in', exact: true }))
  await userEvent.click(page.getByTestId('connection-use-api'))
  await until(
    'the busy refusal is rendered',
    () =>
      document
        .querySelector('.subscription-connection-menu [role="status"]')
        ?.textContent?.includes('2 Codex sessions') === true
  )
  expect(document.querySelector('.subscription-connection-menu')?.hasAttribute('data-open')).toBe(
    true
  )
  expect(document.querySelector('[role="alert"]')).toBeNull()
  expect(document.querySelector('[role="status"]')?.classList.contains('subscription-error')).toBe(
    false
  )
  expect(control.connections.find((c) => c.current)?.id).toBe('native')
})

it.each([800, 1440])(
  'the real global sign-in terminal remains accessible and clickable above the detail at %ipx',
  async (width) => {
    await page.viewport(width, 900)
    control.connections.push({
      id: 'saved-account',
      kind: 'account',
      name: 'Saved account',
      current: false
    })
    render(
      <>
        <AgentDetailModal agentId="codex" onClose={vi.fn()} />
        <ModalRenderer />
      </>
    )
    await userEvent.click(page.getByRole('combobox', { name: 'Current connection', exact: true }))
    await userEvent.click(
      page.getByRole('button', { name: 'Options for Saved account', exact: true })
    )
    await userEvent.click(page.getByRole('menuitem', { name: 'Sign in', exact: true }))
    const login = page.getByRole('dialog', { name: 'Sign in to Codex', exact: true })
    await expect.element(login).toBeVisible()
    const dialog = login.element()
    expect(dialog.closest('[aria-hidden="true"], [inert]')).toBeNull()
    const cancel = login.getByRole('button', { name: 'Cancel sign-in', exact: true })
    await untilStable('the actual sign-in footer settles', () => box(cancel.element()))
    const rect = cancel.element().getBoundingClientRect()
    expect(
      document
        .elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
        ?.closest('button')
    ).toBe(cancel.element())
    await userEvent.click(cancel)
    await until('the real login has closed', () => !modalStore.isOpen)
    await expect.element(page.getByRole('dialog', { name: 'Codex', exact: true })).toBeVisible()
  }
)

// #2507 owner 2026-11-12:「pi 还是没地方登录或者用 apikey」「你非得每个都不一样干嘛」——每一家的详情都是同一块
// 「连接」:当前连接 + 添加连接,方式按这家支持的给。
const methodButtons = () =>
  [...document.querySelectorAll('.subscription-connection-form [role="tab"]')].map((b) => b.textContent)
const addRowHint = (id: string) =>
  document.querySelector(`[data-testid="subscription-add-${id}"]`)?.closest('.gg-settings-row')?.querySelector('.gg-settings-row-description')?.textContent

it('Pi detail has the Connections section: with nothing configured it says None and adds an API key there', async () => {
  control.connections = [{ id: 'native', kind: 'native', name: '', current: true }]
  render(<AgentDetailModal agentId="pi" onClose={vi.fn()} />)
  const detail = page.getByRole('dialog', { name: 'Pi', exact: true })
  await expect.element(detail.getByText('Connections', { exact: true })).toBeVisible()
  await until('Pi reads no connection', () => !!document.querySelector('[data-testid="subscription-no-connection-pi"]'))
  expect(document.querySelector('[data-testid="subscription-no-connection-pi"]')?.textContent).toBe('None')
  expect(detail.getByRole('combobox', { name: 'Current connection', exact: true }).query()).toBeNull()
  expect(detail.element().textContent).not.toContain('Existing CLI configuration')
  // The status line reads its payer after the list (it says "Checking…" until then).
  await until('the status line reads its payer', () => document.querySelector('[data-testid="connection-status-pi"]')?.textContent, (text) => text === 'Not signed in')
  expect(addRowHint('pi')).toBe('API Key')
  await userEvent.click(detail.getByRole('button', { name: 'Add', exact: true }))
  // 只有一种方式:不画分段,直接是 API Key 表单;展开期间「添加」收起,收回去靠表单里的「取消」。
  expect(methodButtons()).toEqual([])
  expect(document.querySelector('[data-testid="subscription-add-pi"]')).toBeNull()
  await userEvent.fill(page.getByLabelText('API Key', { exact: true }), 'fixture-key')
  await userEvent.fill(page.getByRole('textbox', { name: 'API address', exact: true }), 'https://gateway.example/v1')
  await userEvent.fill(page.getByRole('textbox', { name: 'Models', exact: true }), 'fixture-model')
  await userEvent.click(page.getByRole('button', { name: 'Save connection', exact: true }))
  await until('the key is saved', () => control.created !== null)
  expect(control.created).toMatchObject({ providerId: 'pi', kind: 'api-key', apiKey: 'fixture-key', endpoint: 'https://gateway.example/v1', models: ['fixture-model'] })
  // 当前是「没有」:加上的第一把直接成为当前连接,选择框写它。
  await until('the new key is the current connection', () => control.selected === 'api')
  const connection = detail.getByRole('combobox', { name: 'Current connection', exact: true })
  await expect.element(connection).toBeEnabled()
  await until('the select names the new key', () => connection.query()?.textContent?.includes('Saved API') === true)
  expect(document.querySelector('[data-testid="subscription-add-pi"]')).not.toBeNull()
})

// 已经有当前真连接时再加一把:不自动切,保持原来的选择。
it('adding a key while another key is current keeps the current one', async () => {
  control.connections = [
    { id: 'native', kind: 'native', name: '', current: false },
    { id: 'key', kind: 'api-key', name: 'Saved key', current: true }
  ]
  render(<AgentDetailModal agentId="pi" onClose={vi.fn()} />)
  const detail = page.getByRole('dialog', { name: 'Pi', exact: true })
  const connection = detail.getByRole('combobox', { name: 'Current connection', exact: true })
  await expect.element(connection).toBeEnabled()
  await userEvent.click(detail.getByRole('button', { name: 'Add', exact: true }))
  await userEvent.fill(page.getByLabelText('API Key', { exact: true }), 'fixture-key')
  await userEvent.fill(page.getByRole('textbox', { name: 'API address', exact: true }), 'https://gateway.example/v1')
  await userEvent.fill(page.getByRole('textbox', { name: 'Models', exact: true }), 'fixture-model')
  await userEvent.click(page.getByRole('button', { name: 'Save connection', exact: true }))
  await until('the key is saved', () => control.created !== null)
  await until('the form closes', () => !document.querySelector('.subscription-connection-form'))
  expect(control.selected).toBe('')
  expect(control.connections.find((c) => c.current)?.id).toBe('key')
  expect(detail.getByRole('combobox', { name: 'Current connection', exact: true }).element().textContent).toContain('Saved key')
  // 就地表单收起就完:❌ 自己把「当前连接」的列表弹开(mac1:加第二、三把时它弹出来、伸出弹窗右边)。
  await new Promise((resolve) => setTimeout(resolve, 300))
  expect(detail.getByRole('combobox', { name: 'Current connection', exact: true }).element().getAttribute('aria-expanded')).toBe('false')
  expect(document.querySelector('[data-testid="connection-api"]')).toBeNull()
  // 新的那一条在列表里,点开才看得到。
  await userEvent.click(detail.getByRole('combobox', { name: 'Current connection', exact: true }))
  await until('the new key is listed', () => !!document.querySelector('[data-testid="connection-api"]'))
})

// 从「没有」加第一把时有会话在忙:同一道护栏 —— 连接加上了、没切,给「关掉并切换」;点了才成为当前连接。
it('the first key added while a session is busy is kept but not switched until Close and switch', async () => {
  control.connections = [{ id: 'native', kind: 'native', name: '', current: true }]
  control.rejectSelect = true
  control.busy = true
  render(<AgentDetailModal agentId="pi" onClose={vi.fn()} />)
  const detail = page.getByRole('dialog', { name: 'Pi', exact: true })
  await until('Pi reads no connection', () => !!document.querySelector('[data-testid="subscription-no-connection-pi"]'))
  await userEvent.click(detail.getByRole('button', { name: 'Add', exact: true }))
  await userEvent.fill(page.getByLabelText('API Key', { exact: true }), 'fixture-key')
  await userEvent.fill(page.getByRole('textbox', { name: 'API address', exact: true }), 'https://gateway.example/v1')
  await userEvent.fill(page.getByRole('textbox', { name: 'Models', exact: true }), 'fixture-model')
  await userEvent.click(page.getByRole('button', { name: 'Save connection', exact: true }))
  await until('the switch is refused with a way out', () => !!document.querySelector('[data-testid="subscription-close-and-switch"]'))
  expect(control.connections.map((c) => [c.id, c.current])).toEqual([['native', true], ['api', false]])
  expect(detail.getByRole('combobox', { name: 'Current connection', exact: true }).element().textContent).toBe('None')
  await userEvent.click(page.getByTestId('subscription-close-and-switch'))
  await until('the key becomes current', () => control.selected === 'api')
  await until('the select names it', () =>
    detail.getByRole('combobox', { name: 'Current connection', exact: true }).query()?.textContent?.includes('Saved API') === true)
})

it('Pi configured on its own (its sign-in file names who pays) lists the existing CLI configuration as that source', async () => {
  control.connections = [{ id: 'native', kind: 'native', name: '', current: true }]
  control.state = 'unknown'
  control.payer = 'subscription'
  render(<AgentDetailModal agentId="pi" onClose={vi.fn()} />)
  const detail = page.getByRole('dialog', { name: 'Pi', exact: true })
  const connection = detail.getByRole('combobox', { name: 'Current connection', exact: true })
  await expect.element(connection).toBeEnabled()
  expect(connection.element().textContent).toContain('Existing CLI configuration')
  await userEvent.click(connection)
  await until('the CLI configuration says who pays', () =>
    document.querySelector('[data-testid="connection-native"]')?.textContent?.includes('Your subscription') === true)
})

it('OpenCode detail is that same section: no separate Account row, and Account sign-in runs its own CLI login', async () => {
  control.connections = [{ id: 'native', kind: 'native', name: '', current: true }]
  render(<AgentDetailModal agentId="opencode" onClose={vi.fn()} />)
  const detail = page.getByRole('dialog', { name: 'OpenCode', exact: true })
  await until('OpenCode reads no connection', () => !!document.querySelector('[data-testid="subscription-no-connection-opencode"]'))
  // 一种样子:没有从前那一行「账号 · 登录」。
  expect(document.querySelector('[data-testid="agent-account-sign-in"]')).toBeNull()
  expect(document.querySelector('[data-testid="agent-account-status"]')).toBeNull()
  expect(document.querySelectorAll('[data-testid="connection-block-opencode"]')).toHaveLength(1)
  expect(addRowHint('opencode')).toBe('Account sign-in or API Key')
  await userEvent.click(detail.getByRole('button', { name: 'Add', exact: true }))
  expect(methodButtons()).toEqual(['Account sign-in', 'API Key'])
  // 「账号」= 登它 CLI 自己那一份:不存连接、不起名，直接是那个登录窗口。
  expect(document.querySelector('.subscription-connection-form input[name="name"]')).toBeNull()
  await userEvent.click(page.getByRole('button', { name: 'Sign in', exact: true }))
  expect(modalStore.activeModalId).toBe('agentSignInModal')
  // 登的、读的是「现有 CLI 配置」那一格(选着 API Key 时主读数是那把 key,❌ 拿它判登没登上)。
  expect(modalStore.activeModalArgs).toMatchObject({ providerId: 'opencode', connectionId: 'native', steps: [{ methodId: 'opencode-login', transport: 'terminal' }] })
  expect(control.created).toBeNull()
})

it('OpenCode signed in on its own lists that CLI configuration and offers no second sign-in, only an API key', async () => {
  control.connections = [{ id: 'native', kind: 'native', name: '', current: true }]
  control.state = 'authenticated'
  render(<AgentDetailModal agentId="opencode" onClose={vi.fn()} />)
  const detail = page.getByRole('dialog', { name: 'OpenCode', exact: true })
  const connection = detail.getByRole('combobox', { name: 'Current connection', exact: true })
  await expect.element(connection).toBeEnabled()
  expect(connection.element().textContent).toContain('Existing CLI configuration')
  await until('the add hint follows what is left', () => addRowHint('opencode') === 'API Key')
  await userEvent.click(detail.getByRole('button', { name: 'Add', exact: true }))
  expect(methodButtons()).toEqual([])
  expect(page.getByLabelText('API Key', { exact: true }).query()).not.toBeNull()
})

// #2507 owner 2026-11-12「删掉最后一个连接要能回到『没有』」:正在用的那把 key 也能删 —— 删了就是切回原生
// (没配过不列),选择框那一格写「没有」。有会话在忙时同一道护栏:先说清楚,点「关掉并切换」才删。
it('the current, only key can be removed: a busy session asks first, then the detail says None', async () => {
  control.connections = [
    { id: 'native', kind: 'native', name: '', current: false },
    { id: 'key', kind: 'api-key', name: 'Saved key', current: true }
  ]
  control.busy = true
  render(<AgentDetailModal agentId="pi" onClose={vi.fn()} />)
  const detail = page.getByRole('dialog', { name: 'Pi', exact: true })
  const connection = detail.getByRole('combobox', { name: 'Current connection', exact: true })
  await expect.element(connection).toBeEnabled()
  expect(connection.element().textContent).toContain('Saved key')
  await userEvent.click(connection)
  await userEvent.click(page.getByRole('button', { name: 'Options for Saved key', exact: true }))
  await userEvent.click(page.getByRole('menuitem', { name: 'Remove', exact: true }))
  await until('the removal is refused while a session works', () => !!document.querySelector('[data-testid="subscription-close-and-switch"]'))
  expect(control.removed).toEqual([{ connectionId: 'key' }])
  expect(control.connections.map((c) => c.id)).toEqual(['native', 'key'])

  await userEvent.click(page.getByTestId('subscription-close-and-switch'))
  await until('the detail says None', () => !!document.querySelector('[data-testid="subscription-no-connection-pi"]'))
  expect(control.removed).toEqual([{ connectionId: 'key' }, { connectionId: 'key', stopBusySessions: true }])
  expect(document.querySelector('[data-testid="subscription-no-connection-pi"]')?.textContent).toBe('None')
  expect(detail.getByRole('combobox', { name: 'Current connection', exact: true }).query()).toBeNull()
  expect(detail.element().textContent).not.toContain('Existing CLI configuration')
  expect(document.querySelector('[data-testid="subscription-close-and-switch"]')).toBeNull()
})

// 还有别的连接时删当前那个也一样落回原生(❌ 替人挑下一个):选择框写「没有」,剩下那条照旧能选。
it('removing the current key while another stays leaves None selected and the other one to pick', async () => {
  control.connections = [
    { id: 'native', kind: 'native', name: '', current: false },
    { id: 'key', kind: 'api-key', name: 'Saved key', current: true },
    { id: 'spare', kind: 'api-key', name: 'Spare key', current: false }
  ]
  render(<AgentDetailModal agentId="pi" onClose={vi.fn()} />)
  const detail = page.getByRole('dialog', { name: 'Pi', exact: true })
  const connection = detail.getByRole('combobox', { name: 'Current connection', exact: true })
  await expect.element(connection).toBeEnabled()
  await userEvent.click(connection)
  await userEvent.click(page.getByRole('button', { name: 'Options for Saved key', exact: true }))
  await userEvent.click(page.getByRole('menuitem', { name: 'Remove', exact: true }))
  await until('the select says None', () => detail.getByRole('combobox', { name: 'Current connection', exact: true }).query()?.textContent === 'None')
  expect(control.removed).toEqual([{ connectionId: 'key' }])
  await userEvent.click(detail.getByRole('combobox', { name: 'Current connection', exact: true }))
  await until('the spare key is offered', () => !!document.querySelector('[data-testid="connection-use-spare"]'))
  expect(document.querySelector('[data-testid="connection-key"]')).toBeNull()
})

it('an agent that can neither sign in in Gugu nor take a key has no Connections section', async () => {
  render(<AgentDetailModal agentId="amp" onClose={vi.fn()} />)
  const detail = page.getByRole('dialog', { name: 'Amp', exact: true })
  await expect.element(detail).toBeVisible()
  await expect.element(detail.getByText('Advanced', { exact: true })).toBeVisible()
  expect(document.querySelector('[data-testid="connection-block-amp"]')).toBeNull()
  expect(detail.element().textContent).not.toContain('Add connection')
})

// owner 2026-11-12 真机走查:「账号登录 | API Key」两项长得一样、看不出选中哪个;表单底部一颗通栏大按钮、「取消」挂在下面。
// ⇒ 方式切换照仓里的分段控件(SegmentedTabs pill:选中 = --muted 实底块,卡片里分得出);只有一种方式不画。
//   底部照「来源 → 自定义路径」那格:主按钮与「取消」同一行靠行尾;展开期间「添加」收起。
it('the inline form shows which way is chosen and ends with its main action and Cancel on one row', async () => {
  const root = document.documentElement
  root.classList.add('gugu-skin', 'emlight')
  root.setAttribute('data-theme', 'light')
  try {
    render(<AgentDetailModal agentId="claude" onClose={vi.fn()} />)
    await until('the add row is drawn', () => !!document.querySelector('[data-testid="subscription-add-claude"]'))
    await userEvent.click(page.getByRole('button', { name: 'Add', exact: true }))
    expect(document.querySelector('[data-testid="subscription-add-claude"]')).toBeNull()
    const chosen = page.getByRole('tab', { name: 'Account sign-in', exact: true }).element()
    const other = page.getByRole('tab', { name: 'API Key', exact: true }).element()
    const surface = getComputedStyle(document.querySelector('[role="dialog"]')!).backgroundColor
    expect(chosen.getAttribute('aria-selected')).toBe('true')
    expect(getComputedStyle(other).backgroundColor).toBe('rgba(0, 0, 0, 0)')
    // 选中那一块是实底,而且不是卡片底色(从前的 --background-2 = --card,所以看不出来)。
    expect(getComputedStyle(chosen).backgroundColor).not.toBe('rgba(0, 0, 0, 0)')
    expect(getComputedStyle(chosen).backgroundColor).not.toBe(surface)
    await userEvent.click(other)
    await until('the choice moves', () => other.getAttribute('aria-selected') === 'true')
    // 底色有一段过渡(--dur-med):等它落定。
    await until('the old choice loses its fill', () => getComputedStyle(chosen).backgroundColor === 'rgba(0, 0, 0, 0)')
    expect(getComputedStyle(other).backgroundColor).not.toBe('rgba(0, 0, 0, 0)')

    const form = document.querySelector('.subscription-connection-form')!.getBoundingClientRect()
    const submit = page.getByRole('button', { name: 'Save connection', exact: true }).element().getBoundingClientRect()
    const cancel = page.getByRole('button', { name: 'Cancel', exact: true }).element().getBoundingClientRect()
    expect(Math.round(cancel.top)).toBe(Math.round(submit.top))
    expect(cancel.left).toBeGreaterThan(submit.right)
    expect(Math.round(cancel.right)).toBe(Math.round(form.right))
    // 不再是通栏:主按钮比表单窄得多。
    expect(submit.width).toBeLessThan(form.width / 2)
    await userEvent.click(page.getByRole('button', { name: 'Cancel', exact: true }))
    await until('the form folds back', () => !document.querySelector('.subscription-connection-form'))
    expect(document.querySelector('[data-testid="subscription-add-claude"]')).not.toBeNull()
  } finally {
    root.classList.remove('gugu-skin', 'emlight')
    root.removeAttribute('data-theme')
  }
})

it.each(['claude', 'codex'])('%s detail keeps both ways under Add connection', async (id) => {
  render(<AgentDetailModal agentId={id} onClose={vi.fn()} />)
  await until('the add row is drawn', () => !!document.querySelector(`[data-testid="subscription-add-${id}"]`))
  expect(addRowHint(id)).toBe('Account sign-in or API Key')
  await userEvent.click(page.getByRole('button', { name: 'Add', exact: true }))
  expect(methodButtons()).toEqual(['Account sign-in', 'API Key'])
})

// #6264 + #2507:任务开在别的机器上 —— 面板里「添加连接 → 账号」登的是**那台机器上**它 CLI 自己那一份(同一个登录窗口),
// ❌ 落到这台电脑。
it('a task on another machine signs in that machine\'s own CLI from Add connection → Account', async () => {
  runInAction(() =>
    remoteHostsStore.hosts.set('dev-walk', {
      device: { id: 'dev-walk', label: '走查机', isOnline: true, platform: 'linux', lastSeenAt: null, sessionDigest: null, directTerminal: false },
      link: 'open',
      synced: true,
    } as never)
  )
  try {
    render(<TaskDraft id="opencode" machine="dev-walk" />)
    await userEvent.click(page.getByTestId('composer-model-trigger'))
    await userEvent.click(page.getByRole('button', { name: 'Go sign in', exact: true }))
    await expect.element(page.getByRole('dialog', { name: 'Add a OpenCode connection', exact: true })).toBeVisible()
    await userEvent.click(page.getByRole('button', { name: 'Sign in', exact: true }))
    expect(modalStore.activeModalId).toBe('agentSignInModal')
    expect(modalStore.activeModalArgs).toMatchObject({
      providerId: 'opencode',
      connectionId: 'native',
      remote: { deviceId: 'dev-walk', deviceLabel: '走查机', command: 'opencode login' }
    })
    expect(control.created).toBeNull()
  } finally {
    runInAction(() => remoteHostsStore.hosts.delete('dev-walk'))
  }
})

// #2507 第 6 轮(owner 2026-11-12):「地址 + Key 是主体:官方和中转一视同仁」「默认是官方地址 …… 一开始就写上」
// 「这里的模型不是可选的吗?…如果多个模型那?」—— Pi 的地址格一开始就是官方地址,宿主按地址探接口所以没有「要支持某某接口」
// 那一行;填好 key,宿主读这个地址的模型清单,带搜索多选,至少勾一个,存的是几个模型。
it('Pi starts on the official address and ticks several models the address lists', async () => {
  control.connections = [{ id: 'native', kind: 'native', name: '', current: true }]
  control.modelList = { kind: 'listed', models: ['gpt-5.5', 'gpt-5.5-mini', 'o4'] }
  render(<AgentDetailModal agentId="pi" onClose={vi.fn()} />)
  const detail = page.getByRole('dialog', { name: 'Pi', exact: true })
  await until('Pi reads no connection', () => !!document.querySelector('[data-testid="subscription-no-connection-pi"]'))
  await userEvent.click(detail.getByRole('button', { name: 'Add', exact: true }))
  await expect.element(page.getByRole('textbox', { name: 'API address', exact: true })).toHaveValue('https://api.openai.com/v1')
  const form = document.querySelector('.subscription-connection-form')!
  expect(form.querySelector('input[type="checkbox"]')).toBeNull()
  expect(form.textContent).not.toContain('must support')
  // 没填 key 之前不读:那一格说先填 key。
  expect(control.modelReads).toEqual([])
  expect(page.getByRole('combobox', { name: 'Models', exact: true }).element().getAttribute('placeholder')).toBe(
    'Fill in the key and address to read the models'
  )
  await userEvent.fill(page.getByLabelText('API Key', { exact: true }), 'fixture-key')
  await until('the host reads the address’s models with this key', () => control.modelReads.length > 0)
  expect(control.modelReads.at(-1)).toEqual({ providerId: 'pi', apiKey: 'fixture-key', endpoint: 'https://api.openai.com/v1' })
  const models = page.getByRole('combobox', { name: 'Models', exact: true })
  await expect.element(models).toBeEnabled()
  // 一个都没勾就存:说一句,❌ 存。
  await userEvent.click(page.getByRole('button', { name: 'Save connection', exact: true }))
  await expect.element(page.getByText('Pick at least one model', { exact: true })).toBeVisible()
  expect(control.created).toBeNull()
  // 搜索:打字只剩匹配的那几条。
  await userEvent.click(models)
  await userEvent.keyboard('mini')
  await until('the list narrows to the match', () =>
    [...document.querySelectorAll('[data-slot="combobox-item"]')].map((item) => item.textContent).join('|') === 'gpt-5.5-mini')
  await userEvent.click(page.getByRole('option', { name: 'gpt-5.5-mini', exact: true }))
  // 换一个搜索词再勾一个。
  await userEvent.clear(models)
  await userEvent.keyboard('o4')
  await userEvent.click(page.getByRole('option', { name: 'o4', exact: true }))
  await until('two models are ticked', () =>
    [...form.querySelectorAll('[data-slot="combobox-chip"]')].map((chip) => chip.textContent).join('|') === 'gpt-5.5-mini|o4')
  expect(page.getByText('Pick at least one model', { exact: true }).query()).toBeNull()
  // Esc 收起的是模型清单,❌ 连带把整张表单收掉(表单自己的 Esc = 取消)。
  await userEvent.clear(models)
  await userEvent.keyboard('gpt')
  await until('the list is open', () => models.element().getAttribute('aria-expanded') === 'true')
  await userEvent.keyboard('{Escape}')
  await until('the list closes', () => models.element().getAttribute('aria-expanded') === 'false')
  expect(document.querySelector('.subscription-connection-form')).not.toBeNull()
  await userEvent.click(page.getByRole('button', { name: 'Save connection', exact: true }))
  await until('the key is saved', () => control.created !== null)
  // 地址原样交给宿主(是不是官方由宿主判)。
  expect(control.created).toEqual({
    providerId: 'pi',
    kind: 'api-key',
    apiKey: 'fixture-key',
    endpoint: 'https://api.openai.com/v1',
    models: ['gpt-5.5-mini', 'o4']
  })
  await until('the new key is the current connection', () => control.selected === 'api')
})

it('an address that lists no models says so in one line and takes several names by hand', async () => {
  control.connections = [{ id: 'native', kind: 'native', name: '', current: true }]
  render(<AgentDetailModal agentId="pi" onClose={vi.fn()} />)
  const detail = page.getByRole('dialog', { name: 'Pi', exact: true })
  await until('Pi reads no connection', () => !!document.querySelector('[data-testid="subscription-no-connection-pi"]'))
  await userEvent.click(detail.getByRole('button', { name: 'Add', exact: true }))
  await userEvent.fill(page.getByLabelText('API Key', { exact: true }), 'fixture-key')
  await userEvent.fill(page.getByRole('textbox', { name: 'API address', exact: true }), 'https://relay.example/v1')
  await until('the reason is said', () =>
    document.querySelector('[data-testid="connection-models-unlisted"]')?.textContent === 'This address doesn’t list its models. Enter them yourself.')
  expect(control.modelReads.at(-1)).toEqual({ providerId: 'pi', apiKey: 'fixture-key', endpoint: 'https://relay.example/v1' })
  await userEvent.fill(page.getByRole('textbox', { name: 'Models', exact: true }), 'glm-5, kimi-k3  deepseek-v4,glm-5')
  await userEvent.click(page.getByRole('button', { name: 'Save connection', exact: true }))
  await until('the key is saved', () => control.created !== null)
  expect(control.created).toMatchObject({ endpoint: 'https://relay.example/v1', models: ['glm-5', 'kimi-k3', 'deepseek-v4'] })
})

// 换模型 ❌ 删了重加:连接的 ⋯ 里「管理模型」,同一个选择器;清单由宿主拿这把连接自己的 key 读。
it('manage models changes a saved key’s models in place and the row lists them', async () => {
  control.connections = [
    { id: 'native', kind: 'native', name: '', current: false },
    { id: 'key', kind: 'api-key', name: 'Relay', endpoint: 'https://relay.example/v1', models: ['glm-5'], current: true }
  ]
  control.modelList = { kind: 'listed', models: ['glm-5', 'kimi-k3', 'deepseek-v4'] }
  render(<AgentDetailModal agentId="pi" onClose={vi.fn()} />)
  const detail = page.getByRole('dialog', { name: 'Pi', exact: true })
  const connection = detail.getByRole('combobox', { name: 'Current connection', exact: true })
  await expect.element(connection).toBeEnabled()
  await userEvent.click(connection)
  await until('the key row is listed', () => !!document.querySelector('[data-testid="connection-key"]'))
  expect(document.querySelector('[data-testid="connection-key"]')?.textContent).toContain('relay.example · glm-5')
  await userEvent.click(page.getByRole('button', { name: 'Options for Relay', exact: true }))
  await userEvent.click(page.getByRole('menuitem', { name: 'Manage models', exact: true }))
  const dialog = page.getByRole('dialog', { name: 'Models of Relay', exact: true })
  await expect.element(dialog).toBeVisible()
  await until('the saved connection’s list is read by its id', () => control.modelReads.length > 0)
  expect(control.modelReads.at(-1)).toEqual({ providerId: 'pi', connectionId: 'key' })
  const chips = () => [...document.querySelectorAll('[data-testid="connection-models-form"] [data-slot="combobox-chip"]')].map((chip) => chip.textContent)
  expect(chips()).toEqual(['glm-5'])
  const models = dialog.getByRole('combobox', { name: 'Models', exact: true })
  await expect.element(models).toBeEnabled()
  await userEvent.click(models)
  await userEvent.click(page.getByRole('option', { name: 'kimi-k3', exact: true }))
  await userEvent.click(page.getByRole('option', { name: 'deepseek-v4', exact: true }))
  await userEvent.keyboard('{Escape}')
  await until('three models are ticked', () => chips().length === 3)
  await userEvent.click(dialog.getByRole('button', { name: 'Save models', exact: true }))
  await until('the models are saved in place', () => control.updatedModels !== null)
  expect(control.updatedModels).toEqual({ providerId: 'pi', connectionId: 'key', models: ['glm-5', 'kimi-k3', 'deepseek-v4'] })
  expect(control.created).toBeNull()
  await until('the dialog closes', () => !document.querySelector('[data-testid="connection-models-form"]'))
  await userEvent.click(detail.getByRole('combobox', { name: 'Current connection', exact: true }))
  await until('the row lists the new models', () =>
    document.querySelector('[data-testid="connection-key"]')?.textContent?.includes('relay.example · glm-5 +2') === true)
})
