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
  const apiKeyConnection = id === 'pi' || id === 'opencode'
    ? { kind: 'supported', endpoint: id === 'pi' ? 'required' : 'none', model: id === 'pi' ? 'required' : 'none', protocol: id === 'pi' ? 'openai-chat-completions' : undefined, evidence: 'test' }
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
    createConnection: async (input: Record<string, unknown>) => {
      control.created = input
      const created: HarnessConnection = {
        id: 'api',
        kind: 'api-key',
        name: 'Saved API',
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
    selectConnection: async ({ connectionId }: { connectionId: string }) => {
      if (control.rejectSelect) {
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
      .element(page.getByRole('button', { name: 'Account sign-in', exact: true }))
      .toBeVisible()
    await userEvent.click(page.getByRole('button', { name: 'API Key', exact: true }))
    await expect.element(page.getByLabelText('API Key', { exact: true })).toBeVisible()
    await userEvent.click(
      page.getByRole('checkbox', { name: 'Use a third-party API', exact: true })
    )
    await expect
      .element(page.getByRole('textbox', { name: 'API address', exact: true }))
      .toBeVisible()
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
  await userEvent.click(page.getByRole('button', { name: 'API Key', exact: true }))
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
  const methods = [...document.querySelectorAll('.subscription-connection-form [role="group"] button')].map((b) => b.textContent)
  expect(methods).toEqual(id === 'pi' ? ['API Key'] : ['Account sign-in', 'API Key'])
  if (id !== 'pi') await userEvent.click(page.getByRole('button', { name: 'API Key', exact: true }))
  await userEvent.fill(page.getByLabelText('API Key', { exact: true }), 'fixture-key')
  if (id === 'pi') {
    await userEvent.fill(page.getByRole('textbox', { name: 'API address', exact: true }), 'https://gateway.example/v1')
    await userEvent.fill(page.getByRole('textbox', { name: 'Model', exact: true }), 'fixture-model')
  }
  await userEvent.click(page.getByRole('button', { name: 'Save connection', exact: true }))
  await until('saved API is listed', () => !!document.querySelector('[data-testid="connection-use-api"]'))
  expect(document.querySelector('[data-testid="connection-native"]')).toBeNull()
  await userEvent.click(page.getByTestId('connection-use-api'))
  await until('the selected connection is committed', () => control.selected === 'api')
  await expect.element(page.getByRole('textbox', { name: 'Task draft' })).toHaveValue('Keep this draft')
  expect(location.href).toBe(href)
  expect(control.created).toMatchObject({ providerId: id, kind: 'api-key', apiKey: 'fixture-key' })
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
  [...document.querySelectorAll('.subscription-connection-form [role="group"] button')].map((b) => b.textContent)
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
  expect(document.querySelector('[data-testid="connection-status-pi"]')?.textContent).toBe('Not signed in')
  expect(addRowHint('pi')).toBe('API Key')
  await userEvent.click(detail.getByRole('button', { name: 'Add', exact: true }))
  expect(methodButtons()).toEqual(['API Key'])
  await userEvent.fill(page.getByLabelText('API Key', { exact: true }), 'fixture-key')
  await userEvent.fill(page.getByRole('textbox', { name: 'API address', exact: true }), 'https://gateway.example/v1')
  await userEvent.fill(page.getByRole('textbox', { name: 'Model', exact: true }), 'fixture-model')
  await userEvent.click(page.getByRole('button', { name: 'Save connection', exact: true }))
  await until('the key is saved', () => control.created !== null)
  expect(control.created).toMatchObject({ providerId: 'pi', kind: 'api-key', apiKey: 'fixture-key', endpoint: 'https://gateway.example/v1', model: 'fixture-model' })
  // 有了一条连接,「当前连接」才有可选的东西。
  await expect.element(detail.getByRole('combobox', { name: 'Current connection', exact: true })).toBeEnabled()
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
  expect(methodButtons()).toEqual(['API Key'])
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
