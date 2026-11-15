import { useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { ChatComposer, MessageProvider } from '@gugu/session-ui/react/components'
import { LocalizationProvider, setLocalePreference } from '@/i18n'
import { SessionUiTheme } from '@/components/sessionpage/SessionUiTheme'
import { translateSessionMessage } from '@renderer/localization/locale-store'
import '@/i18n/registerMessagingCatalog'
import { followRendererSession } from '@/lib/replica'
import { PhoneComposerControl, PhoneComposerControlRow } from '@/mobile/composer/PhoneComposerControls'
import { Monitor, Sparkles, Hash, Users } from '@/lib/icons'
import { CreateTarget } from '@/mobile/agent-watch/CreateTarget'
import { SelectedCreationSkills } from '@/mobile/agent-watch/CreateSkills'
import type { CreationSkill } from '@/mobile/agent-watch/create-skills'
import type { CreateMachine } from '@/mobile/agent-watch/create-target'
import type { CreateSelection } from '@/mobile/agent-watch/create-session-form'
import type { SessionpageSessionCreateOptions } from '@gugu/session-core/session-record/contract'
import { until } from '../../../../../../../tests/support/awaitCondition'
import '@/styles/tokens.css'
import '@/mobile/phone-shell.css'
import '@/mobile/phone-look.css'

vi.mock('@/mobile/agent-watch/sessionpage-rpc', () => ({ machineRpc: () => ({ sessionTimeline: {
  sessionCreateSkills: async (input: { harness: string }) => ({ ok: true, value: { skills: input.harness === 'pi' ? [] : [{ id: '/native/meeting/SKILL.md', name: '会议记录', description: '整理会议记录与待办事项' }, { id: '/native/code/SKILL.md', name: '代码检查', description: '检查代码中的问题' }] } }),
} }) }))
const machines: CreateMachine[] = ['Mac', 'Cloud'].map((name) => ({ device: { device_id: name, label: name, hostname: name, platform: 'darwin', status: 'online', is_online: true, last_seen_at: '2026-11-15T00:00:00Z', capabilities: { terminals: [], runtimes: ['codex'] } }, localProjectId: null, path: null, available: true }))
machines.push({ ...machines[0]!, device: { ...machines[0]!.device, device_id: 'Phone', label: 'Phone', platform: 'ios', capabilities: { terminals: [], runtimes: ['pi'], host_kind: 'phone', host_runtime_capability: 1 } } })
const options: SessionpageSessionCreateOptions = { projects: [], lastUsed: null, harnesses: ['codex', 'claude', 'pi'].map((id) => ({ id, name: id === 'codex' ? 'Codex' : id === 'claude' ? 'Claude Code' : 'Pi', status: 'available', watchable: true, sessionViews: ['general'], permissionModes: [] })) }
let root: Root | null = null, host: HTMLDivElement | null = null
function Harness({ projectTask = false }: { projectTask?: boolean }) {
  const [machineId, setMachine] = useState('Mac'), [projectId, setProject] = useState<string | null>(null)
  const [selection, setSelection] = useState<CreateSelection>({ harness: 'codex', model: null, effort: null, permissionMode: null })
  const [skills, setSkills] = useState<CreationSkill[]>([])
  const projects = [{ chatId: 'project', name: '一个用于窄屏验收的长项目名称', homes: new Map<string, string>() }]
  return <><CreateTarget machines={machines} machine={machines.find((m) => m.device.device_id === machineId)} machineLabel={(d) => d.label}
    onMachine={setMachine} projects={projects} project={projects.find((p) => p.chatId === projectId) ?? null} onProject={setProject} busy={false}
    projectTask={projectTask ? { onFolder: () => undefined } : undefined}
    configuration={{ options, selection, onChange: setSelection, models: null, modelsState: 'ready', skills, onSkills: setSkills }} />
    <div style={{ flex: '0 0 auto' }}><ChatComposer mobile editorOptions={{ inputTestId: 'chat-composer' }} onSubmit={vi.fn()} inputHeader={<SelectedCreationSkills skills={skills} onChange={setSkills} />} /></div>
  </>
}
afterEach(() => { root?.unmount(); host?.remove(); root = null; host = null; document.documentElement.removeAttribute('data-theme') })
async function mount(theme: 'light' | 'dark' = 'dark', locale: 'zh-CN' | 'en-US' = 'zh-CN', projectTask = false) {
  followRendererSession('SIGNED_IN', 'phone-controls-browser')
  await page.viewport(390, 844)
  setLocalePreference(locale)
  document.documentElement.dataset.theme = theme
  host = document.body.appendChild(document.createElement('div')); host.dataset.phoneShell = ''; host.className = 'gg-aw-create-host'
  host.style.cssText = 'position:fixed;inset:0;display:flex;flex-direction:column;justify-content:flex-end;padding:16px'
  root = createRoot(host); root.render(<LocalizationProvider><SessionUiTheme theme={theme}><MessageProvider locale={locale} translate={translateSessionMessage}><Harness projectTask={projectTask} /></MessageProvider></SessionUiTheme></LocalizationProvider>)
  await until('composer', () => !!host?.querySelector('[contenteditable]'))
  ;(host!.querySelector('[contenteditable]') as HTMLElement).blur()
  await until('configuration controls visible', () => !host?.querySelector('[data-phone-composer-controls][data-editing]'))
  return host.querySelector<HTMLElement>('[contenteditable]')!
}
it.each(['light', 'dark'] as const)('%s: configuration transitions and a skill tag preserve the same editor and draft', async (theme) => {
  const editor = await mount(theme)
  await page.getByTestId('chat-composer').fill('正在输入中文\n第二行'); editor.blur()
  const s = getSelection()!, range = document.createRange(); range.setStart(editor.lastElementChild!.firstChild!, 2); range.collapse(true); s.removeAllRanges(); s.addRange(range)
  const before = { node: s.anchorNode, offset: s.anchorOffset, text: editor.textContent }
  editor.blur()
  await until('configuration controls visible', () => !host?.querySelector('[data-phone-composer-controls][data-editing]'))
  const blur = vi.fn(), end = vi.fn(); editor.addEventListener('blur', blur); editor.addEventListener('compositionend', end)
  await page.getByTestId('agent-watch-create-model-device').click()
  await page.getByRole('heading', { name: '工作', exact: true }).click()
  await page.getByRole('radio', { name: 'Cloud' }).click()
  await page.getByRole('button', { name: '关闭', exact: true }).click()
  await page.getByTestId('agent-watch-create-project').click()
  await page.getByRole('radio', { name: '一个用于窄屏验收的长项目名称' }).click()
  await page.getByTestId('agent-watch-create-skills').click()
  await page.getByRole('checkbox', { name: /会议记录/ }).click()
  await until('skill tag', () => !!host?.querySelector('[data-testid="agent-watch-create-skill-tags"]'))
  expect(host!.querySelector('[contenteditable]')).toBe(editor)
  expect(document.activeElement).not.toBe(editor); expect(s.anchorNode).toBe(before.node); expect(s.anchorOffset).toBe(before.offset)
  expect(editor.textContent).toBe(before.text); expect(blur).not.toHaveBeenCalled(); expect(end).not.toHaveBeenCalled()
  expect(editor.closest('[data-slot="composer-input"]')!.querySelector('[data-testid="agent-watch-create-skill-tags"]')).not.toBeNull()
  await page.getByRole('button', { name: '移除技能 会议记录' }).click()
  expect(host!.querySelector('[contenteditable]')).toBe(editor); expect(blur).not.toHaveBeenCalled(); expect(end).not.toHaveBeenCalled()
})
it('search is intentional, filters the real catalog and keeps a narrow sheet in the visible viewport', async () => {
  await mount(); await page.viewport(320, 640)
  await page.getByTestId('agent-watch-create-skills').click()
  await page.getByRole('searchbox', { name: '搜索技能' }).fill('代码')
  await expect.element(page.getByRole('checkbox', { name: /代码检查/ })).toBeVisible()
  expect(document.body.textContent).not.toContain('整理会议记录与待办事项')
  const panel = document.querySelector<HTMLElement>('[data-testid="agent-watch-create-controls-sheet"]')!
  await Promise.all(panel.getAnimations().map((a) => a.finished))
  const box = panel.getBoundingClientRect(); expect(box.left).toBeGreaterThanOrEqual(12); expect(box.right).toBeLessThanOrEqual(308); expect(box.bottom).toBeLessThanOrEqual(640)
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(320)
})
it('does not reserve an attachment gutter when creation has no attachment adapter', async () => {
  const editor = await mount()
  const input = editor.closest<HTMLElement>('[data-slot="composer-input"]')!
  expect(host!.querySelector('[data-phone-attachment]')).toBeNull()
  expect(getComputedStyle(input).paddingLeft).toBe('16px')
  const left = editor.getBoundingClientRect().left
  await page.getByTestId('chat-composer').fill('一行文字')
  expect(editor.getBoundingClientRect().left).toBe(left)
  await page.getByTestId('chat-composer').fill('')
  expect(editor.getBoundingClientRect().left).toBe(left)
  expect(host!.querySelector('[contenteditable]')).toBe(editor)
})
it('hides the skills entry for a phone target and restores it for a computer without replacing the input', async () => {
  const editor = await mount()
  await page.getByTestId('chat-composer').fill('保留这段草稿'); editor.blur()
  await page.getByTestId('agent-watch-create-model-device').click()
  await page.getByRole('radio', { name: 'Phone' }).click()
  await page.getByRole('button', { name: '关闭', exact: true }).click()
  expect(host!.querySelector('[data-testid="agent-watch-create-skills"]')).toBeNull()
  expect(host!.querySelector('[contenteditable]')).toBe(editor)
  expect(editor.textContent).toBe('保留这段草稿')
  expect(document.body.textContent).not.toContain('暂不提供')
  await page.getByTestId('agent-watch-create-model-device').click()
  await page.getByRole('radio', { name: 'Mac', exact: true }).click()
  await page.getByRole('button', { name: '关闭', exact: true }).click()
  await expect.element(page.getByTestId('agent-watch-create-skills')).toBeVisible()
  expect(host!.querySelector('[contenteditable]')).toBe(editor)
})

it.each([['zh-CN', 'dark'], ['zh-CN', 'light'], ['en-US', 'dark'], ['en-US', 'light']] as const)('%s %s: three complete fixed labels fit at 390px without scrolling', async (locale, theme) => {
  await mount(theme, locale)
  const row = host!.querySelector<HTMLElement>('[data-phone-composer-controls]')!
  const buttons = [...row.querySelectorAll<HTMLButtonElement>('button')]
  expect(buttons.map((button) => button.textContent)).toEqual(locale === 'zh-CN' ? ['工作', '项目', '技能'] : ['Work', 'Project', 'Skills'])
  expect(row.scrollWidth).toBeLessThanOrEqual(row.clientWidth)
  for (const button of buttons) {
    const box = button.getBoundingClientRect(), label = button.querySelector<HTMLElement>('.gg-phone-composer-control-label')!
    expect(box.right).toBeLessThanOrEqual(390)
    expect(Math.abs(box.top - buttons[0]!.getBoundingClientRect().top)).toBeLessThan(1)
    expect(label.scrollWidth).toBeLessThanOrEqual(label.clientWidth)
  }
})

it('keeps narrow English controls on one line without unnecessary scrolling', async () => {
  await mount('dark', 'en-US')
  await page.viewport(320, 640)
  const row = host!.querySelector<HTMLElement>('[data-phone-composer-controls]')!
  const buttons = [...row.querySelectorAll('button')]
  expect(row.scrollWidth).toBeLessThanOrEqual(row.clientWidth)
  for (const button of buttons) expect(Math.abs(button.getBoundingClientRect().top - buttons[0]!.getBoundingClientRect().top)).toBeLessThan(1)
  row.scrollLeft = row.scrollWidth
  await until('last control visible', () => buttons.at(-1)!.getBoundingClientRect().right <= row.getBoundingClientRect().right + 1)
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(320)
})

it.each([['zh-CN', 'dark'], ['zh-CN', 'light'], ['en-US', 'dark'], ['en-US', 'light']] as const)('%s %s: project tasks keep three controls and choose the agent inside Work', async (locale, theme) => {
  const editor = await mount(theme, locale, true)
  const blur = vi.fn(), end = vi.fn()
  editor.addEventListener('blur', blur); editor.addEventListener('compositionend', end)
  expect(host!.querySelector('[data-testid="agent-watch-create-project"]')).toBeNull()
  const row = host!.querySelector<HTMLElement>('[data-phone-composer-controls]')!
  const buttons = [...row.querySelectorAll('button')]
  expect(buttons.map(button => button.textContent)).toEqual(locale === 'zh-CN' ? ['工作', '文件夹', '技能'] : ['Work', 'Folder', 'Skills'])
  expect(host!.querySelector('[data-testid="agent-watch-create-agent"]')).toBeNull()
  expect(row.scrollWidth).toBeLessThanOrEqual(row.clientWidth)
  for (const button of buttons) expect(Math.abs(button.getBoundingClientRect().top - buttons[0]!.getBoundingClientRect().top)).toBeLessThan(1)
  await page.getByTestId('agent-watch-create-model-device').click()
  const harness = () => document.querySelector<HTMLButtonElement>('[data-testid="agent-watch-create-options-drill"][data-dimension="harness"]')
  await until('agent choice in Work', () => !!harness())
  await page.getByRole('button', { name: locale === 'zh-CN' ? /智能体.*Codex/ : /Agent.*Codex/ }).click()
  expect(host!.querySelector('[data-testid="agent-watch-create-model-device"]')!.hasAttribute('data-active')).toBe(true)
  await expect.element(page.getByRole('radio', { name: 'Claude Code', exact: true })).toBeVisible()
  await page.getByRole('radio', { name: 'Claude Code', exact: true }).click()
  await until('selected agent shown in Work', () => harness()?.textContent?.includes('Claude Code') === true)
  expect(document.activeElement).not.toBe(editor); expect(blur).not.toHaveBeenCalled(); expect(end).not.toHaveBeenCalled()
  expect(host!.querySelector('[contenteditable]')).toBe(editor)
})

it('omits search only for an actually empty skill catalog', async () => {
  await mount()
  await page.getByTestId('agent-watch-create-skills').click()
  await expect.element(page.getByRole('searchbox', { name: '搜索技能' })).toBeVisible()
  await page.getByRole('button', { name: '关闭', exact: true }).click()
  await page.getByTestId('agent-watch-create-model-device').click()
  await page.getByRole('button', { name: /智能体/ }).click()
  await page.getByRole('radio', { name: 'Pi', exact: true }).click()
  await page.getByRole('button', { name: '关闭', exact: true }).click()
  await page.getByTestId('agent-watch-create-skills').click()
  await expect.element(page.getByText('没有可用的技能', { exact: true })).toBeVisible()
  expect(document.querySelector('[data-testid=agent-watch-create-controls-sheet] input[type=search]')).toBeNull()
})


it.each([360, 390])('%ipx: four shared controls retain equal padding and fit without scrolling', async width => {
  await mount()
  await page.viewport(width, 844)
  root!.render(<PhoneComposerControlRow>{[
    ['工作', <Monitor />], ['技能', <Sparkles />], ['话题', <Hash />], ['智能体', <Users />],
  ].map(([label, icon], index) => <PhoneComposerControl key={index} label={String(label)} icon={icon} testId={`shared-control-${index}`} onClick={() => {}} />)}</PhoneComposerControlRow>)
  await until('four shared controls', () => host!.querySelectorAll('[data-phone-composer-controls] button').length === 4)
  const row = host!.querySelector<HTMLElement>('[data-phone-composer-controls]')!
  const buttons = [...row.querySelectorAll('button')]
  expect(row.scrollWidth).toBeLessThanOrEqual(row.clientWidth)
  for (const [index, button] of buttons.entries()) {
    const box = button.getBoundingClientRect(), style = getComputedStyle(button)
    const icons = button.querySelectorAll('svg'), icon = icons[0]!.getBoundingClientRect()
    const label = button.querySelector('.gg-phone-composer-control-label')!.getBoundingClientRect()
    expect(icons).toHaveLength(1)
    expect([style.paddingLeft, style.paddingRight]).toEqual(['12px', '12px'])
    expect(box.height).toBe(44)
    expect(icon.left - box.left).toBe(12)
    expect(label.left - icon.right).toBe(4)
    expect(box.y).toBe(buttons[0]!.getBoundingClientRect().y)
    if (index) expect(box.left - buttons[index - 1]!.getBoundingClientRect().right).toBe(8)
  }
})


it.each([false, true])('project task=%s: controls fade on editor focus and return without moving the input', async projectTask => {
  const editor = await mount('dark', 'zh-CN', projectTask)
  const row = host!.querySelector<HTMLElement>('[data-phone-composer-controls]')!
  const input = host!.querySelector<HTMLElement>('[data-slot="composer-input"]')!
  const top = input.getBoundingClientRect().top
  expect(getComputedStyle(row).opacity).toBe('1')
  editor.focus()
  await until('controls hidden for editing', () => row.hasAttribute('data-editing'))
  await Promise.all(row.getAnimations().map(animation => animation.finished))
  expect(getComputedStyle(row).opacity).toBe('0')
  expect(row.inert).toBe(true)
  expect(input.getBoundingClientRect().top).toBe(top)
  editor.blur()
  await until('controls return after blur', () => !row.hasAttribute('data-editing'))
  await Promise.all(row.getAnimations().map(animation => animation.finished))
  expect(getComputedStyle(row).opacity).toBe('1')
  expect(row.inert).toBe(false)
  expect(input.getBoundingClientRect().top).toBe(top)
})
