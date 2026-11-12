// #1925 (API 44) 内置「助理」面板资料页那几行的数(设备、连接应用、项目、能力)和开通「连应用」那一步的列表,按同一份读法读出来
// 交给主进程,给读得到助理的 App 当 `status.counts` / `status.connectors`(assistant-binding.ts)。
// 每一个数与内置那一行同源、同一个读缓存键:设备 = 壳的 deviceCount;连接应用 = 它家那台的集成 + 聊天渠道
// (assistantApplicationCounts);项目 = 左栏的项目(appState.sidebar.orderedProjects);能力 = 资源库 `capabilities` 那一卷的条目数。
// 每个数是一个读的状态:读到了(ready + 数)/ 还在读(loading)/ 读不到(unreadable,内置那一行说「暂时读不到资源」的时候)。❌ 拿 0 顶。
// 列表 = 它家那台的集成(与连接应用那一行同一份读),按 connectorOrder 排:名字、图标(宿主自带那一套画成 data: 图)、连没连。
// ❌ 账号名、❌ 连接里的任何东西。点一家 = `gugu.assistant.connect`,走内置那一步同一个 useOpenConnector(它家那台的连接框)。
// 挂在 App 面板那一格里(app-host-layer.tsx),只为读助理的 App 挂。
import { observer } from 'mobx-react-lite';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { integrationIcons } from '@gugu/session-plugins/integration-icons';
import { usePhoneRead } from '@/mobile/assistant/usePhoneRead';
import { assistantReadWaiting } from '@/components/assistant/useAssistantRead';
import { peekAssistantPanelIntegrations, readAssistantPanelIntegrations } from '@/components/assistant/assistant-panel-integrations';
import { useChatChannels } from '@/components/settings/channels/useChatChannels';
import { assistantApplicationCounts } from '@/components/assistant/assistant-app-connections';
import { AssistantLibraryCount, type LibraryCountRead } from '@/components/assistant/AssistantLibraryVolume';
import type { AssistantHomePlace } from '@/lib/assistantHome';
import { readAssistantShellBridge } from '@/lib/assistantShellBridge';
import { platform } from '@/platform';
import { appState } from '@renderer/lib/stores/app-state';
import { rpc } from '@renderer/lib/ipc';
import { log } from '@renderer/utils/logger';
import { useAssistantMachine } from '@renderer/features/assistant/assistant-data';
import { connectorOrder } from '@renderer/features/assistant/assistant-connector-order';
import { useOpenConnector } from '@renderer/features/assistant/assistant-home-integrations';
import { useAssistantShell } from '@renderer/features/assistant/assistant-shell';
import {
  appAssistantConnectorSchema,
  appAssistantConnectorsOf,
  appAssistantCountsOf,
  type AppAssistantConnector,
  type AppAssistantReadState,
} from '@shared/extensions/assistant-binding';

type Icon = (typeof integrationIcons)[string];
const LOADING = { state: 'loading' } as const;
const UNREADABLE = { state: 'unreadable' } as const;
const ready = <T,>(value: T) => ({ state: 'ready' as const, value });
const fromLibrary = (read: LibraryCountRead): AppAssistantReadState<number> => (typeof read === 'number' ? ready(read) : read === 'failed' ? UNREADABLE : LOADING);

/** Text as a `data:` URL of its own bytes (UTF-8). */
function dataUrl(mime: string, text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (let at = 0; at < bytes.length; at += 0x8000) binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return `data:${mime};base64,${btoa(binary)}`;
}
const IMAGE = /^data:image\/(?:svg\+xml|png|webp);base64,/;
/** The host's own art for a service, as an image an App can draw (the variant the built-in row draws at 30px). */
export function connectorIconOf(icon: Icon | undefined): AppAssistantConnector['icon'] {
  if (!icon?.variants.length) return null;
  const variant = [...icon.variants].sort((a, b) => (b.minSize ?? 0) - (a.minSize ?? 0)).find((item) => (item.minSize ?? 0) <= 30) ?? icon.variants[0]!;
  const art = (text: string | undefined) => (!text ? null : icon.kind === 'svg' ? dataUrl('image/svg+xml', text) : IMAGE.test(text) ? text : null);
  const light = art(variant.light);
  return light ? { light, dark: art(variant.dark), invertInDark: icon.invertInDark === true } : null;
}

/** The connect step's rows, in its order; a row the contract cannot carry is left out (logged), never the whole list. */
function connectorsOf(items: readonly { id: string; name: string }[], configured: Record<string, unknown>, language: string): AppAssistantConnector[] {
  const rows: AppAssistantConnector[] = [];
  for (const item of connectorOrder(items, language)) {
    const row = appAssistantConnectorSchema.safeParse({ id: item.id, name: item.name, icon: connectorIconOf(integrationIcons[item.id]), connected: !!configured[item.id] });
    if (row.success) rows.push(row.data);
    else log.warn('A connector left out of the App\'s list', { id: item.id });
  }
  return rows;
}

