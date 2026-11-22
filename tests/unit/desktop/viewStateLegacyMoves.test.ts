// @vitest-environment jsdom
// View state kept in localStorage before the view-state table moves over once, when its module loads, and the old key goes:
// after this, localStorage holds no view state (③) — only device preferences (②), caches and workflow records.
import { beforeEach, expect, it, vi } from 'vitest'

const table = () => import('../../../apps/desktop/src/lib/viewStateTable')
const left = (...keys: string[]) => keys.filter((key) => localStorage.getItem(key) !== null)

/** A start with these old values stored, the last signed-in account being `acc`; then `load` imports the module. */
async function start(values: Record<string, string>, load: () => Promise<unknown>) {
  localStorage.clear()
  localStorage.setItem('gugu.readModel.v1.account', 'acc')
  for (const [key, value] of Object.entries(values)) localStorage.setItem(key, value)
  vi.resetModules()
  await load()
  return table()
}

beforeEach(() => { localStorage.clear() })

it('pane widths: the sidebar and the inner column', async () => {
  const { readInterface } = await start({ 'gugu.taskpage.sidebarWidth': '300', 'gugu.taskpage.innerSidebarWidth': '333' },
    () => import('../../../apps/desktop/src/session/renderer/lib/layout/layout-provider'))
  expect(readInterface('gugu.taskpage.sidebarWidth')).toBe(300)
  expect(readInterface('gugu.taskpage.innerSidebarWidth')).toBe(333)
  expect(left('gugu.taskpage.sidebarWidth', 'gugu.taskpage.innerSidebarWidth')).toEqual([])
})

it('a preview\'s zoom, the automation templates fold', async () => {
  const { readInterface } = await start({
    'gugu.file-content-zoom.pdf': '1.5',
    'emdash-automation-template-section-collapsed': 'true',
  }, async () => {
    await import('../../../apps/desktop/src/components/preview/file-content-zoom')
    await import('../../../apps/desktop/src/session/renderer/features/automations/components/CreateAutomationView')
  })
  expect(readInterface('gugu.file-content-zoom.pdf')).toBe(1.5)
  expect(readInterface('gugu-automation-template-section-collapsed')).toBe(true)
  expect(left('gugu.file-content-zoom.pdf', 'emdash-automation-template-section-collapsed')).toEqual([])
})

it('an App\'s side panel, the built-in assistant page\'s panel and last tab', async () => {
  await start({ 'gugu.app.notes.panel': 'closed', 'gugu.assistant.panel': 'open', 'gugu.assistant.lastTab': 'memory' }, () => Promise.resolve())
  const panel = await import('../../../apps/desktop/src/session/renderer/features/apps/app-conversation-panel')
  expect(panel.appConversationPanelCollapsed('notes')).toBe(true)
  expect(panel.keptBuiltInAssistantLastTab()).toBe('memory')
  expect(left('gugu.app.notes.panel', 'gugu.assistant.panel', 'gugu.assistant.lastTab')).toEqual([])
})

it('the screen layout and where Apps are placed move into the last signed-in account', async () => {
  const screen = { blocks: { b1: { kind: 'chat', chatId: 'c1' } }, layout: { block: 'b1' } }
  const { readViewState } = await start({
    'gugu.screen-layout.v1': JSON.stringify(screen),
    'gugu.app-placement.v1': JSON.stringify({ 'app:notes': { projectId: 'p', sessionId: 's' } }),
  }, () => import('../../../apps/desktop/src/session/renderer/app/screen-layout-actions'))
  expect(readViewState({ conversation: '', panel: 'screen', account: 'acc' })).toEqual({ snapshot: screen })
  expect(readViewState({ conversation: '', panel: 'app-placement', account: 'acc' })).toEqual({ placements: { 'app:notes': { projectId: 'p', sessionId: 's' } } })
  expect(left('gugu.screen-layout.v1', 'gugu.app-placement.v1')).toEqual([])
})

