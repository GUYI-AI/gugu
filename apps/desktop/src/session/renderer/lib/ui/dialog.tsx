import { Dialog as DialogPrimitive } from '@base-ui/react/dialog';
import { XIcon } from '@/lib/icons'
import * as React from 'react';
import { UiPortalContainerProvider, useUiPopupZIndex, useUiPortalContainer } from '@gugu/session-ui/react/primitives';
import { Button } from '@renderer/lib/ui/button';
import { translateSessionMessage } from '@renderer/localization/locale-store';
import { cn } from '@renderer/utils/utils';
import { noteOverlayRequest } from '@/lib/localRendererDiagnostics';
import { useOverlayOcclusionProbe } from '@/lib/overlayOcclusion';
import { DIALOG_SCROLL_BODY } from '@renderer/lib/modal/modal-chrome';
import { ModalSurfaceProvider } from '@renderer/lib/modal/modal-surface';

function Dialog({ onOpenChange, ...props }: DialogPrimitive.Root.Props) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} onOpenChange={(next, details) => {
    try { onOpenChange?.(next, details) } finally { noteOverlayRequest(details, 'session-dialog', next) }
  }} />;
}

function DialogTrigger({ ...props }: DialogPrimitive.Trigger.Props) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />;
}

function DialogPortal({ ...props }: DialogPrimitive.Portal.Props) {
  return (
    <DialogPrimitive.Portal data-slot="dialog-portal" container={useUiPortalContainer()} {...props} />
  );
}

function DialogClose({ ...props }: DialogPrimitive.Close.Props) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />;
}

function DialogOverlay({ className, ...props }: DialogPrimitive.Backdrop.Props) {
  return (
    <DialogPrimitive.Backdrop
      style={{ zIndex: useUiPopupZIndex() }}
      data-slot="dialog-overlay"
      className={cn(
        'fixed inset-0 isolate z-[var(--z-modal)] bg-[var(--bg-overlay-soft)] duration-[var(--dur-fast)]  data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0',
        className
      )}
      {...props}
    />
  );
}

function DialogContent({
  className,
  children,
  ref,
  ...props
}: DialogPrimitive.Popup.Props & { showCloseButton?: boolean }) {
  const zIndex = useUiPopupZIndex();
  const probe = useOverlayOcclusionProbe('session-dialog');
  const popupRef = React.useCallback((el: HTMLDivElement | null) => {
    probe(el);
    if (typeof ref === 'function') ref(el);
    else if (ref) ref.current = el;
  }, [probe, ref]);
  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Popup
        ref={popupRef}
        finalFocus={false}
        style={{ zIndex }}
        data-slot="dialog-content"
        onKeyDownCapture={(e) => {
          if ((e.metaKey || e.ctrlKey || e.altKey) && e.key === 'Enter') {
            e.preventDefault();
          }
        }}
        className={cn(
          'fixed top-1/2 left-1/2 z-[var(--z-modal)] flex max-h-[calc(100dvh-2rem)] w-full max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl bg-background-quaternary text-sm shadow-lift duration-[var(--dur-fast)] outline-none data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95 sm:max-w-lg',
          DIALOG_SCROLL_BODY,
          className
        )}
        {...props}
      >
        {/* @@@modal-surface: what opens from inside this dialog (a menu, a confirmation) goes one layer above it, and a
            registered modal asked for here (useSurfaceModal / useConfirm) opens as a nested dialog in it. */}
        <UiPortalContainerProvider zIndex={zIndex ?? 'var(--z-modal)'}>
          <ModalSurfaceProvider>{children}</ModalSurfaceProvider>
        </UiPortalContainerProvider>
      </DialogPrimitive.Popup>
    </DialogPortal>
  );
}

function DialogHeader({
  className,
  children,
  showCloseButton = true,
  ...props
}: React.ComponentProps<'div'> & { showCloseButton?: boolean }) {
  return (
    <div
      data-slot="dialog-header"
      className="flex shrink-0 items-center justify-between gap-2 p-6"
      {...props}
    >
      <div className={cn('flex items-center gap-2', className)}>{children}</div>
      {showCloseButton && (
        <DialogPrimitive.Close
          data-slot="dialog-close"
          render={
            <button className="bg-transparent p-0 text-foreground-tertiary-muted hover:bg-transparent hover:text-foreground-tertiary" />
          }
        >
          <XIcon className="size-4" />
          <span className="sr-only">{translateSessionMessage('common.close')}</span>
        </DialogPrimitive.Close>
      )}
    </div>
  );
}

function DialogFooter({
  className,
  showCloseButton = false,
  children,
  ...props
}: React.ComponentProps<'div'> & {
  showCloseButton?: boolean;
}) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn(
        'flex shrink-0 flex-col-reverse gap-2 p-3 border-t border-border bg-background-quaternary-1 sm:flex-row sm:justify-end',
        className
      )}
      {...props}
    >
      {children}
      {showCloseButton && (
        <DialogPrimitive.Close render={<Button variant="outline" />}>Close</DialogPrimitive.Close>
      )}
    </div>
  );
}

function DialogTitle({ className, ...props }: DialogPrimitive.Title.Props) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      // @@@type-role (Refs #6106) — 原来是 `text-xs` + tertiary-passive:比自己的 Description
      // (text-sm + muted)小一档又淡一档,层级是倒的。弹层里要有一个明显的主对象。
      className={cn('text-sm font-sans font-medium text-foreground', className)}
      {...props}
    />
  );
}

function DialogDescription({ className, ...props }: DialogPrimitive.Description.Props) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn(
        'text-sm text-foreground-muted *:[a]:underline *:[a]:underline-offset-3 *:[a]:hover:text-foreground',
        className
      )}
      {...props}
    />
  );
}

export function DialogContentArea({
  className,
  children,
  ...props
}: {
  className?: string;
  children: React.ReactNode;
} & React.ComponentProps<'div'>) {
  return (
    <div
      className={cn(
        'flex flex-col gap-2 w-full min-h-0 overflow-y-auto p-6 pt-0 focus-visible:outline-none',
        className
      )}
      {...props}
    >
      {children}
    </div>
  );
}

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
};
