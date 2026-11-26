import { QueryClientProvider, type QueryClient } from '@tanstack/react-query'
import { followRendererSession, queryClient, refreshTag } from '@/lib/replica'
import { createRoot, type Root } from 'react-dom/client'
import { useState } from 'react'
import { ComposerModelMenu } from '@gugu/session-ui/react/components'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import type { AgentPayload } from '@shared/core/agents/agent-payload'
import type { HarnessConnection } from '@gugu/session-core/workspace-server/agent-config'
import { AgentDetailModal } from '@renderer/features/settings/agents-page/AgentDetailModal'
import { useConnectionPanel } from '@renderer/features/settings/subscriptions/use-connection-panel'
import { SUBSCRIPTIONS, connectionDetails } from '@renderer/features/settings/subscriptions/subscription-queries'
// A provider's subscription readings on this machine (the replicas' keys: [model, device, machine, provider, …]).
const readingsOf = (id: string) => ({ predicate: (q: { queryKey: readonly unknown[] }) => q.queryKey[2] === null && q.queryKey[3] === id })
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
  removed: [] as Array<{ connectionId: string; stopBusySessions?: boolean }>,
  /** What the real sign-in window started its login with (#3857: it opens nested in the detail, not via the global store). */
  login: null as Record<string, unknown> | null
}))

const NAMES: Record<string, string> = { codex: 'Codex', claude: 'Claude', pi: 'Pi', opencode: 'OpenCode', amp: 'Amp', kilocode: 'Kilo Code' }

