import { cn } from '@renderer/utils/utils';
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { Ellipsis, Trash2, XIcon } from '@/lib/icons';
import { Button } from '@renderer/lib/ui/button';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@renderer/lib/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@renderer/lib/ui/dropdown-menu';
import { useSessionMessages } from '@renderer/localization/use-session-messages';

type Confirmation = {
  title: string;
  description: ReactNode;
  confirmLabel: string;
  variant?: 'default' | 'destructive';
};

const ConfirmContext = createContext({
  ask: (_request: Confirmation): Promise<boolean> => Promise.resolve(false),
  confirming: false,
});

export function useMarketDetailConfirmation() {
  return useContext(ConfirmContext).ask;
}

export function useMarketDetailConfirming() {
  return useContext(ConfirmContext).confirming;
}

export function useMarketDetailQueue<T>() {
  type Request = { value: T; settle: (answer: boolean) => void };
  const [active, setActive] = useState<Request | null>(null);
  const queue = useRef<Request[]>([]);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      for (const pending of queue.current.splice(0)) pending.settle(false);
    };
  }, []);

  const enqueue = (value: T) => new Promise<boolean>((settle) => {
    if (!mounted.current) {
      settle(false);
      return;
    }
    const next = { value, settle };
    queue.current.push(next);
    if (queue.current.length === 1) setActive(next);
  });
  const finish = (answer: boolean) => {
    if (queue.current[0] !== active) return;
    queue.current.shift()?.settle(answer);
    setActive(queue.current[0] ?? null);
  };
  return { active, enqueue, finish };
}

/** Gives `useMarketDetailConfirmation` its dialog, one question at a time; outside a detail dialog too (an App's market page). */
export function MarketDetailConfirmations({ children }: { children: ReactNode }) {
  const { translate } = useSessionMessages();
  const { active, enqueue, finish } = useMarketDetailQueue<Confirmation>();
  const request = active?.value;
  return (
    <ConfirmContext.Provider value={{ ask: enqueue, confirming: !!request }}>
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
  );
}

export function MarketDetailDialog({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  const opener = useRef(typeof document !== 'undefined' && document.activeElement instanceof HTMLElement ? document.activeElement : null);
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent
        className="max-h-[min(820px,calc(100dvh-2rem))] rounded-3xl bg-background sm:max-w-[640px]"
        finalFocus={() => opener.current?.isConnected ? opener.current : false}
        data-testid="market-detail-dialog"
      >
        <MarketDetailConfirmations>{children}</MarketDetailConfirmations>
      </DialogContent>
    </Dialog>
  );
}

export function MarketDetailCard({
  name, publisher, icon, actions, devices, facts, subtitle, notice, onUninstall, alternate, children,
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
  /** A second view that takes the place of the facts and children while it is shown (an agent's 高级设置). */
  alternate?: { shown: boolean; view: ReactNode };
  children?: ReactNode;
}) {
  const { translate } = useSessionMessages();
  const details = (
    <>
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
    </>
  );
  return (
    <>
      <div data-slot="dialog-header" className="relative shrink-0 pt-6 pr-16 pl-6">
        <DialogClose
          render={<Button variant="ghost" size="icon" className="absolute top-4 right-4 text-foreground-muted" />}
          aria-label={translate('common.close')}
        >
          <XIcon aria-hidden />
        </DialogClose>
        <div className="flex min-w-0 gap-4">
          <div className="size-[68px] shrink-0 overflow-hidden rounded-2xl [&>*]:!size-full">{icon}</div>
          <div className="min-w-0">
            <DialogTitle className="break-words text-xl font-semibold">{name}</DialogTitle>
            {publisher && <p className="mt-1 text-sm text-foreground-muted">{publisher}</p>}
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {actions}
              {devices}
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
      </div>
      <div className="min-h-0 space-y-6 overflow-y-auto px-6 pt-5 pb-6">
        {notice}
        {subtitle && <div className="leading-relaxed text-foreground-muted [&_p:first-child]:mt-0 [&_p:last-child]:mb-0">{subtitle}</div>}
        {alternate ? (
          // Both views share one grid cell, so switching keeps the dialog's height instead of jumping.
          <div className="grid [&>*]:[grid-area:1/1]">
            <div className={cn('min-w-0 space-y-6', alternate.shown && 'invisible')} inert={alternate.shown}>{details}</div>
            <div className={cn('min-w-0', !alternate.shown && 'invisible')} inert={!alternate.shown}>{alternate.view}</div>
          </div>
        ) : details}
      </div>
    </>
  );
}
