import { createServer, type ServerResponse } from 'node:http'
import { writeFileSync } from 'node:fs'
import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test'

const EMAIL = 'search-field@example.test'
const USER_ID = '5ea2c5ee-8781-4db0-9ca1-dca4bf23f938'
const MOCK_PORT = Number(process.env.CLOCK_SKEW_AUTH_PORT || 6745)
const ADD_FRIEND_SEARCH = /^(?:搜索用户 \/ 咕咕号 \/ 邮箱|Search by user, Gugu ID, or email)$/
const CONTACTS_SEARCH = /^(?:搜索联系人|Search contacts)$/

function base64Url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url')
}

function authUser() {
  const now = new Date().toISOString()
  return {
    id: USER_ID,
    aud: 'authenticated',
    role: 'authenticated',
    email: EMAIL,
    email_confirmed_at: now,
    phone: '',
    app_metadata: { provider: 'email', providers: ['email'] },
    user_metadata: { nickname: 'Search Field Test' },
    identities: [],
    created_at: now,
    updated_at: now,
  }
}

function authSession() {
  const nowSeconds = Math.floor(Date.now() / 1000)
  return {
    access_token: [
      base64Url({ alg: 'HS256', typ: 'JWT' }),
      base64Url({ sub: USER_ID, aud: 'authenticated', role: 'authenticated', exp: nowSeconds + 3600 }),
      'fixture-signature',
    ].join('.'),
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: nowSeconds + 3600,
    refresh_token: 'search-field-refresh',
    user: authUser(),
  }
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    'Access-Control-Allow-Headers': 'accept-profile, authorization, apikey, content-profile, content-type, prefer, range, x-client-info, x-supabase-api-version',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
  })
  response.end(JSON.stringify(body))
}

const productFixture = createServer((request, response) => {
  if (request.method === 'OPTIONS') {
    json(response, 200, {})
    return
  }
  const url = new URL(request.url ?? '/', `http://127.0.0.1:${MOCK_PORT}`)
  if (url.pathname === '/auth/v1/otp') {
    json(response, 200, {})
    return
  }
  if (url.pathname === '/auth/v1/verify' || url.pathname === '/auth/v1/token') {
    json(response, 200, authSession())
    return
  }
  if (url.pathname === '/auth/v1/user') {
    json(response, 200, authUser())
    return
  }
  if (url.pathname === '/rest/v1/users') {
    const profile = {
      id: USER_ID,
      gugu_number: 3301,
      display_name: 'Search Field Test',
      avatar: null,
      bio: null,
      // 老账号:首次引导早走完了(#7348 的门只拦 onboarded_at 为空的新账号),这条测的是主界面的搜索框。
      onboarded_at: '2026-01-01T00:00:00.000Z',
    }
    const wantsSingle = request.headers.accept?.includes('application/vnd.pgrst.object+json') ?? false
    json(response, 200, wantsSingle ? profile : [profile])
    return
  }
  if (url.pathname.startsWith('/rest/v1/')) {
    json(response, 200, [])
    return
  }
  json(response, 404, { message: `unhandled fixture route ${url.pathname}` })
})

test.describe.configure({ mode: 'serial' })
test.beforeAll(async () => {
  await new Promise<void>((resolve, reject) => {
    productFixture.once('error', reject)
    productFixture.listen(MOCK_PORT, '127.0.0.1', () => resolve())
  })
})
test.afterAll(async () => {
  await new Promise<void>((resolve, reject) => productFixture.close((error) => error ? reject(error) : resolve()))
})

async function login(page: Page): Promise<void> {
  await page.goto('/')
  await page.getByPlaceholder('邮箱地址').fill(EMAIL)
  await page.getByRole('button', { name: '继续', exact: true }).click()
  await page.getByPlaceholder('6 位验证码').fill('123456')
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await expect(page.getByPlaceholder('邮箱地址')).toBeHidden()
}

async function readSearchMetrics(name: string, input: Locator) {
  await expect(input, `${name} search input is visible`).toBeVisible()
  return input.evaluate((element, surface) => {
    const root = element.parentElement
    if (!root) throw new Error(`${surface} search input has no visual root`)
    const rootStyle = getComputedStyle(root)
    const inputStyle = getComputedStyle(element)
    return {
      surface,
      slot: root.getAttribute('data-slot'),
      height: root.getBoundingClientRect().height,
      borderRadius: rootStyle.borderRadius,
      borderColor: rootStyle.borderColor,
      borderStyle: rootStyle.borderStyle,
      backgroundColor: rootStyle.backgroundColor,
      fontSize: inputStyle.fontSize,
    }
  }, name)
}

async function capture(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const path = testInfo.outputPath(`${name}.png`)
  await page.screenshot({ path })
  await testInfo.attach(`${name}.png`, { path, contentType: 'image/png' })
}

