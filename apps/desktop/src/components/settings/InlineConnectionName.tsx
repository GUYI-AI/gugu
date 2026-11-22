import { useEffect, useRef, useState } from 'react';
import { Pencil } from '@/lib/icons';
import { Button } from '@renderer/lib/ui/button';
import { Input } from '@renderer/lib/ui/input';
import { useSessionMessages } from '@renderer/localization/use-session-messages';

export function InlineConnectionName({ name, busy, onRename }: { name: string; busy: boolean; onRename: (name: string) => Promise<void> }) {
  const { translate } = useSessionMessages();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const [saving, setSaving] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { if (editing) { input.current?.focus(); input.current?.select(); } }, [editing]);
  const save = async () => {
    if (saving || !draft.trim()) return;
    if (draft.trim() === name) { setEditing(false); return; }
    setSaving(true);
    try { await onRename(draft.trim()); setEditing(false); }
    catch { /* The provider's existing error line retains the failure; the draft stays editable. */ }
    finally { setSaving(false); }
  };
  if (editing) return <Input ref={input} value={draft} maxLength={80} disabled={busy || saving} className="h-8 w-40"
    aria-label={translate('task.rename')} onChange={event => setDraft(event.target.value)} onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); setEditing(false); }
      else if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); void save(); }
    }} />;
  return <Button type="button" variant="ghost" className="gg-model-name" aria-label={`${translate('task.rename')} ${name}`} title={name} disabled={busy}
    onClick={() => { setDraft(name); setEditing(true); }}><span className="truncate">{name}</span><Pencil className="size-3.5" aria-hidden /></Button>;
}
