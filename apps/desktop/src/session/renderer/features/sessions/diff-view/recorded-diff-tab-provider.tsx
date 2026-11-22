import { FileMark } from '@gugu/session-ui/file-mark';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import type { TabProvider, TabResource } from '@renderer/features/tabs/core/tab-provider';
import { createTabProvider } from '@renderer/features/tabs/core/tab-provider-registry';
import { registeredTabView } from '@renderer/features/tabs/core/tab-views';
import { GenericTabDragPreview, GenericTabItem } from '@renderer/features/tabs/tab-bar/generic-tab-item';
import type { RecordedFileChange } from '@gugu/session-chat-ui';
import { fileBaseName } from '../stores/workspace-path';

type RecordedDiffState = RecordedFileChange & { sessionId: string };
export type RecordedDiffTabResource = TabResource & { readonly change: RecordedDiffState };

export const recordedDiffTabProvider: TabProvider<'recorded-diff', RecordedDiffState, RecordedDiffTabResource> =
  createTabProvider({
    kind: 'recorded-diff',
    resourceKey: ({ sessionId, turnId, path }) => JSON.stringify([sessionId, turnId, path]),
    // The transcript already owns these bytes. Opening a diff should not copy them into pane snapshots.
    isPersistent: () => false,
    initialize: entry => ({ get change() { return entry.state; }, dispose() {} }),
    dispose() {},
    TabBarItem: function RecordedDiffTabItem({ tab, host, ctx }) {
      const { translate } = useSessionMessages();
      const { path } = tab.resource.change;
      const fileName = fileBaseName(path);
      return <GenericTabItem tab={tab} host={host} ctx={ctx} label={fileName} tooltip={path}
        hint={translate('diff.recordedChanges')} preSlot={<span className="shrink-0"><FileMark name={fileName} size={12} /></span>} />;
    },
    TabBarItemDragPreview: ({ tab }) => <GenericTabDragPreview label={fileBaseName(tab.resource.change.path)} />,
    TabContent: registeredTabView('recorded-diff'),
  });
