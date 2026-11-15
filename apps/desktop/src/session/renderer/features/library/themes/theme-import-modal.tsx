import { useEffect, useRef, useState } from 'react';
import type { BaseModalProps } from '@renderer/lib/modal/modal-provider';
import { toast } from '@renderer/lib/hooks/use-toast';
import { importThemeFromLink, ThemeImportError } from '@renderer/lib/theme/theme-pack-import';
import { saveImportedThemePack } from '@renderer/lib/theme/theme-pack-store';
import { Button } from '@renderer/lib/ui/button';
import { ConfirmButton } from '@renderer/lib/ui/confirm-button';
import { DialogContentArea, DialogFooter, DialogHeader, DialogTitle } from '@renderer/lib/ui/dialog';
import { Input } from '@renderer/lib/ui/input';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { rendererLogger } from '@/lib/log';

const log = rendererLogger('theme/import');

/** 「从链接导入」:贴链接 → 本机拉取、只取颜色 → 存进本机的主题清单。导入不等于应用,导入完在列表里点它才换。 */
export function ThemeImportModal({ onSuccess, onClose }: BaseModalProps<void>) {
  const { translate } = useSessionMessages();
  const [link, setLink] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 框关了就撤掉还在路上的下载:❌ 让它晚到之后再存、再调 onSuccess —— 弹窗是全局一份,那时开着的可能已经是别的框,会被它关掉。
  const inFlight = useRef<AbortController | null>(null);
  useEffect(() => () => inFlight.current?.abort(), []);

  const submit = async () => {
    if (!link.trim() || busy) return;
    const controller = new AbortController();
    inFlight.current = controller;
    setBusy(true);
    setError(null);
    try {
      const pack = await importThemeFromLink(link, controller.signal);
      if (controller.signal.aborted) return;
      saveImportedThemePack(pack);
      toast({ title: translate('themes.imported', { name: pack.name }) });
      onSuccess();
    } catch (cause) {
      if (controller.signal.aborted) return;
      log.warn({ link, cause: String(cause) }, 'theme import failed');
      setError(translate(`themes.error.${cause instanceof ThemeImportError ? cause.code : 'network'}`));
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>{translate('themes.importTitle')}</DialogTitle>
      </DialogHeader>
      <DialogContentArea className="gap-3 pt-0">
        <Input
          data-autofocus
          value={link}
          onChange={(e) => setLink(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void submit();
          }}
          placeholder={translate('themes.importPlaceholder')}
          aria-invalid={error !== null}
        />
        <p className="text-xs text-foreground-muted">{translate('themes.importHint')}</p>
        {error && <p role="alert" className="text-sm text-[var(--danger-fg)]">{error}</p>}
      </DialogContentArea>
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>
          {translate('common.cancel')}
        </Button>
        <ConfirmButton onClick={() => void submit()} disabled={!link.trim() || busy}>
          {busy ? translate('themes.importing') : translate('themes.importAction')}
        </ConfirmButton>
      </DialogFooter>
    </>
  );
}
