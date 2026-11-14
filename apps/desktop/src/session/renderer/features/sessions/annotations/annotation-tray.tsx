import { MessageSquare, Pencil, Trash2 } from '@/lib/icons';
import { observer } from 'mobx-react-lite';
import { useEffect, useState } from 'react';
import { Button } from '@renderer/lib/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/lib/ui/popover';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { sessionAnnotations } from './session-annotations';

export const AnnotationTray = observer(function AnnotationTray({ sessionId, onSend, enabled, onRemove }: {
  sessionId: string; onSend: () => void; enabled: boolean; onRemove?: (id: string) => void;
}) {
  const draft = sessionAnnotations.forSession(sessionId);
  const { translate } = useSessionMessages();
  const [editing, setEditing] = useState<string | null>(null);
  const [text, setText] = useState('');
  useEffect(() => enabled ? draft.bindSend(onSend) : undefined, [draft, onSend, enabled]);
  if (!draft.items.length) return null;
  return (
    <div data-composer-annotations className="flex px-4 pt-4">
      <Popover>
        <PopoverTrigger render={<Button type="button" variant="outline" size="sm" className="gap-2 rounded-xl" />}>
          <MessageSquare className="size-4" />{translate('annotations.count', { count: draft.items.length })}
        </PopoverTrigger>
        <PopoverContent side="top" align="start" className="max-h-[60vh] w-80 max-w-[calc(100vw-32px)] gap-0 overflow-y-auto p-0">
          {draft.items.map(item => (
            <div key={item.id} className="flex flex-col gap-2 border-b border-border px-4 py-4 last:border-b-0">
              <div className="flex min-w-0 items-center gap-2 text-xs text-foreground-muted">
                <span className="shrink-0 tabular-nums">{item.number}</span>
                <span className="min-w-0 flex-1 truncate" title={item.kind === 'file' ? item.path : item.url}>
                  {item.kind === 'file' ? `${item.path.split(/[\\/]/).pop()}:${item.startLine}-${item.endLine}` : item.url}
                </span>
                {item.kind === 'browser' && <Button type="button" variant="ghost" size="icon" className="size-7" aria-label={translate('annotations.edit')}
                  onClick={() => { setEditing(item.id); setText(item.annotation); }}><Pencil className="size-3.5" /></Button>}
                <Button type="button" variant="ghost" size="icon" className="size-7" aria-label={translate('annotations.delete')}
                  onClick={() => { draft.remove(item.id); onRemove?.(item.id); }}><Trash2 className="size-3.5" /></Button>
              </div>
              <blockquote className="line-clamp-3 whitespace-pre-wrap text-xs text-foreground-muted">{item.text}</blockquote>
              {editing === item.id ? (
                <form className="flex flex-col gap-2" onSubmit={event => { event.preventDefault(); draft.update(item.id, text); setEditing(null); }}>
                  <textarea autoFocus aria-label={translate('annotations.comment')} value={text} onChange={event => setText(event.target.value)}
                    className="min-h-16 w-full resize-y rounded-lg border border-border bg-background p-2 text-sm outline-none" />
                  <div className="flex justify-end gap-2">
                    <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(null)}>{translate('annotations.cancel')}</Button>
                    <Button type="submit" size="sm">{translate('annotations.comment')}</Button>
                  </div>
                </form>
              ) : <p className="whitespace-pre-wrap break-words text-sm">{item.annotation}</p>}
            </div>
          ))}
        </PopoverContent>
      </Popover>
    </div>
  );
});
