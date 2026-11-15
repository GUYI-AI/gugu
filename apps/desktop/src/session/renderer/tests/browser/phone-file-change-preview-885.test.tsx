import { afterEach, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { getI18n } from 'react-i18next';
import { getLocaleSnapshot, setLocalePreference } from '@/i18n';
import { formatBytes } from '@renderer/utils/formatBytes';
import { OPENED_FILE_MAX_BYTES } from '@gugu/session-core/session-record/contract';
import { SessionConversation } from '@/mobile/agent-watch/SessionConversation';
import { emptyAgentWatchTimeline } from '@/mobile/agent-watch/agent-watch-store';
import { textFilePatch } from '@gugu/session-core/lib';
import { createReactHarness, renderWithAppProviders, clickElement } from '../../../../../../../tests/support/testHarness';
import { until } from '../../../../../../../tests/support/awaitCondition';
import '@/i18n/registerMainCatalog';
import '@/styles/tokens.css';
import '@renderer/index.css';

// A remote task's Edited card and a link in its reply name files of the task's working copy: on the phone both read that
// working copy on the task's machine, the Files App's own `filesRead` (phone-working-copy-file.ts), never the ledger of
// files the task opened itself — that ledger said 「这条会话还没打开过这个文件」 for a file the Files App opened fine.
const m = vi.hoisted(() => ({ call: vi.fn(), ledger: vi.fn() }));
vi.mock('@gugu/core/cloud/config', async original => ({ ...(await original<object>()), getSupabaseUrl: () => 'http://supabase.test.local', getSupabaseAnonKey: () => 'test-anon-key' }));
vi.mock('@renderer/features/settings/use-app-settings-key', () => ({ useAppSettingsKey: () => ({ value: { chatView: 'double' } }) }));
vi.mock('@/mobile/agent-watch/sessionpage-rpc', async original => ({
  ...(await original<object>()),
  fetchSessionOptions: vi.fn(() => new Promise(() => {})), setSessionOption: vi.fn(),
  machineRpc: vi.fn(() => ({})), fetchToolImage: vi.fn(), stopBackgroundTask: vi.fn(),
  fetchBackgroundTasks: vi.fn(async () => []), readOpenedFileChunk: m.ledger,
}));
vi.mock('@/components/appSlot/phoneProgramCall', async original => ({ ...(await original<object>()), callOnComputer: m.call }));
vi.mock('@renderer/features/extensions/installed-extensions-store', async original => {
  const real = await original<typeof import('@renderer/features/extensions/installed-extensions-store')>();
  return { ...real, installedExtensionsStore: new Proxy(real.installedExtensionsStore, { get: (target, key, receiver) => key === 'manifestFor'
    ? (id: string) => (id === 'workspace' ? { id: 'workspace', name: 'Files', version: '0.2.75' } : undefined)
    : Reflect.get(target, key, receiver) }) };
});
let harness: ReturnType<typeof createReactHarness>;
const initialLocale = getLocaleSnapshot().preference;
afterEach(() => { harness?.cleanup(); setLocalePreference(initialLocale); });

const contents = 'CURRENT-DISK-CONTENT-885';
const scenarios = [
  { name: 'read', answer: { size: contents.length, etag: 'current', data: btoa(contents) }, error: null, key: null },
  { name: 'too large', answer: { size: OPENED_FILE_MAX_BYTES + 1, etag: 'current', data: btoa(contents) }, error: null, key: 'tooLarge' },
  { name: 'machine refused', answer: null, error: Object.assign(new Error('Not permitted'), { code: 'denied' }), key: 'readFailed' },
  { name: 'network error', answer: null, error: new Error('Network disconnected'), key: 'readFailed' },
];
const entries = ['edit card', 'prose link'] as const;
it.each(scenarios.flatMap(scenario => (['zh-CN', 'en-US'] as const).flatMap(locale => entries.map(entry => ({ ...scenario, locale, entry })))))(
  '$locale: the $entry reads the working copy after history reload ($name)', async ({ answer, error, key, locale, entry }) => {
  setLocalePreference(locale);
  await page.viewport(390, 844);
  const sessionId = 'phone-edit-885', path = 'src/report.md', itemId = `${sessionId}:turn:s4:tool:edit`;
  m.ledger.mockReset();
  m.call.mockReset().mockImplementation(async () => {
    if (error) throw error;
    return answer;
  });
  for (let load = 0; load < 2; load++) {
    const timeline = emptyAgentWatchTimeline();
    timeline.turns = [{ id: `${sessionId}:turn:s4`, seq: 4, initiator: 'user', outcome: { kind: 'done' }, items: [
      { kind: 'message', id: 'owner', seq: 0, role: 'user', text: 'Edit report.md' },
      { kind: 'patch-tool-call', id: itemId, seq: 1, toolCallId: 'edit', title: 'Edit files', status: 'done', contentBlocks: [textFilePatch(path, 'before', 'after')] },
      { kind: 'message', id: 'answer', seq: 2, role: 'assistant', text: 'File updated. [report.md](src/report.md)' },
    ] }];
    harness = createReactHarness();
    harness.container.style.cssText = 'height:800px;width:390px;display:flex;flex-direction:column';
    await renderWithAppProviders(harness, <SessionConversation timeline={timeline} deviceId="host-device" sessionId={sessionId} agentName="Codex" nativeRecord
      sessionRuntime="acp" respondingItemId={null} onRespond={vi.fn()} onSend={vi.fn()} pendingSends={[]} sending={false} agentWorking={false}
      onStop={vi.fn()} stopping={false} onLoadOlder={vi.fn()} />, { contacts: {} });
    const file = () => harness.container.querySelector<HTMLElement>(entry === 'edit card'
      ? '[data-slot="file-change-summary"] [role="button"][title]' : 'a[href="src/report.md"]');
    await until('the phone renders the file entry', () => !!file());
    expect(file()!.hasAttribute('aria-disabled')).toBe(false);
    await clickElement(file()!);
    if (!key) {
      await until('the existing phone preview displays the working copy\'s bytes', () => document.body.textContent?.includes(contents) === true);
    } else {
      const refusal = String(getI18n().t(`agentWatch.output.${key}`, { ns: 'main', limit: formatBytes(OPENED_FILE_MAX_BYTES) }));
      await until('the preview has finished reading the refusal', () => !!document.querySelector('[data-file-selection]') && !document.querySelector('[data-testid="message-file-preview-loading"]'));
      expect(document.body.textContent).toContain(refusal);
      expect(document.body.textContent).not.toContain(contents);
    }
    // Never the opened-file ledger, and never "this session has not opened it".
    expect(document.body.textContent).not.toContain(locale === 'zh-CN' ? '这条会话还没打开过这个文件。' : "This session hasn't opened this file yet.");
    expect(m.ledger).not.toHaveBeenCalled();
    expect(m.call).toHaveBeenLastCalledWith(expect.objectContaining({ extensionId: 'workspace' }), expect.objectContaining({ id: sessionId, deviceId: 'host-device' }),
      'filesRead', expect.objectContaining({ ref: { workspace: `session:${sessionId}`, name: path }, offset: 0 }));
    harness.cleanup();
  }
});