function agent(id: string): AgentPayload {
  const login = id === 'pi' || id === 'amp'
    ? { kind: 'none' }
    : id === 'kilocode'
      ? { kind: 'supported', methods: [], vendorKey: { envVars: ['KILO_API_KEY'], unsetEnv: ['KILO_API_KEY'] } }
      : { kind: 'supported', methods: [{ kind: 'cli-login', id: `${id}-login`, name: id, args: ['login'] }] }
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
      auth: login
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
    listCustomModels: async () => ({ success: true, data: [] }),
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
        kind: 'account',
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
    selectConnection: async ({ providerId, connectionId, stopBusySessions }: { providerId: string; connectionId: string; stopBusySessions?: boolean }) => {
      // 「关掉并切换」= 正在工作的也关掉:宿主不再以「在忙」拒。
      if (control.rejectSelect && !(control.busy && stopBusySessions)) {
        control.selected = 'rejected'
        return {
          success: false,
          error: {
            type: 'invalid-state',
            message: 'Connection could not switch',
            ...(control.busy ? { sessionsBusy: { providerId, count: 2 } } : {})
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
    create: async (args: Record<string, unknown>) => {
      control.login = args
      return {
      sendInput: () => {},
      resize: () => {},
      markUrlHandled: () => {},
      dispose: () => {},
      status: {
        follow: (listener: (state: unknown) => void) => {
          listener({ status: { kind: 'unauthenticated' }, login: null })
          return () => {}
        }
      }
    }
    }
  }
}))

/** The sign-in a detail asked for opens nested in that detail (@@@modal-surface): the real window, and its login. */
const nestedSignIn = async (login: Record<string, unknown>) => {
  await until('the sign-in opens nested in the detail', () => document.querySelector('[data-surface-modal="agentSignInModal"][data-nested]') !== null)
  expect(modalStore.isOpen, 'not through the global modal store').toBe(false)
  await until('the real sign-in starts its login', () => control.login !== null)
  expect(control.login).toMatchObject(login)
}

// The panels open inside the signed-in app: the model catalog a switch refreshes is an account's reading.
followRendererSession('SIGNED_IN', 'reader')

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
  control.login = null
  control.connections = [{ id: 'native', kind: 'native', name: 'CLI', current: true }]
  // The subscription readings are replicas: they live in the one client (lib/replica), cleared after each case.
  client = queryClient
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
  'the account form remains accessible in the detail at %ipx',
  async (width) => {
    await page.viewport(width, 900)
    render(<AgentDetailModal agentId="codex" onClose={vi.fn()} />)
    await userEvent.click(page.getByRole('button', { name: 'Add', exact: true }))
    const dialog = page.getByRole('dialog', { name: 'Codex', exact: true })
    await expect.element(dialog).toBeVisible()
    await expect.element(dialog.getByRole('textbox', { name: 'Remark (optional)', exact: true })).toBeVisible()
    await expect.element(dialog.getByRole('button', { name: 'Add and sign in', exact: true })).toBeEnabled()
    const form = document.querySelector('.subscription-connection-form')!
    expect(form.querySelector('input[type="password"], input[type="url"], [role="tab"]')).toBeNull()
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
      await until('the first readings settle', () => client.isFetching(readingsOf(id)) === 0)
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
        const pending = refreshTag(SUBSCRIPTIONS, null, id)
        await until(
          'background readings start',
          () => client.isFetching(readingsOf(id)) > 0
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
          await connectionDetails.refresh(null, id, 'native')
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

it('with nothing configured, Codex opens the account form directly and keeps the draft', async () => {
  render(<TaskDraft id="codex" />)
  const href = location.href
  await userEvent.fill(page.getByRole('textbox', { name: 'Task draft' }), 'Keep this draft')
  await userEvent.click(page.getByTestId('composer-model-trigger'))
  await userEvent.click(page.getByRole('button', { name: 'Go sign in', exact: true }))
  const dialog = page.getByRole('dialog', { name: 'Add a Codex connection', exact: true })
  await expect.element(dialog).toBeVisible()
  expect(document.querySelector('[data-testid="connection-native"]')).toBeNull()
  expect(methodButtons()).toEqual([])
  await userEvent.click(dialog.getByRole('button', { name: 'Add and sign in', exact: true }))
  await until('the new account sign-in opens', () => modalStore.activeModalId === 'agentSignInModal')
  expect(document.querySelector('[data-testid="connection-native"]')).toBeNull()
  await expect.element(page.getByRole('textbox', { name: 'Task draft' })).toHaveValue('Keep this draft')
  expect(location.href).toBe(href)
  expect(control.created).toMatchObject({ providerId: 'codex', kind: 'account' })
  expect(control.created).not.toHaveProperty('apiKey')
})

// 面板(新建任务、会话里打开的那份)同一条:第一把 key 被「在忙」拒了,菜单打开,里面同一句、同一个「关掉并切换」。
it('a task panel shows the busy refusal of its first vendor key with Close and switch', async () => {
  control.rejectSelect = true
  control.busy = true
  render(<TaskDraft id="kilocode" />)
  await userEvent.click(page.getByTestId('composer-model-trigger'))
  await userEvent.click(page.getByRole('button', { name: 'Go sign in', exact: true }))
  await expect.element(page.getByRole('dialog', { name: 'Add a Kilo Code connection', exact: true })).toBeVisible()
  expect(document.querySelector('.subscription-connection-form input[type="url"], .subscription-connection-form input[name="models"]')).toBeNull()
  await userEvent.fill(page.getByLabelText('API Key', { exact: true }), 'fixture-key')
  await userEvent.click(page.getByRole('button', { name: 'Save connection', exact: true }))
  await until('the menu carries the refusal and its way out', () =>
    !!document.querySelector('.subscription-connection-menu [data-testid="subscription-close-and-switch"]'))
  expect(document.querySelector('.subscription-connection-menu [role="status"]')?.textContent).toContain('2 Kilo Code sessions')
  expect(control.connections.find((c) => c.current)?.id).toBe('native')
  await userEvent.click(page.getByTestId('subscription-close-and-switch'))
  await until('the key becomes current', () => control.selected === 'api')
})

it('a rejected task connection remains visible with its cause and keeps the original draft and connection', async () => {
  control.state = 'authenticated'
  control.nativeState = 'authenticated'
  control.rejectSelect = true
  control.connections.push({ id: 'api', kind: 'account', name: 'Saved API', current: false })
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
    await nestedSignIn({ providerId: 'codex', connectionId: 'saved-account', methodId: 'codex-login' })
  }
)

it('an authenticated native Codex connection keeps its row login entry and menu login action', async () => {
  control.state = 'authenticated'
  control.nativeState = 'authenticated'
  render(<AgentDetailModal agentId="codex" onClose={vi.fn()} />)
  await expect.element(page.getByTestId('subscription-sign-in-codex')).toHaveTextContent('Sign in again')
  await userEvent.click(page.getByRole('combobox', { name: 'Current connection', exact: true }))
  await userEvent.click(page.getByRole('button', { name: 'Options for Existing CLI configuration', exact: true }))
  const login = page.getByRole('menuitem', { name: 'Sign in again', exact: true })
  await expect.element(login).toBeVisible()
  expect(page.getByRole('menuitem', { name: 'Remove', exact: true }).query()).toBeNull()
  await userEvent.click(login)
  await nestedSignIn({ providerId: 'codex', connectionId: 'native' })
  expect(control.removed).toEqual([])
})

it('working sessions refuse a task connection switch with a calm status and keep the native connection', async () => {
  control.state = 'authenticated'
  control.nativeState = 'authenticated'
  control.rejectSelect = true
  control.busy = true
  control.connections.push({ id: 'api', kind: 'account', name: 'Saved API', current: false })
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
  'the real sign-in terminal remains accessible and clickable above the detail at %ipx',
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
    await until('the real login has closed', () => login.query() === null)
    await expect.element(page.getByRole('dialog', { name: 'Codex', exact: true })).toBeVisible()
  }
)

// #2507 owner 2026-11-12:「pi 还是没地方登录或者用 apikey」「你非得每个都不一样干嘛」——每一家的详情都是同一块
// 「连接」:当前连接 + 添加连接,方式按这家支持的给。
const methodButtons = () =>
  [...document.querySelectorAll('.subscription-connection-form [role="tab"]')].map((b) => b.textContent)
const addRowHint = (id: string) =>
  document.querySelector(`[data-testid="subscription-add-${id}"]`)?.closest('.gg-settings-row')?.querySelector('.gg-settings-row-description')?.textContent

it('OpenCode detail is that same section: no separate Account row, and Account sign-in runs its own CLI login', async () => {
  control.connections = [{ id: 'native', kind: 'native', name: '', current: true }]
  render(<AgentDetailModal agentId="opencode" onClose={vi.fn()} />)
  const detail = page.getByRole('dialog', { name: 'OpenCode', exact: true })
  await until('OpenCode reads no connection', () => !!document.querySelector('[data-testid="subscription-no-connection-opencode"]'))
  // 一种样子:没有从前那一行「账号 · 登录」。
  expect(document.querySelector('[data-testid="agent-account-sign-in"]')).toBeNull()
  expect(document.querySelector('[data-testid="agent-account-status"]')).toBeNull()
  expect(document.querySelectorAll('[data-testid="connection-block-opencode"]')).toHaveLength(1)
  expect(addRowHint('opencode')).toBe('Account sign-in')
  await userEvent.click(detail.getByRole('button', { name: 'Add', exact: true }))
  expect(methodButtons()).toEqual([])
  // 「账号」= 登它 CLI 自己那一份:不存连接、不起名，直接是那个登录窗口。
  expect(document.querySelector('.subscription-connection-form input[name="name"]')).toBeNull()
  await userEvent.click(page.getByRole('button', { name: 'Sign in', exact: true }))
  await nestedSignIn({ providerId: 'opencode', methodId: 'opencode-login' })
  expect(control.created).toBeNull()
})

it('an agent that can neither sign in in Gugu nor take a key has no Connections section', async () => {
  render(<AgentDetailModal agentId="amp" onClose={vi.fn()} />)
  const detail = page.getByRole('dialog', { name: 'Amp', exact: true })
  await expect.element(detail).toBeVisible()
  await expect.element(detail.getByText('Advanced', { exact: true })).toBeVisible()
  expect(document.querySelector('[data-testid="connection-block-amp"]')).toBeNull()
  expect(detail.element().textContent).not.toContain('Add connection')
})

it('a task on another machine signs in that machine\'s own CLI from Add connection', async () => {
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
      remote: { deviceId: 'dev-walk', deviceLabel: '走查机', command: 'opencode login' }
    })
    expect(control.created).toBeNull()
  } finally {
    runInAction(() => remoteHostsStore.hosts.delete('dev-walk'))
  }
})
