import type { AnnotationConversation } from '@shared/browser-annotation';
import { useAuth } from '@/store/auth';
import { MessageSquare, Pencil, Trash2, X } from '@/lib/icons';
import { observer } from 'mobx-react-lite';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@renderer/lib/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/lib/ui/popover';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { AnnotationEditor } from './annotation-editor';
import { annotationPlace, sessionAnnotations, type BrowserAnnotationSelection } from './session-annotations';
import { annotationTargetName } from '@gugu/session-core/acp/client';

function AnnotationThumbnail({ screenshot, rect, viewport }: BrowserAnnotationSelection) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let cancelled = false;
    void createImageBitmap(screenshot).then(bitmap => {
      try {
        const surface = canvas.current;
        const context = surface?.getContext('2d');
        if (cancelled || !surface || !context) return;
        const scaleX = bitmap.width / viewport.width;
        const scaleY = bitmap.height / viewport.height;
        const x = Math.max(0, rect.x * scaleX);
        const y = Math.max(0, rect.y * scaleY);
        const width = Math.min(bitmap.width, (rect.x + rect.width) * scaleX) - x;
        const height = Math.min(bitmap.height, (rect.y + rect.height) * scaleY) - y;
        if (width <= 0 || height <= 0) return;
        const scale = Math.min(surface.width / width, surface.height / height);
        const drawnWidth = width * scale;
        const drawnHeight = height * scale;
        context.clearRect(0, 0, surface.width, surface.height);
        context.drawImage(bitmap, x, y, width, height, (surface.width - drawnWidth) / 2, (surface.height - drawnHeight) / 2, drawnWidth, drawnHeight);
      } finally {
        bitmap.close();
      }
    }).catch(() => { /* The rest of the annotation is still visible if an image fails to decode. */ });
    return () => { cancelled = true; };
  }, [screenshot, rect, viewport]);
  return <canvas ref={canvas} width={96} height={72} aria-hidden="true" className="h-9 w-12 shrink-0 rounded border border-border bg-muted" />;
}

export const AnnotationTray = observer(function AnnotationTray({ conversation, onSend, enabled, onRemove }: {
  conversation: AnnotationConversation; onSend: () => void; enabled: boolean; onRemove?: (id: string) => void;
}) {
  const { user } = useAuth();
  const draft = sessionAnnotations.forConversation(conversation, user?.id);
  const { translate } = useSessionMessages();
  const [editing, setEditing] = useState<string | null>(null);
  useEffect(() => enabled ? draft.bindSend(onSend) : undefined, [draft, onSend, enabled]);
  useEffect(() => onRemove ? draft.bindRemove(onRemove) : undefined, [draft, onRemove]);
  if (!draft.items.length) return null;
  return (
    <div data-composer-annotations className="col-span-full flex min-w-0">
      <div className="inline-flex items-center rounded-xl border border-border">
        <Popover>
          <PopoverTrigger render={<Button type="button" variant="ghost" size="sm" className="gap-2 rounded-l-xl rounded-r-none" />}>
            <MessageSquare className="size-4" />{translate('annotations.count', { count: draft.items.length })}
          </PopoverTrigger>
          <PopoverContent side="top" align="start" className="max-h-[60vh] w-80 max-w-[calc(100vw-32px)] gap-0 overflow-y-auto p-0">
            {draft.items.map(item => {
              const place = annotationPlace(item);
              const position = item.kind === 'browser' ? item.elementTag ? `<${item.elementTag}>` : item.selector ?? translate('annotations.region')
                : [item.oldLine === undefined ? null : translate('annotations.oldLine', { line: item.oldLine }),
                  item.newLine === undefined ? null : translate('annotations.newLine', { line: item.newLine })].filter(Boolean).join(' · ');
              return (
              <div key={item.id} className="flex flex-col gap-2 border-b border-border px-3 py-3 last:border-b-0">
                <div className="flex min-w-0 items-start gap-2 text-xs text-foreground-muted">
                  {item.kind === 'browser' && <AnnotationThumbnail {...item} />}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2">
                      <span className="shrink-0 tabular-nums">{item.number}</span>
                      <span className="min-w-0 truncate" title={place}>{annotationTargetName(place)}</span>
                    </div>
                    <span className="block truncate">{position}</span>
                  </div>
                  {item.kind === 'browser' && <Button type="button" variant="ghost" size="icon" className="size-7" aria-label={translate('annotations.edit')}
                    onClick={() => setEditing(item.id)}><Pencil className="size-3.5" /></Button>}
                  <Button type="button" variant="ghost" size="icon" className="size-7" aria-label={translate('annotations.delete')}
                    onClick={() => draft.remove(item.id)}><Trash2 className="size-3.5" /></Button>
                </div>
                {item.text && <blockquote className="line-clamp-3 whitespace-pre-wrap text-xs text-foreground-muted">{item.text}</blockquote>}
                {item.kind === 'browser' && editing === item.id ? (
                  <AnnotationEditor number={item.number} initialValue={item.annotation}
                    onSave={value => { draft.update(item.id, value); setEditing(null); }} onCancel={() => setEditing(null)} />
                ) : <p className="whitespace-pre-wrap break-words text-sm">{item.annotation}</p>}
              </div>
              );
            })}
          </PopoverContent>
        </Popover>
        <Button type="button" size="icon" variant="ghost" className="size-7 rounded-l-none rounded-r-xl"
          title={translate('annotations.deleteAll')} aria-label={translate('annotations.deleteAll')} onClick={draft.clear}>
          <X className="size-3.5" />
        </Button>
      </div>
    </div>
  );
});