test('main renderer search fields share one visual contract', async ({ page }, testInfo) => {
  await login(page)
  const metrics = []

  // 宽屏上已经没有单独的聊天页(对话列表在会话页侧栏里),这一面没有聊天列表的搜索框;
  // 手机保留聊天页,它的搜索框在下面量。
  // The far-left rail is gone; Contacts is a row in my menu, which the session page's sidebar draws. This run has no
  // session host (GUGU_TASK_HOST=0), so it opens Contacts by the shell's own shortcut (app.goContacts, Mod+Alt+2), as a
  // user can: the shell's dispatcher answers it with no task page mounted.
  const contactsSearch = page.getByPlaceholder(CONTACTS_SEARCH)
  await expect(async () => {
    await page.keyboard.press('ControlOrMeta+Alt+2')
    await expect(contactsSearch).toBeVisible({ timeout: 2_000 })
  }).toPass({ timeout: 30_000 })
  // Contacts opens as a modal that scales in (the Sheet's motion): read the field once that has played out, not mid-scale.
  await contactsSearch.evaluate(async (input) => {
    const sheet = input.closest('.gg-sheet-content')
    if (!sheet) throw new Error('the contacts search is not in its modal')
    await Promise.all(sheet.getAnimations({ subtree: true })
      .filter((animation) => animation.effect?.getTiming().iterations !== Infinity)
      .map((animation) => animation.finished))
  })
  metrics.push(await readSearchMetrics('contacts', contactsSearch))
  await capture(page, testInfo, 'search-field-contacts')

  // #5115 起这颗图标是**菜单触发器**（添加联系人 / 加入群聊），不再是直接跳转 ⇒ 要点两下。
  // 走 testid：触发按钮的 aria-label 与菜单项文字同名，按名字找会在菜单展开后变成二义。
  await page.getByTestId('contacts-add-menu-button').click()
  await page.getByTestId('contacts-add-menu-contact').click()
  const addFriendSearch = page.getByPlaceholder(ADD_FRIEND_SEARCH)
  await expect(addFriendSearch).toBeFocused()
  // 失焦后边框色从聚焦态过渡回静止态:等这段过渡放完再读(下面对三处读数判同一个边框色)。
  await addFriendSearch.evaluate(async (input) => {
    input.blur()
    const root = input.parentElement
    if (!root) throw new Error('add-friend search input has no visual root')
    await Promise.all(root.getAnimations().map((animation) => animation.finished))
  })
  metrics.push(await readSearchMetrics('add-friend', addFriendSearch))
  await capture(page, testInfo, 'search-field-add-friend')

  // 2026-09-05:原来这里还量第四个读数 —— 发现页的 DiscoverSearchField。发现页与找群同批下架,
  // 那个搜索框已不可达。宽屏上的两处普通搜索输入仍共用 SearchField 原语。

  // 同一个 SearchField 原语:槽位、高度、字号、边框样式处处一致。通讯录左栏的框是导航列样式(variant="nav"):
  // 与那一列的行同形 —— 胶囊、无常驻边框、浅底;页面里的框(加联系人)保持控件档圆角与常驻边框。
  for (const reading of metrics) {
    expect(reading, JSON.stringify(reading)).toMatchObject({ slot: 'search-field', height: 36, borderStyle: 'solid', fontSize: '14px' })
  }
  const [contacts, addFriend] = metrics
  expect(contacts, JSON.stringify(contacts)).toMatchObject({ borderRadius: '9999px', borderColor: 'rgba(0, 0, 0, 0)' })
  expect(addFriend, JSON.stringify(addFriend)).toMatchObject({ borderRadius: '8px' })
  expect(addFriend.borderColor).not.toBe('rgba(0, 0, 0, 0)')

  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByTestId('mobile-contacts-nav').click()
  const partners = page.getByTestId('phone-partners')
  await expect(partners).toBeVisible()
  await expect(partners.locator('[data-header-search-open]')).toHaveCount(0)
  const phoneSearchButton = page.getByTestId('phone-list-search')
  await expect(phoneSearchButton).toBeVisible()
  expect((await phoneSearchButton.boundingBox())?.height).toBeGreaterThanOrEqual(44)
  await phoneSearchButton.click()
  const mobileSearch = page.getByTestId('phone-message-search').getByTestId('global-search-input')
  await expect(mobileSearch).toBeVisible()
  await capture(page, testInfo, 'search-field-partners-mobile')

  const metricsPath = testInfo.outputPath('search-field-metrics.json')
  writeFileSync(metricsPath, `${JSON.stringify(metrics, null, 2)}\n`)
  await testInfo.attach('search-field-metrics.json', { path: metricsPath, contentType: 'application/json' })
})
