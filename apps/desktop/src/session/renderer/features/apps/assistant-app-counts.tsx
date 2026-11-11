// #1925 (API 44) 内置「助理」面板资料页那几行的数(设备、连接应用、项目、能力),按同一份读法读出来交给主进程,
// 给读得到助理的 App 当 `status.counts`(assistant-binding.ts)。只交数字:❌ 项目名、❌ 能力内容、❌ 设备或应用是谁。
// 每一个数与内置那一行同源、同一个读缓存键:设备 = 壳的 deviceCount;连接应用 = 它家那台的集成 + 聊天渠道
// (assistantApplicationCounts);项目 = 左栏的项目(appState.sidebar.orderedProjects);能力 = 资源库 `capabilities` 那一卷的条目数。
// 读不到 / 还在读 = null(❌ 当 0)。挂在 App 面板那一格里(app-host-layer.tsx),只为读助理的 App 挂。
import { observer } from 'mobx-react-lite';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { usePhoneRead } from '@/mobile/assistant/usePhoneRead';
import { peekAssistantPanelIntegrations, readAssistantPanelIntegrations } from '@/components/assistant/assistant-panel-integrations';
import { useChatChannels } from '@/components/settings/channels/useChatChannels';
import { assistantApplicationCounts } from '@/components/assistant/assistant-app-connections';
import { AssistantLibraryCount } from '@/components/assistant/AssistantLibraryVolume';
import { platform } from '@/platform';
import { appState } from '@renderer/lib/stores/app-state';
import { rpc } from '@renderer/lib/ipc';
import { log } from '@renderer/utils/logger';
import { useAssistantMachine } from '@renderer/features/assistant/assistant-data';
import { useAssistantShell } from '@renderer/features/assistant/assistant-shell';
import { appAssistantCountsOf } from '@shared/extensions/assistant-binding';

let pushed = '';

export const AssistantAppCountsSource = observer(function AssistantAppCountsSource() {
  const { i18n } = useTranslation('assistant');
  const shell = useAssistantShell();
  const assistantId = shell?.assistantState === 'found' ? shell.assistant?.id ?? null : null;
  const home = assistantId ? shell?.home ?? null : null;
  const machine = useAssistantMachine(assistantId, shell?.chatId ?? null, home, shell?.chatReadFailed);
  const panel = machine.data?.panel;
  // As the profile page reads them (assistant-profile.tsx ProfileHome), under the same key.
  const apps = usePhoneRead(panel && assistantId ? `profile-apps|${assistantId}` : null, () => readAssistantPanelIntegrations(panel!, i18n.language),
    'read application connections', undefined, () => peekAssistantPanelIntegrations(panel, i18n.language));
  const chat = useChatChannels();
  const [capabilities, setCapabilities] = useState<number | null>(null);
  const counts = appAssistantCountsOf({
    devices: shell?.deviceCount,
    connectedApps: apps.state === 'ok' && (chat.status === 'ready' || chat.status === 'absent')
      ? assistantApplicationCounts(apps.data.items, apps.data.configured, apps.data.statuses, chat.list) : null,
    projects: platform.capabilities.agentRuntime ? appState.sidebar.orderedProjects.length : null,
    capabilities,
  });
  const ownerId = shell?.ownerId ?? null;
  const key = ownerId && assistantId ? JSON.stringify([ownerId, counts]) : '';
  useEffect(() => {
    if (!key || key === pushed || !ownerId) return;
    pushed = key;
    void rpc.extensions.assistantCountsChanged({ ownerId, counts }).then((result) => {
      if (!result.success) {
        if (pushed === key) pushed = '';
        log.warn('Assistant counts for Apps refused', { error: result.error });
      }
    }, (error: unknown) => {
      if (pushed === key) pushed = '';
      log.warn('Assistant counts for Apps failed', { error: String(error) });
    });
    // `counts` is in `key`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, ownerId]);
  return <AssistantLibraryCount key={assistantId ?? ''} machine={machine.data} kind="capabilities" assistantId={assistantId ?? ''} onCount={setCapabilities} />;
});
