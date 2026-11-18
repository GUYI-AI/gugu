import { Check, Trash2, X } from '@/lib/icons';
import { useState, type CSSProperties } from 'react';
import { Button } from '@renderer/lib/ui/button';
import { useSessionMessages } from '@renderer/localization/use-session-messages';

/** The anchored editor used for a new selection or an existing numbered annotation. */
export function AnnotationEditor({ number, initialValue = '', busy = false, onSave, onCancel, onRemove }: {
  number: number;
  initialValue?: string;
  busy?: boolean;
  onSave: (text: string) => void;
  onCancel: () => void;
  onRemove?: () => void;
}) {
  const { translate } = useSessionMessages();
  const [text, setText] = useState(initialValue);
  return (
    <form data-annotation-editor className="flex min-h-10 w-full min-w-0 cursor-auto items-center gap-2 rounded-xl border border-border bg-background px-2 py-1 shadow-lift"
      onPointerDown={event => event.stopPropagation()} onPointerUp={event => event.stopPropagation()}
      onKeyDown={event => {
        if (event.nativeEvent.isComposing || event.keyCode === 229) {
          if (event.key === 'Enter') event.preventDefault();
          return;
        }
        if (event.key === 'Escape') { event.stopPropagation(); onCancel(); }
      }}
      onSubmit={event => { event.preventDefault(); if (!busy) onSave(text.trim()); }}>
      <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-[var(--live-light)] text-xs font-medium text-[var(--color-white)]">{number}</span>
      <input autoFocus type="text" value={text} onChange={event => setText(event.target.value)}
        placeholder={translate('annotations.placeholder')} aria-label={translate('annotations.comment')}
        className="min-w-0 flex-1 bg-transparent px-1 text-sm text-foreground outline-none" />
      {onRemove && <Button type="button" variant="ghost" size="icon" className="size-7 shrink-0" disabled={busy}
        aria-label={translate('annotations.delete')} title={translate('annotations.delete')} onClick={onRemove}><Trash2 className="size-3.5" /></Button>}
      <Button type="button" variant="ghost" size="icon" className="size-7 shrink-0" disabled={busy}
        aria-label={translate('annotations.cancel')} title={translate('annotations.cancel')} onClick={onCancel}><X className="size-3.5" /></Button>
      <Button type="submit" size="icon" className="size-7 shrink-0 rounded-full" disabled={busy}
        aria-label={translate('annotations.save')} title={translate('annotations.save')}><Check className="size-3.5" /></Button>
    </form>
  );
}

export function AnnotationMarker({ number, onClick, style, className = '' }: {
  number: number;
  onClick: () => void;
  style?: CSSProperties;
  className?: string;
}) {
  const { translate } = useSessionMessages();
  return <button type="button" data-annotation-marker={number} aria-label={translate('annotations.editMarker', { number })}
    className={`pointer-events-auto flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-full bg-[var(--live-light)] text-xs text-[var(--color-white)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 ${className}`}
    style={style} onPointerDown={event => { event.preventDefault(); event.stopPropagation(); }} onPointerUp={event => event.stopPropagation()} onClick={onClick}>
    {number}
  </button>;
}
