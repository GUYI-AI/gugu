import { mountRecordedFileDiff, type RecordedDiffAnnotationSlot } from '@gugu/session-chat-ui';
import { observer } from 'mobx-react-lite';
import { createPortal } from 'react-dom';
import { Plus } from '@/lib/icons';
import { useLayoutEffect, useRef, useState } from 'react';
import type { TabContentProps } from '@renderer/features/tabs/core/tab-provider';
import { getSharedChatContext } from '@renderer/lib/chat/shared-chat-context';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { AnnotationEditor } from '../annotations/annotation-editor';
import { sessionAnnotations } from '../annotations/session-annotations';
import { MicroLabel } from '@renderer/lib/ui/label';
import { panelHeaderBarClass } from '@renderer/lib/ui/panel-header-bar';
import type { RecordedDiffTabResource } from './recorded-diff-tab-provider';

const RecordedDiffView = observer(function RecordedDiffView({ change }: Pick<RecordedDiffTabResource, 'change'>) {
  const { translate } = useSessionMessages();
  const parent = useRef<HTMLDivElement>(null);
  const draft = sessionAnnotations.forSession(change.sessionId);
  const [slots, setSlots] = useState<readonly RecordedDiffAnnotationSlot[]>([]);
  const [open, setOpen] = useState<RecordedDiffAnnotationSlot | null>(null);
  const existing = draft.items.filter(item => item.kind === 'diff').filter(item => item.turnId === change.turnId && item.path === change.path);
  const byRow = new Map(existing.map(item => [`${item.patchIndex}:${item.rowIndex}`, item]));
  const close = () => setOpen(null);
  const [status, setStatus] = useState<'available' | 'partial' | 'unavailable'>('available');

  useLayoutEffect(() => {
    if (!parent.current) return;
    const next: RecordedDiffAnnotationSlot[] = [];
    const view = mountRecordedFileDiff(parent.current, getSharedChatContext(), change, slot => next.push(slot));
    setSlots(next);
    setOpen(null);
    setStatus(view.available ? (view.partial ? 'partial' : 'available') : 'unavailable');
    return view.dispose;
  }, [change]);

  return (
    <section className="flex h-full min-h-0 flex-col text-foreground" aria-label={translate('diff.recordedChanges')}>
      {/* Same frame as the working-tree diff page: the tab names the file, the bar names the source. */}
      <div className={panelHeaderBarClass}><MicroLabel>{translate('diff.recordedChanges')}</MicroLabel></div>
      <div className="min-h-0 flex-1 overflow-auto">
        {status !== 'available' && <p className="text-foreground-muted px-3 py-3 text-sm">
          {translate(status === 'partial' ? 'diff.recordedPartial' : 'diff.recordedUnavailable')}
        </p>}
        <div ref={parent} />
        {slots.map(slot => {
          const key = `${slot.patchIndex}:${slot.rowIndex}`;
          const item = byRow.get(key);
          return createPortal(item ? <span data-annotation-marker={item.number} className="inline-flex size-5 items-center justify-center rounded-full bg-[var(--live-light)] text-xs text-[var(--color-white)]">{item.number}</span>
            : <button type="button" data-diff-add-annotation aria-label={translate('annotations.addLine')}
              className="inline-flex size-5 items-center justify-center rounded text-foreground-muted hover:bg-muted hover:text-foreground"
              onClick={() => setOpen(slot)}><Plus className="size-3.5" /></button>, slot.control, key);
        })}
        {open && createPortal(<div className="sticky left-0 w-80 max-w-full px-2 py-2">
          <AnnotationEditor key={`${open.patchIndex}:${open.rowIndex}`}
            number={draft.nextAnnotationNumber}
            onSave={value => {
              draft.add({ kind: 'diff', path: change.path, turnId: change.turnId,
                patchIndex: open.patchIndex, rowIndex: open.rowIndex, oldLine: open.oldLine,
                newLine: open.newLine, text: open.text, annotation: value });
              close();
            }} onCancel={close} />
        </div>, open.editor)}
      </div>
    </section>
  );
});

export const TabContent = observer(function RecordedDiffTabContent({ host }: TabContentProps) {
  const tab = host.resolvedTabs.find(tab => tab.kind === 'recorded-diff' && tab.isActive);
  if (!tab) return null;
  return <RecordedDiffView key={tab.tabId} change={(tab.resource as RecordedDiffTabResource).change} />;
});