it('per-account memories: tab placement, participant panes, recent tasks, recent searches, last @mention, the referral draft', async () => {
  const { readViewState } = await start({
    'gugu.tab-placement.v1:acc': JSON.stringify({ 'folder:/docs': 'beside', bad: 'nope' }),
    'gugu.group-participant-pane.v1:acc': JSON.stringify({ rightWidth: 520, placements: {} }),
    'gugu:recent-tasks:acc': JSON.stringify(['t1', 't2']),
    'gugu.globalSearch.recent': JSON.stringify({ c1: ['alpha'], '*': ['beta'] }),
    'gugu:group-mention:acc/c1': 'member-1',
    'gugu:referral-entry-review:acc': 'CODE42',
  }, async () => {
    await import('../../../apps/desktop/src/session/renderer/features/tabs/tab-placement-memory')
    await import('../../../apps/desktop/src/session/renderer/features/chats/group-participant-panes')
    await import('../../../apps/desktop/src/session/renderer/features/command-palette/recent-tasks')
    await import('../../../apps/desktop/src/session/renderer/features/global-search/search-session')
    await import('../../../apps/desktop/src/lib/groupMentionRecall')
    await import('../../../apps/desktop/src/components/referralPreview/ReferralPreview')
  })
  expect(readViewState({ conversation: '', panel: 'tab-placement', account: 'acc' })).toEqual({ placements: { 'folder:/docs': 'beside' } })
  expect(readViewState({ conversation: '', panel: 'participant-panes', account: 'acc' })).toEqual({ rightWidth: 520, placements: {} })
  expect(readViewState({ conversation: '', panel: 'recent-tasks', account: 'acc' })).toEqual({ ids: ['t1', 't2'] })
  expect(readViewState({ conversation: 'c1', panel: 'search-recent', account: 'acc' })).toEqual({ words: ['alpha'] })
  expect(readViewState({ conversation: '*', panel: 'search-recent', account: 'acc' })).toEqual({ words: ['beta'] })
  expect(readViewState({ conversation: 'c1', panel: 'mention-recall', account: 'acc' })).toEqual({ id: 'member-1' })
  expect(readViewState({ conversation: 'account:referral', panel: 'draft', account: 'acc' })).toEqual({ text: 'CODE42' })
  expect(Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i)!).filter((key) => key !== 'gugu.readModel.v1.account' && !key.startsWith('gugu.view-state:'))).toEqual([])
})

it('the phone\'s last machine for a new project and its folded and expanded projects', async () => {
  const { readInterface } = await start({
    'gugu.partners.newProjectMachine': 'd22',
    'gugu.agent-watch.collapsed.projects': JSON.stringify(['p1']),
    'gugu.agent-watch.more.projects': JSON.stringify(['p2', 3]),
  }, async () => {
    await import('../../../apps/desktop/src/mobile/partners/PhoneNewProjectPage')
    await import('../../../apps/desktop/src/mobile/agent-watch/ProjectsPage')
  })
  expect(readInterface('gugu.partners.newProjectMachine')).toBe('d22')
  expect(readInterface('gugu.agent-watch.collapsed.projects')).toEqual(['p1'])
  expect(readInterface('gugu.agent-watch.more.projects')).toEqual(['p2'])
  expect(left('gugu.partners.newProjectMachine', 'gugu.agent-watch.collapsed.projects', 'gugu.agent-watch.more.projects')).toEqual([])
})

it('with no account known at the start (signed out, or a version that kept no last-account pointer), per-account values wait: their old keys stay until the first account is published', async () => {
  localStorage.clear()
  const screen = { blocks: { b1: { kind: 'chat', chatId: 'c1' } }, layout: { block: 'b1' } }
  localStorage.setItem('gugu.screen-layout.v1', JSON.stringify(screen))
  localStorage.setItem('gugu.globalSearch.recent', JSON.stringify({ c1: ['alpha'] }))
  vi.resetModules()
  await import('../../../apps/desktop/src/session/renderer/app/screen-layout-actions')
  await import('../../../apps/desktop/src/session/renderer/features/global-search/search-session')
  const { readViewState } = await table()
  expect(left('gugu.screen-layout.v1', 'gugu.globalSearch.recent'), 'nothing moved yet').toEqual(['gugu.screen-layout.v1', 'gugu.globalSearch.recent'])
  expect(readViewState({ conversation: '', panel: 'screen', account: '' }), 'never under an empty account').toEqual({})
  const { publishRendererSession } = await import('../../../apps/desktop/src/lib/sessionPublication')
  publishRendererSession('SIGNED_IN', { user: { id: 'first-account' } } as never)
  expect(readViewState({ conversation: '', panel: 'screen', account: 'first-account' })).toEqual({ snapshot: screen })
  expect(readViewState({ conversation: 'c1', panel: 'search-recent', account: 'first-account' })).toEqual({ words: ['alpha'] })
  expect(left('gugu.screen-layout.v1', 'gugu.globalSearch.recent')).toEqual([])
})
