import { createRoot, type Root } from 'react-dom/client';
import type { ReactNode } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { ChatComposer, MessageProvider } from '@gugu/session-ui/react/components';
import { enUSMessages } from '@renderer/localization/messages';

const agents = [
  { id: 'codex', name: 'Codex', icon: <span data-testid="codex-icon" /> },
  { id: 'claude', name: 'Claude Code', icon: <span data-testid="claude-icon" /> },
];
const translate = (key: string) => (enUSMessages as Record<string, string>)[key] ?? key;

let mount: HTMLDivElement | undefined;
let root: Root | undefined;
function render(children: ReactNode) {
  mount = document.createElement('div');
  document.body.append(mount);
  root = createRoot(mount);
  root.render(children);
}

afterEach(() => {
  root?.unmount();
  mount?.remove();
});

it.each(agents)('shows the locked $name identity beside the context popup close button', async ({ id, name }) => {
  render(<MessageProvider locale="en-US" translate={translate}>
    <ChatComposer onSubmit={() => {}} agentOptions={agents} selectedAgent={id} agentLocked hideLockedAgent
      contextUsage={{ used: 11_031, size: 1_000_000, costSource: 'platform' }} />
  </MessageProvider>);
  await expect.element(page.getByTestId('context-usage-trigger')).toBeVisible();
  expect(document.querySelector('[data-composer-locked-agent]')).toBeNull();
  expect(document.querySelector('[data-slot="context-usage-harness"]')).toBeNull();
  await page.getByTestId('context-usage-trigger').click();
  const panel = page.getByTestId('context-usage-panel');
  await expect.element(panel).toBeVisible();
  const harness = panel.element().querySelector('[data-slot="context-usage-harness"]')!;
  expect(harness.textContent).toBe(name);
  expect(harness.querySelector(`[data-testid="${id}-icon"]`)).not.toBeNull();
  expect(harness.nextElementSibling?.getAttribute('aria-label')).toBe('Close context usage');
});

it('keeps the engine chooser on a new task', async () => {
  const onAgentChange = vi.fn();
  render(<MessageProvider locale="en-US" translate={translate}>
    <ChatComposer onSubmit={() => {}} agentOptions={agents} selectedAgent="codex" onAgentChange={onAgentChange} />
  </MessageProvider>);
  await page.getByTestId('composer-agent-trigger').click();
  await page.getByRole('option', { name: 'Claude Code' }).click();
  expect(onAgentChange).toHaveBeenCalledExactlyOnceWith('claude');
});

it('shows the harness default in K and returns to it by choosing the checked default value', async () => {
  const set = vi.fn().mockResolvedValue(undefined);
  render(<MessageProvider locale="en-US" translate={translate}>
    <ChatComposer onSubmit={() => {}} selectedModel="luna"
      contextThresholds={() => ({ minimum: 8_000, maximum: 1_100_000, value: null, set })}
      contextUsage={{ used: 25_000, size: 1_100_000, autoCompact: { defaultTokens: 990_000, ceiling: 990_000 }, costSource: 'platform' }} />
  </MessageProvider>);
  await page.getByTestId('context-usage-trigger').click();
  await page.getByTestId('context-usage-panel').getByRole('button', { name: /990K/ }).click();
  const current = page.getByRole('button', { name: '990K', exact: true });
  await expect.element(current).toHaveAttribute('aria-pressed', 'true');
  await current.click();
  expect(set).toHaveBeenCalledExactlyOnceWith(null);
});

it.each([{ value: null, label: null }, { value: 128_000, label: '128K' }])(
  'shows a threshold without harness metadata only when the user explicitly chose it',
  async ({ value, label }) => {
    render(<MessageProvider locale="en-US" translate={translate}>
      <ChatComposer onSubmit={() => {}} selectedModel="older-task-model"
        contextThresholds={() => ({ minimum: 8_000, maximum: 200_000, value, set: vi.fn().mockResolvedValue(undefined) })}
        contextUsage={{ used: 40_000, size: 200_000, costSource: 'unknown' }} />
    </MessageProvider>);
    await page.getByTestId('context-usage-trigger').click();
    const panel = page.getByTestId('context-usage-panel');
    await expect.element(panel.getByText('20.0%')).toBeVisible();
    const footer = panel.getByRole('button', { name: /Auto.?compact/i });
    if (!label) {
      expect(footer.query()).toBeNull();
      return;
    }
    await expect.element(footer).toHaveTextContent(label);
    await footer.click();
    await expect.element(page.getByRole('button', { name: label, exact: true })).toHaveAttribute('aria-pressed', 'true');
  }
);
