import { mountRecordedFileDiff, type RecordedDiffAnnotationSlot } from '@gugu/session-chat-ui';
import { observer } from 'mobx-react-lite';
import { createPortal } from 'react-dom';
import { Plus } from '@/lib/icons';
import { useLayoutEffect, useRef, useState } from 'react';
import type { TabContentProps } from '@renderer/features/tabs/core/tab-provider';
import { getSharedChatContext } from '@renderer/lib/chat/shared-chat-context';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { AnnotationEditor, AnnotationMarker } from '../annotations/annotation-editor';
import { sessionAnnotations } from '../annotations/session-annotations';
import { fileBaseName } from '../stores/workspace-path';
import type { RecordedDiffTabResource } from './recorded-diff-tab-provider';

const RecordedDiffView = observer(function RecordedDiffView({ change }: Pick<RecordedDiffTabResource, 'change'>) {
  const { translate } = useSessionMessages();
  const parent = useRef<HTMLDivElement>(null);
  const draft = sessionAnnotations.forSession(change.sessionId);
  const [slots, setSlots] = useState<readonly RecordedDiffAnnotationSlot[]>([]);
  const [open, setOpen] = useState<RecordedDiffAnnotationSlot | null>(null);
  const existing = draft.items.filter(item => item.kind === 'diff').filter(item => item.turnId === change.turnId && item.path === change.path);
  const byRow = new Map(existing.map(item => [`${item.patchIndex}:${item.rowIndex}`, item]));
  const editing = open && byRow.get(`${open.patchIndex}:${open.rowIndex}`);
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
      <header className="flex h-10 shrink-0 items-center gap-2 border-b px-3 text-sm">
        <span className="truncate font-medium" title={change.path}>{fileBaseName(change.path)}</span>
        <span className="text-foreground-muted shrink-0">{translate('diff.recordedChanges')}</span>
      </header>
      <div className="min-h-0 flex-1 overflow-auto">
        {status !== 'available' && <p className="text-foreground-muted px-3 py-3 text-sm">
          {translate(status === 'partial' ? 'diff.recordedPartial' : 'diff.recordedUnavailable')}
        </p>}
        <div ref={parent} />
        {slots.map(slot => {
          const key = `${slot.patchIndex}:${slot.rowIndex}`;
          const item = byRow.get(key);
          return createPortal(item ? <AnnotationMarker number={item.number} className="!size-5" onClick={() => setOpen(slot)} />
            : <button type="button" data-diff-add-annotation aria-label={translate('annotations.addLine')}
              className="inline-flex size-5 items-center justify-center rounded text-foreground-muted hover:bg-muted hover:text-foreground"
              onClick={() => setOpen(slot)}><Plus className="size-3.5" /></button>, slot.control, key);
        })}
        {open && createPortal(<div className="sticky left-0 w-80 max-w-full px-2 py-2">
          <AnnotationEditor key={editing?.id ?? `${open.patchIndex}:${open.rowIndex}`}
            number={editing?.number ?? draft.nextAnnotationNumber} initialValue={editing?.annotation}
            onSave={value => {
              if (editing) draft.update(editing.id, value);
              else draft.add({ kind: 'diff', path: change.path, turnId: change.turnId,
                patchIndex: open.patchIndex, rowIndex: open.rowIndex, oldLine: open.oldLine,
                newLine: open.newLine, text: open.text, annotation: value });
              close();
            }} onCancel={close} onRemove={editing ? () => { draft.remove(editing.id); close(); } : undefined} />
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
