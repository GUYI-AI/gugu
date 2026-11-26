import { Dialog as DialogPrimitive } from '@base-ui/react/dialog';
import { reaction } from 'mobx';
import { observer } from 'mobx-react-lite';
import { useCallback, useEffect, useRef, useState } from 'react';
import { modalRegistry, type ModalRegistryEntry } from '@renderer/app/modal-registry';
import { UiPortalContainerProvider, useUiPortalContainer } from '@gugu/session-ui/react/primitives';
import { Dialog, DialogOverlay, DialogPortal } from '@renderer/lib/ui/dialog';
import { cn } from '@renderer/utils/utils';
import { modalStore } from './modal-store';
import { noteOverlayRequest } from '@/lib/localRendererDiagnostics';
import { useOverlayOcclusionProbe } from '@/lib/overlayOcclusion';
import { DIALOG_SCROLL_BODY, MODAL_POPUP_CLASS, MODAL_POSITION_CLASSES, MODAL_SIZE_CLASSES } from './modal-chrome';
import { ModalSurfaceProvider } from './modal-surface';

export const ModalRenderer = observer(function ModalRenderer() {
  const pageLayer = useUiPortalContainer();
  const portalContainer = modalStore.portalContainer ?? pageLayer;
  const [portal, setPortal] = useState({ container: portalContainer, revision: 0 });
  if (portal.container !== portalContainer) {
    // A portal move destroys its popup DOM. Reset the dialog's transition/focus owner too:
    // an interrupted exit must not remount retained content with open=false in the new surface.
    setPortal({ container: portalContainer, revision: portal.revision + 1 });
  }
  const entry = (
    modalStore.activeModalId
      ? modalRegistry[modalStore.activeModalId as keyof typeof modalRegistry]
      : null
  ) as ModalRegistryEntry | null;
  const Component = entry?.component as React.ComponentType<any> | undefined;

  // Preserve the last rendered content and entry config so the close animation plays with the
  // correct dimensions and full content rather than collapsing while the popup fades out.
  const lastComponentRef = useRef<React.ComponentType<any> | null>(null);
  const lastArgsRef = useRef<Record<string, unknown> | null>(null);
  const lastEntryRef = useRef<ModalRegistryEntry | null>(null);
  const lastRequestRef = useRef(0);

  if (modalStore.isOpen && Component && modalStore.activeModalArgs) {
    lastComponentRef.current = Component;
    lastArgsRef.current = modalStore.activeModalArgs;
    lastEntryRef.current = entry;
    lastRequestRef.current = modalStore.request;
  }

  const DisplayComponent = lastComponentRef.current;
  const displayArgs = lastArgsRef.current;
  const displayEntry = lastEntryRef.current;
  const activeModalId = modalStore.activeModalId;
  const activeEntryRef = useRef<ModalRegistryEntry | null>(null);
  const ignoreNextOutsidePressRef = useRef(false);

  activeEntryRef.current = entry;

  useEffect(() => {
    ignoreNextOutsidePressRef.current = false;
  }, [activeModalId]);

  useEffect(() => {
    const handleWindowBlur = () => {
      if (modalStore.isOpen && activeEntryRef.current?.ignoreOutsidePressAfterWindowBlur) {
        ignoreNextOutsidePressRef.current = true;
      }
    };

    window.addEventListener('blur', handleWindowBlur);
    return () => window.removeEventListener('blur', handleWindowBlur);
  }, []);

  const handleOpenChange = (
    open: boolean,
    eventDetails: DialogPrimitive.Root.ChangeEventDetails
  ) => {
    if (!open && modalStore.isOpen) {
      const isOutsidePress = eventDetails.reason === 'outside-press';
      if (
        isOutsidePress &&
        displayEntry?.ignoreOutsidePressAfterWindowBlur &&
        ignoreNextOutsidePressRef.current
      ) {
        ignoreNextOutsidePressRef.current = false;
        return;
      }

      const isPassiveDismiss = isOutsidePress || eventDetails.reason === 'escape-key';
      if (modalStore.closeGuardActive && isPassiveDismiss) { noteOverlayRequest(eventDetails, 'session-modal', false, 'blocked-close-guard'); return; }
      ignoreNextOutsidePressRef.current = false;
      // Esc / 点外面也是关掉,走这个弹窗自己的 onClose(每个 setModal 都带):等它结果的调用方才听得到。
      noteOverlayRequest(eventDetails, 'session-modal', false, 'close-requested'); modalStore.activeModalArgs?.onClose();
    }
  };

  const popupRef = useRef<HTMLDivElement>(null);
  const probe = useOverlayOcclusionProbe('session-modal');
  const popupProbeRef = useCallback((el: HTMLDivElement | null) => { popupRef.current = el; probe(el); }, [probe]);

  // Restore focus to the element captured by modalStore.setModal when the modal closes.
  useEffect(
    () =>
      reaction(
        () => modalStore.isOpen,
        (isOpen) => {
          if (!isOpen && modalStore.previousFocus) {
            const el = modalStore.previousFocus;
            modalStore.previousFocus = null;
            requestAnimationFrame(() => {
              if (el.isConnected) el.focus();
            });
          }
        }
      ),
    []
  );

  const initialFocus = useCallback(() => {
    const target = popupRef.current?.querySelector<HTMLElement>('[data-autofocus]');
    if (!target) return true;
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
      requestAnimationFrame(() => target.select());
    }
    return target;
  }, []);

  return (
    <Dialog key={portal.revision} open={modalStore.isOpen} onOpenChange={handleOpenChange}>
      <DialogPortal container={portalContainer}>
        <DialogOverlay />
        <DialogPrimitive.Popup
          ref={popupProbeRef}
          finalFocus={false}
          initialFocus={initialFocus}
          data-slot="dialog-content"
          onKeyDownCapture={(e) => {
            if ((e.metaKey || e.ctrlKey || e.altKey) && e.key === 'Enter') {
              e.preventDefault();
            }
          }}
          onPointerDownCapture={() => {
            if (displayEntry?.ignoreOutsidePressAfterWindowBlur) {
              ignoreNextOutsidePressRef.current = false;
            }
          }}
          className={cn(
            MODAL_POPUP_CLASS,
            DIALOG_SCROLL_BODY,
            MODAL_POSITION_CLASSES[displayEntry?.position ?? 'center'],
            MODAL_SIZE_CLASSES[displayEntry?.size ?? 'md']
          )}
        >
          {/* @@@modal-surface: a modal this one asks for opens nested in it, above it. */}
          <UiPortalContainerProvider zIndex="var(--z-modal)">
            <ModalSurfaceProvider>
              {DisplayComponent && displayArgs ? <DisplayComponent key={lastRequestRef.current} {...displayArgs} /> : null}
            </ModalSurfaceProvider>
          </UiPortalContainerProvider>
        </DialogPrimitive.Popup>
      </DialogPortal>
    </Dialog>
  );
});
