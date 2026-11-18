import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronDown, Ellipsis, Trash2 } from '@/lib/icons';
import { Button } from '@renderer/lib/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@renderer/lib/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@renderer/lib/ui/dropdown-menu';
import { useSessionMessages } from '@renderer/localization/use-session-messages';

type Confirmation = {
  title: string;
  description: ReactNode;
  confirmLabel: string;
  variant?: 'default' | 'destructive';
};

type Request = Confirmation & { settle: (answer: boolean) => void };

const ConfirmContext = createContext<(request: Confirmation) => Promise<boolean>>(async () => false);

export function useMarketDetailConfirmation() {
  return useContext(ConfirmContext);
}

export function MarketDetailDialog({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  const { translate } = useSessionMessages();
  const opener = useRef(typeof document !== 'undefined' && document.activeElement instanceof HTMLElement ? document.activeElement : null);
  const [request, setRequest] = useState<Request | null>(null);
  const queue = useRef<Request[]>([]);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      for (const pending of queue.current.splice(0)) pending.settle(false);
    };
  }, []);

  const ask = (confirmation: Confirmation) => new Promise<boolean>((settle) => {
    if (!mounted.current) {
      settle(false);
      return;
    }
    const next = { ...confirmation, settle };
    queue.current.push(next);
    if (queue.current.length === 1) setRequest(next);
  });
  const finish = (answer: boolean) => {
    if (queue.current[0] !== request) return;
    queue.current.shift()?.settle(answer);
    setRequest(queue.current[0] ?? null);
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent
        className="max-h-[min(820px,calc(100dvh-2rem))] rounded-3xl bg-background sm:max-w-[640px]"
        finalFocus={() => opener.current?.isConnected ? opener.current : false}
        data-testid="market-detail-dialog"
      >
        <ConfirmContext.Provider value={ask}>
          {children}
          {request && (
            <Dialog open onOpenChange={(open) => { if (!open) finish(false); }}>
              <DialogContent className="z-[51] rounded-2xl bg-background sm:max-w-[480px]" data-testid="market-detail-confirmation">
                <DialogHeader className="pb-4">
                  <DialogTitle className="text-base font-semibold">{request.title}</DialogTitle>
                </DialogHeader>
                <DialogDescription render={<div />} className="mx-6 mb-5 whitespace-pre-line">
                  {request.description}
                </DialogDescription>
                <DialogFooter>
                  <Button variant="outline" onClick={() => finish(false)}>{translate('common.cancel')}</Button>
                  <Button variant={request.variant ?? 'default'} onClick={() => finish(true)} data-testid="market-detail-confirm">{request.confirmLabel}</Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          )}
        </ConfirmContext.Provider>
      </DialogContent>
    </Dialog>
  );
}

export function MarketDetailCard({
  name, publisher, icon, actions, devices, facts, subtitle, notice, onUninstall, children,
}: {
  name: string;
  publisher?: string;
  icon: ReactNode;
  actions?: ReactNode;
  devices?: ReactNode;
  facts?: readonly { label: string; value: ReactNode }[];
  subtitle?: ReactNode;
  notice?: ReactNode;
  onUninstall?: () => void;
  children?: ReactNode;
}) {
  const { translate } = useSessionMessages();
  const [expanded, setExpanded] = useState(false);
  return (
    <>
      <DialogHeader className="items-start gap-4 pb-0 [&>button]:mt-1">
        <div className="flex min-w-0 gap-4">
          <div className="size-[68px] shrink-0 overflow-hidden rounded-2xl [&>*]:!size-full">{icon}</div>
          <div className="min-w-0">
            <DialogTitle className="break-words text-xl font-semibold">{name}</DialogTitle>
            {publisher && <p className="mt-1 text-sm text-foreground-muted">{publisher}</p>}
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {actions}
              {devices && (
                <Button variant="outline" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
                  {translate('marketDetail.otherDevices')}
                  <ChevronDown className={expanded ? 'rotate-180' : undefined} aria-hidden />
                </Button>
              )}
              {onUninstall && (
                <DropdownMenu>
                  <DropdownMenuTrigger render={<Button variant="outline" size="icon" aria-label={translate('common.more')} data-testid="market-detail-more" />}>
                    <Ellipsis aria-hidden />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem variant="destructive" onClick={onUninstall} data-testid="market-detail-uninstall">
                      <Trash2 aria-hidden />
                      {translate('extensions.uninstallAction')}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </div>
          </div>
        </div>
      </DialogHeader>
      <div className="min-h-0 space-y-6 overflow-y-auto px-6 pt-5 pb-6">
        {notice}
        {expanded && devices}
        {subtitle && <div className="leading-relaxed text-foreground-muted">{subtitle}</div>}
        {!!facts?.length && (
          <dl className="flex flex-wrap divide-x divide-border rounded-2xl border border-border py-3 text-center">
            {facts.map(({ label, value }) => (
              <div key={label} className="flex min-w-20 flex-1 flex-col-reverse gap-1 px-2">
                <dt className="text-xs text-foreground-muted">{label}</dt>
                <dd className="font-semibold">{value}</dd>
              </div>
            ))}
          </dl>
        )}
        {children}
      </div>
    </>
  );
}