/** The connect dialog opener of the assistant's home on screen now (`gugu.assistant.connect`). */
let opener: ((id: string) => void) | null = null;
/** The list last handed to main, and whose: a connect is only for a service in it, for that account. */
let listed: { ownerId: string; ids: ReadonlySet<string> } | null = null;

/** Host action `openAssistantConnector`: main checked the account, the binding and the list; this window checks them again. */
export function openAssistantConnector(id: string, ownerId: string): void {
  const shell = readAssistantShellBridge()?.getSnapshot();
  if (!shell || shell.ownerId !== ownerId || shell.assistantState !== 'found' || !shell.assistant) throw new Error('This window does not show that account\'s assistant now');
  if (!opener) throw new Error('The assistant\'s panel is not on screen');
  // Until the page has read and handed over the new account's list, the opener may still be the last account's home.
  if (listed?.ownerId !== ownerId || !listed.ids.has(id)) throw new Error('No such connector in the list');
  opener(id);
}

/** Tests only. */
export function resetAssistantAppCountsForTest(): void {
  pushed = '';
  opener = null;
  listed = null;
}

let pushed = '';

export const AssistantAppCountsSource = observer(function AssistantAppCountsSource() {
  const { i18n } = useTranslation('assistant');
  const shell = useAssistantShell();
  const assistantId = shell?.assistantState === 'found' ? shell.assistant?.id ?? null : null;
  const home = assistantId ? shell?.home ?? null : null;
  const machine = useAssistantMachine(assistantId, shell?.chatId ?? null, home, shell?.chatReadFailed);
  const panel = machine.data?.panel;
  // The panel's read itself failed (no data and not still coming): every read through it is unreadable, not loading.
  const machineFailed = !machine.data && !!machine.error && !machine.isLoading;
  // As the profile page reads them (assistant-profile.tsx ProfileHome), under the same key.
  const apps = usePhoneRead(panel && assistantId ? `profile-apps|${assistantId}` : null, () => readAssistantPanelIntegrations(panel!, i18n.language),
    'read application connections', undefined, () => peekAssistantPanelIntegrations(panel, i18n.language));
  const chat = useChatChannels();
  // Its collection not prepared yet (setup finishing) is still coming: loading, never unreadable.
  const appsFailed = apps.state === 'error' && !assistantReadWaiting(apps.error);
  const [capabilities, setCapabilities] = useState<LibraryCountRead>('loading');
  const onCount = useCallback((read: LibraryCountRead) => setCapabilities(read), []);
  const counts = appAssistantCountsOf({
    devices: shell?.deviceCount === undefined ? LOADING : ready(shell.deviceCount),
    connectedApps: machineFailed || appsFailed || chat.status === 'failed' ? UNREADABLE
      : apps.state === 'ok' && (chat.status === 'ready' || chat.status === 'absent')
        ? ready(assistantApplicationCounts(apps.data.items, apps.data.configured, apps.data.statuses, chat.list)) : LOADING,
    // The desktop's sidebar holds them; a window without the agent runtime has no such list to count.
    projects: platform.capabilities.agentRuntime ? ready(appState.sidebar.orderedProjects.length) : UNREADABLE,
    capabilities: machineFailed ? UNREADABLE : fromLibrary(capabilities),
  });
  const connectors = appAssistantConnectorsOf(machineFailed || appsFailed ? UNREADABLE
    : apps.state === 'ok' ? ready(connectorsOf(apps.data.items, apps.data.configured, i18n.language)) : LOADING);
  const ownerId = shell?.ownerId ?? null;
  const key = ownerId && assistantId ? JSON.stringify([ownerId, counts, connectors]) : '';
  useEffect(() => {
    if (!key || key === pushed || !ownerId) return;
    pushed = key;
    listed = { ownerId, ids: new Set(connectors.state === 'ready' ? connectors.value.map((row) => row.id) : []) };
    void rpc.extensions.assistantCountsChanged({ ownerId, counts, connectors }).then((result) => {
      if (!result.success) {
        if (pushed === key) pushed = '';
        log.warn('Assistant counts for Apps refused', { error: result.error });
      }
    }, (error: unknown) => {
      if (pushed === key) pushed = '';
      log.warn('Assistant counts for Apps failed', { error: String(error) });
    });
    // `counts` and `connectors` are in `key`.
  }, [key, ownerId]);
  return (
    <>
      <AssistantLibraryCount key={assistantId ?? ''} machine={machine.data} kind="capabilities" assistantId={assistantId ?? ''} onCount={onCount} />
      {ownerId && home ? <ConnectorOpener key={`${ownerId}|${home.deviceId}`} home={home} /> : null}
    </>
  );
});

/** The built-in connect step's click, held for `openAssistantConnector` while the panel is on screen. */
function ConnectorOpener({ home }: { home: AssistantHomePlace }) {
  const open = useOpenConnector(home);
  useEffect(() => {
    const mine = (id: string) => open(id);
    opener = mine;
    return () => {
      if (opener === mine) opener = null;
    };
  }, [open]);
  return null;
}
