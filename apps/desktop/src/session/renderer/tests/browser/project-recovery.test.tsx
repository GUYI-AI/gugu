import { act } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { ListRow } from '@/components/ui/ListRow';
import { Avatar } from '@/components/Avatar';
import { ProjectRecoverySubtitle } from '@/components/projects/ProjectRecoverySubtitle';
import { createReactHarness } from '../../../../../../../tests/support/testHarness';
import type { CanonicalPath } from '@gugu/session-shared/canonical-path';
import { i18n } from '@/i18n';
import '@/styles/tokens.css';
import '@renderer/index.css';

const state = vi.hoisted(() => ({ recover: vi.fn(), clean: vi.fn(), pick: vi.fn() }));
const rows = [{ id: 'paper', chatId: 'paper-group', name: '论文伴读', path: '/missing/paper' as CanonicalPath }, { id: 'weekly', chatId: 'weekly-group', name: '周报整理', path: '/missing/weekly' as CanonicalPath }];
vi.mock('@/lib/projectRecovery', () => ({
  readUnavailableProjects: async () => rows,
  recoverUnavailableProject: state.recover, archiveUnavailableProjects: state.clean,
  projectRecoveryMessage: () => '恢复记录不完整，请联系维护者核对。',
}));
vi.mock('@/platform', () => ({ platform: { selectDirectory: state.pick } }));
let harness: ReturnType<typeof createReactHarness>;
beforeEach(async () => {
  await i18n.changeLanguage('zh-CN');
  await page.viewport(1100, 800); document.documentElement.dataset.theme = 'light';
  vi.clearAllMocks(); state.recover.mockResolvedValue(undefined); state.clean.mockResolvedValue(undefined); state.pick.mockResolvedValue('/selected');
  harness = createReactHarness(); harness.container.style.cssText = 'width:290px;margin:32px';
});
afterEach(() => { harness.cleanup(); delete document.documentElement.dataset.theme; });
async function mount(selected = false, onOpen = vi.fn()) {
  await harness.render(<ListRow data-unavailable-project="paper" title="论文伴读" selected={selected} onClick={onOpen}
    leading={<Avatar variant="group" name="论文伴读" seed="paper-group" size={32} />}
    subtitle={<ProjectRecoverySubtitle project={rows[0]} />} />);
  return harness.container.querySelector<HTMLElement>('[data-unavailable-project]')!;
}
const button = (scope: ParentNode, name: string) => [...scope.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent?.trim() === name)!;

it('uses the sample chip style, mutes only the cover and name, and performs no automatic cleanup', async () => {
  const row = await mount();
  expect(row.querySelector('.gg-chip')?.textContent).toBe('失效');
  expect(row.textContent).toContain('本机找不到文件夹');
  expect(getComputedStyle(row.querySelector('.gg-list-row-title')!).opacity).toBe('0.42');
  expect(getComputedStyle(row.querySelector('.gg-project-recovery-actions')!).display).toBe('none');
  expect(state.clean).not.toHaveBeenCalled(); expect(state.recover).not.toHaveBeenCalled();
});
it('replaces the second line with keyboard-accessible actions when selected', async () => {
  const row = await mount(true);
  expect(getComputedStyle(row.querySelector('.gg-project-unavailable-status')!).display).toBe('none');
  expect(getComputedStyle(row.querySelector('.gg-project-recovery-actions')!).display).toBe('inline-flex');
  await page.elementLocator(button(row, '恢复')).click();
  await vi.waitFor(() => expect(state.recover).toHaveBeenCalledWith(rows[0], '/selected'));
  expect(state.pick).toHaveBeenCalledTimes(1);
});
it('lists every unavailable project, cancels without writes and uses a black primary confirmation', async () => {
  const row = await mount(true);
  await page.elementLocator(button(row, '清理')).click();
  const dialog = await vi.waitFor(() => { const node = document.querySelector<HTMLElement>('[data-testid=project-cleanup-confirm]'); expect(node).not.toBeNull(); return node!; });
  expect(dialog.textContent).toContain('清理 2 个文件夹失效的群？');
  expect([...dialog.querySelectorAll('li > span:last-child')].map(name => name.textContent)).toEqual(['论文伴读', '周报整理']);
  const rgb = getComputedStyle(button(dialog, '清理')).backgroundColor.match(/\d+/g)!.map(Number);
  expect(rgb.slice(0, 3).every(value => value <= 32)).toBe(true);
  expect(state.clean).not.toHaveBeenCalled();
  await page.elementLocator(button(dialog, '取消')).click();
  expect(state.clean).not.toHaveBeenCalled();
});
it('archives exactly the confirmed list after confirmation, without activating the row', async () => {
  const opened = vi.fn(); const row = await mount(true, opened);
  await page.elementLocator(button(row, '清理')).click();
  await vi.waitFor(() => expect(document.querySelector('[data-testid=project-cleanup-confirm]')).not.toBeNull());
  await page.elementLocator(button(document.querySelector('[data-testid=project-cleanup-confirm]')!, '清理')).click();
  await vi.waitFor(() => expect(state.clean).toHaveBeenCalledWith(rows));
  expect(opened).not.toHaveBeenCalled();
});
it('keeps a declined directory picker and a recovery failure from changing project state', async () => {
  const row = await mount(true); state.pick.mockResolvedValueOnce(null);
  await page.elementLocator(button(row, '恢复')).click();
  await act(async () => {}); expect(state.recover).not.toHaveBeenCalled();
  state.recover.mockRejectedValueOnce(new Error('group_recovery_requires_topic_evidence'));
  await page.elementLocator(button(row, '恢复')).click();
  await vi.waitFor(() => expect(row.querySelector('[role=alert]')?.textContent).toBe('恢复记录不完整，请联系维护者核对。'));
});
it('lets the existing dialog handle Escape without activating its enclosing project row', async () => {
  const opened = vi.fn(); const row = await mount(true, opened);
  await page.elementLocator(button(row, '清理')).click();
  await vi.waitFor(() => expect(document.querySelector('[data-testid=project-cleanup-confirm]')).not.toBeNull());
  await act(async () => button(document.querySelector('[data-testid=project-cleanup-confirm]')!, '取消').focus());
  await userEvent.keyboard('{Escape}');
  await vi.waitFor(() => expect(document.querySelector('[data-testid=project-cleanup-confirm]')).toBeNull());
  expect(opened).not.toHaveBeenCalled(); expect(state.clean).not.toHaveBeenCalled();
});
