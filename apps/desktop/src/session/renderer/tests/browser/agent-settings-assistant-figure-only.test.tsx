import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { contact, createReactHarness, renderWithAppProviders } from '../../../../../../../tests/support/testHarness';
import { until } from '../../../../../../../tests/support/awaitCondition';
import { clearAgentDisplayStatusOverrides, setAgentDisplayStatusOverride } from '../../../../../../../tests/support/agentDisplayStatusTestDouble';
import { AgentSettingsModal } from '@/components/agentsettings/AgentSettingsModal';
import type { AgentSettingsTab } from '@/components/agentsettings/types';
import { i18n } from '@/i18n';
import '@/i18n/registerAgentsCatalog';
import '@/styles/tokens.css';

const fixture = vi.hoisted(() => ({
  assistant: { id: 'assistant-figure', display_name: 'Figure assistant', avatar: null, type: 'agent' as const, owner_user_id: 'owner-figure', agent_type: 'codex' as const },
  other: { id: 'other-agent', display_name: 'Other agent', avatar: null, type: 'agent' as const, owner_user_id: 'owner-figure', agent_type: 'codex' as const },
}));
// Only identity / presence / scheduled-task reads are fixtures; the dialog, its panes and styles are the product's.
vi.mock('@/lib/avatarIdentity', async (original) => ({
  ...await original<object>(), useIsAssistantAvatar: (id: string) => id === fixture.assistant.id,
}));
vi.mock('@/hooks/useAgentDisplayStatus', () => import('../../../../../../../tests/support/agentDisplayStatusTestDouble'));
vi.mock('@/lib/agentScheduledTasks', () => ({ agentScheduledTaskService: { list: async () => [] } }));

let harness: ReturnType<typeof createReactHarness>;
beforeEach(async () => {
  await page.viewport(1400, 900);
  await i18n.changeLanguage('zh-CN');
  harness = createReactHarness();
});
afterEach(() => {
  harness.cleanup();
  clearAgentDisplayStatusOverrides();
});

async function open(agent: typeof fixture.assistant, initialTab?: AgentSettingsTab) {
  await renderWithAppProviders(harness, <AgentSettingsModal agent={contact(agent)} initialTab={initialTab} onClose={vi.fn()} />, {
    auth: { id: 'owner-figure' }, contacts: { contacts: [contact(fixture.assistant), contact(fixture.other)] },
  });
  await until('the agent dialog is open', () => !!document.querySelector('[data-testid="agent-settings-modal"]'));
  return document.querySelector<HTMLElement>('[data-testid="agent-settings-modal"]')!;
}

const navLabels = (modal: HTMLElement) => [...modal.querySelectorAll('.gg-as-rail button')].map((button) => button.textContent?.trim());

// owner 11-12: the personal assistant's dialog is its figure alone, whichever page an entry asked for.
it.each([undefined, 'profile', 'look', 'share-act', 'tasks', 'aimodel'] as const)('the assistant opened at %s shows only the figure workshop, no rail', async (initialTab) => {
  const modal = await open(fixture.assistant, initialTab);
  await until('the figure workshop is drawn', () => !!modal.querySelector('[data-testid="agent-settings-figure-only"]'));
  expect(modal.querySelector('.gg-as-rail')).toBeNull();
  expect(modal.querySelector('.gg-as-body')?.getAttribute('data-active-tab')).toBe('look');
  expect(modal.querySelector('[data-testid="agent-profile-content"]')).toBeNull();
  expect(modal.querySelectorAll('.gg-as-pane')).toHaveLength(1);
});

it('on a phone the assistant opens straight on the figure; the top-left arrow closes it', async () => {
  await page.viewport(390, 844);
  const close = vi.fn();
  await renderWithAppProviders(harness, <AgentSettingsModal agent={contact(fixture.assistant)} initialTab="tasks" onClose={close} />, {
    auth: { id: 'owner-figure' }, contacts: { contacts: [contact(fixture.assistant)] },
  });
  await until('the figure workshop is drawn', () => !!document.querySelector('[data-testid="agent-settings-figure-only"]'));
  const body = document.querySelector<HTMLElement>('.gg-as-body')!;
  expect(getComputedStyle(body).display).not.toBe('none');
  expect(document.querySelector('.gg-as-rail')).toBeNull();
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  expect(close).toHaveBeenCalledOnce();
});

it('another agent keeps its rail and panes (资料 / 分享 / 定时任务 / AI 模型), no figure workshop', async () => {
  const modal = await open(fixture.other, 'aimodel');
  expect(navLabels(modal)).toEqual(['资料', '分享', '定时任务', 'AI 模型']);
  expect(modal.querySelector('.gg-as-body')?.getAttribute('data-active-tab')).toBe('aimodel');
  expect(modal.querySelector('[data-testid="agent-settings-figure-only"]')).toBeNull();
});

const resolved = (value: string) => {
  const probe = document.createElement('span');
  probe.style.color = value;
  document.body.append(probe);
  const color = getComputedStyle(probe).color;
  probe.remove();
  return color;
};
const dot = (status: HTMLElement) => getComputedStyle(status, '::before');

// The dot beside 「状态 · 本机 · 引擎」: 出错了 / 需要你 / 在跑 take the shared tone colours (出错了 was green, for every agent);
// every other state keeps its dot exactly as before — green, offline / removed grey — and no dot disappears.
it.each([
  ['error', 'var(--agent-tone-error)'],
  ['needs_user', 'var(--agent-tone-needs-user)'],
  ['working', 'var(--agent-tone-running)'],
  ['parked', 'var(--agent-tone-running)'],
  ['idle', 'var(--green)'],
  ['starting', 'var(--green)'],
  ['pending', 'var(--green)'],
  ['offline', 'var(--faint-fg)'],
] as const)('the header dot for %s is that tone\'s colour', async (status, token) => {
  for (const agent of [fixture.assistant, fixture.other]) {
    setAgentDisplayStatusOverride(agent.id, status);
    const modal = await open(agent);
    const shown = modal.querySelector<HTMLElement>('[data-testid="agent-settings-header-status"]')!;
    expect(dot(shown).display).not.toBe('none');
    expect(dot(shown).backgroundColor).toBe(resolved(token));
    if (status === 'error' || status === 'needs_user' || status === 'working' || status === 'parked') expect(dot(shown).backgroundColor).not.toBe(resolved('var(--green)'));
    harness.cleanup();
    harness = createReactHarness();
  }
});
