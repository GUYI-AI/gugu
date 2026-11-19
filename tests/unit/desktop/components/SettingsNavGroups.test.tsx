// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  SETTINGS_SECTIONS,
  SESSION_HOST_SETTINGS_SECTIONS,
  isAssistantSettingsSection,
} from '../../../../packages/core/src/shared/enums/settingsSectionModels'
import { SettingsNav } from '../../../../apps/desktop/src/components/settings/SettingsNav'
import { setLocalePreference } from '../../../../apps/desktop/src/i18n'
import { clickElement, createNode, createReactHarness, renderWithAppProviders } from '../../../support/testHarness'

let harness: ReturnType<typeof createReactHarness>
beforeEach(() => { harness = createReactHarness(); setLocalePreference('zh-CN') })
afterEach(() => { harness.cleanup(); setLocalePreference('zh-CN') })

const render = (sections: readonly string[], extra: { mobile?: boolean; onSelect?: (section: string) => void } = {}) =>
  renderWithAppProviders(harness, createNode(SettingsNav, {
    activeSection: 'account',
    sections,
    user: { id: 'u-1', nickname: 'Tester', avatarUrl: null },
    onSelect: () => {},
    ...extra,
  }), { auth: { id: 'u-1', email: 'owner@example.com', nickname: 'Tester' } })

const groups = () =>
  [...harness.container.querySelectorAll('[role="group"]')].map((group) =>
    [...group.querySelectorAll('[data-testid^="settings-nav-"]')].map((row) => row.getAttribute('data-testid')!.replace('settings-nav-', '')))

const captions = () => [...harness.container.querySelectorAll('.gg-settings-nav-caption')].map((el) => el.textContent)

// SettingsPanel excludes phone-only entries on desktop. This covers every section a desktop host may supply.
const desktopSections = SETTINGS_SECTIONS.filter((section) => section !== 'apps' && section !== 'phone' && section !== 'connectors')
// SettingsPanel excludes the desktop-only password, data import, and saved prompt destinations from the mobile shell.
const mobileSections = SETTINGS_SECTIONS.filter((section) => section !== 'passwords' && section !== 'data-import' && section !== 'prompts')

// Desktop order follows the approved sidebar; mobile retains its existing groups.
describe('the one settings nav', () => {
  it('draws the approved desktop groups and order', async () => {
    await render(desktopSections)
    expect(groups()).toEqual([
      ['account', 'subscriptions', 'usage'],
      ['general', 'data-import', 'interface', 'model', 'permissions', 'passwords'],
      ['sessions', 'prompts', 'devices', 'browser', 'files'],
      ['resource-monitor', 'help', 'about'],
    ])
  })

  it('includes every desktop-eligible section exactly once', async () => {
    await render(desktopSections)
    expect(groups().flat().sort()).toEqual([...desktopSections].sort())
  })

  it('reports a desktop section without a group in development', async () => {
    await expect(render([...desktopSections, 'channels'])).rejects.toThrow('desktop sections missing a group: channels')
  })

  it('preserves every mobile group and its existing order', async () => {
    await render(mobileSections, { mobile: true })
    expect(groups()).toEqual([
      ['account', 'usage', 'files', 'subscriptions'],
      ['general', 'connectors', 'interface', 'permissions', 'model', 'resource-monitor'],
      ['sessions', 'browser', 'devices', 'apps', 'phone'],
      ['help', 'about'],
    ])
  })

  // 手机「我的」没有会话页那几格(订阅、云端连接应用也在其中:读数要会话页宿主):同一份分组,少掉的格不画,整组空了就连组带小标题一起不画。
  it('drops the sections a host does not show, and a group left empty', async () => {
    await render(mobileSections.filter((section) => !SESSION_HOST_SETTINGS_SECTIONS.includes(section) && section !== 'devices' && section !== 'channels' && section !== 'apps' && section !== 'phone'), { mobile: true })
    expect(groups()).toEqual([
      ['account', 'usage', 'files'],
      ['general', 'connectors', 'permissions', 'model'],
      ['help', 'about'],
    ])
  })

  it('filters unavailable desktop sections and omits empty groups', async () => {
    await render(['account', 'usage', 'files', 'general', 'permissions', 'model'])
    expect(groups()).toEqual([
      ['account', 'usage'],
      ['general', 'model', 'permissions'],
      ['files'],
    ])
    expect(captions()).toEqual(['账户', '偏好', '工作'])
  })

  // 「关于」组只有一格、同名,不画小标题。
  it('captions desktop groups', async () => {
    await render(desktopSections)
    expect(captions()).toEqual(['账户', '偏好', '工作', '诊断'])
  })

  it('preserves mobile captions and the uncaptioned About entry', async () => {
    await render(mobileSections, { mobile: true })
    expect(captions()).toEqual(['我的', '偏好', '工作'])
    expect(harness.container.querySelector('[data-group="about"] .gg-settings-nav-caption')).toBeNull()
  })

  it('translates the desktop group captions into English', async () => {
    setLocalePreference('en-US')
    await render(desktopSections)
    expect(captions()).toEqual(['Account', 'Preferences', 'Work', 'Diagnostics'])
  })

  it('keeps navigation selection connected after an entry moves groups', async () => {
    const onSelect = vi.fn()
    await render(desktopSections, { onSelect })
    await clickElement(harness.container.querySelector<HTMLElement>('[data-group="work"] [data-testid="settings-nav-files"]')!)
    expect(onSelect).toHaveBeenCalledWith('files')
    expect(harness.container.querySelector('[aria-current="page"]')?.getAttribute('data-testid')).toBe('settings-nav-account')
  })

  // The phone retains its own Connected Apps entry under Preferences.
  it('offers Connected Apps in phone settings, and saved prompts in desktop settings', async () => {
    for (const mobile of [false, true]) {
      await render(mobile ? mobileSections : desktopSections, { mobile })
      expect(SETTINGS_SECTIONS).not.toContain('assistant')
      // Their old routes are told apart, to be sent to the App (MainLayout).
      expect((['assistant', 'connectors', 'channels', 'account', 'devices'] as const).map(isAssistantSettingsSection)).toEqual([true, true, true, false, false])
      expect(harness.container.querySelector('[data-group="assistant"]')).toBeNull()
      expect(harness.container.querySelector('[data-testid="settings-nav-assistant"]')).toBeNull()
      const connectors = harness.container.querySelector('[data-testid="settings-nav-connectors"]')
      expect(connectors?.closest('[role="group"]')?.getAttribute('data-group') ?? null).toBe(mobile ? 'preferences' : null)
      expect(Boolean(harness.container.querySelector('[data-testid="settings-nav-prompts"]'))).toBe(!mobile)
      const nav = harness.container.querySelector('.gg-settings-nav-scroll')!
      expect(nav.textContent).not.toMatch(/资料|咕咕/)
      harness.cleanup()
      harness = createReactHarness()
    }
  })
})
