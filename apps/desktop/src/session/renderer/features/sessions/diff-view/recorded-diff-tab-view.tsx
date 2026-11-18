import { mountRecordedFileDiff } from '@gugu/session-chat-ui';
import { observer } from 'mobx-react-lite';
import { useLayoutEffect, useRef, useState } from 'react';
import type { TabContentProps } from '@renderer/features/tabs/core/tab-provider';
import { getSharedChatContext } from '@renderer/lib/chat/shared-chat-context';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { fileBaseName } from '../stores/workspace-path';
import type { RecordedDiffTabResource } from './recorded-diff-tab-provider';

function RecordedDiffView({ change }: Pick<RecordedDiffTabResource, 'change'>) {
  const { translate } = useSessionMessages();
  const parent = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<'available' | 'partial' | 'unavailable'>('available');

  useLayoutEffect(() => {
    if (!parent.current) return;
    const view = mountRecordedFileDiff(parent.current, getSharedChatContext(), change);
    setStatus(view.available ? (view.partial ? 'partial' : 'available') : 'unavailable');
    return view.dispose;
  }, [change]);

  return (
    <section className="flex h-full min-h-0 flex-col text-foreground" aria-label={translate('diff.recordedChanges')}>
      <header className="flex h-10 shrink-0 items-center gap-2 border-b px-3 text-sm">
        <span className="truncate font-medium" title={change.path}>{fileBaseName(change.path)}</span>
        <span className="text-foreground-muted shrink-0">{translate('diff.recordedChanges')}</span>
      </header>
      <div className="min-h-0 flex-1 overflow-auto">
        {status !== 'available' && <p className="text-foreground-muted px-3 py-3 text-sm">
          {translate(status === 'partial' ? 'diff.recordedPartial' : 'diff.recordedUnavailable')}
        </p>}
        <div ref={parent} />
      </div>
    </section>
  );
}

export const TabContent = observer(function RecordedDiffTabContent({ host }: TabContentProps) {
  const tab = host.resolvedTabs.find(tab => tab.kind === 'recorded-diff' && tab.isActive);
  if (!tab) return null;
  return <RecordedDiffView key={tab.tabId} change={(tab.resource as RecordedDiffTabResource).change} />;
});
