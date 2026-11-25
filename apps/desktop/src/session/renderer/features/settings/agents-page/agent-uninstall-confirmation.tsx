import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@renderer/lib/ui/dialog';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { uninstallAgentWithToast } from './uninstall-agent-with-toast';

type UninstallRequest = { name: string; uninstall: () => Promise<void> };

export function useAgentUninstallConfirmation() {
  const { translate } = useSessionMessages();
  const [request, setRequest] = useState<UninstallRequest | null>(null);
  const cancel = () => setRequest(null);

  const confirmation = request && (
    <Dialog open onOpenChange={(open) => { if (!open) cancel(); }}>
      <DialogContent className="rounded-2xl bg-background sm:max-w-[480px]" data-testid="agent-uninstall-confirmation">
        <DialogHeader className="pb-4" showCloseButton={false}>
          <DialogTitle className="text-base font-semibold">
            {translate('extensions.uninstallConfirmTitle', { name: request.name })}
          </DialogTitle>
        </DialogHeader>
        <DialogDescription className="mx-6 mb-5 text-foreground-muted">
          {translate('marketDetail.agentUninstallBody', { name: request.name })}
        </DialogDescription>
        <DialogFooter className="flex-row justify-end border-0 bg-transparent px-6 pt-0 pb-6">
          <Button variant="secondary" onClick={cancel}>{translate('common.cancel')}</Button>
          <Button variant="danger" onClick={() => {
            cancel();
            uninstallAgentWithToast(request.name, request.uninstall, translate);
          }}>
            {translate('extensions.uninstallAction')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );

  return {
    confirmation,
    requestUninstall: (name: string, uninstall: UninstallRequest['uninstall']) => setRequest({ name, uninstall }),
  };
}
