import { Dialog as DialogPrimitive } from '@base-ui/react/dialog';
import { useMemo, useState, type ComponentType } from 'react';
import { useUiPopupZIndex } from '@gugu/session-ui/react/primitives';
import { modalRegistry, type ModalRegistryEntry } from '@renderer/app/modal-registry';
import { Dialog, DialogOverlay, DialogPortal } from '@renderer/lib/ui/dialog';
import { cn } from '@renderer/utils/utils';
import { useOverlayOcclusionProbe } from '@/lib/overlayOcclusion';
import { DIALOG_SCROLL_BODY, MODAL_POPUP_CLASS, MODAL_POSITION_CLASSES, MODAL_SIZE_CLASSES } from './modal-chrome';
import { wrapArgs, type ModalId } from './modal-provider';

/** One registered modal, nested in the overlay that asked for it (@@@modal-surface). */
export function SurfaceModalRenderer({ id, args, onClosed }: { id: ModalId; args: Record<string, any>; onClosed: () => void }) {
  const [open, setOpen] = useState(true);
  const entry = modalRegistry[id] as ModalRegistryEntry | undefined;
  const wrapped = useMemo(() => wrapArgs(args, () => setOpen(false)), [args]);
  // Above the surface it was asked from (its DialogContent declares its layer), never below the modal layer.
  const zIndex = useUiPopupZIndex('var(--z-modal)');
  const probe = useOverlayOcclusionProbe(`surface-modal:${id}`);
  if (!entry) return null;
  const Component = entry.component as ComponentType<any>;
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => { if (!next && open) wrapped.onClose(); }}
      onOpenChangeComplete={(next) => { if (!next) onClosed(); }}
    >
      <DialogPortal>
        <DialogOverlay />
        <DialogPrimitive.Popup
          ref={probe}
          data-slot="dialog-content"
          data-surface-modal={id}
          style={{ zIndex }}
          className={cn(MODAL_POPUP_CLASS, DIALOG_SCROLL_BODY, MODAL_POSITION_CLASSES[entry.position ?? 'center'], MODAL_SIZE_CLASSES[entry.size ?? 'md'])}
        >
          <Component {...wrapped} />
        </DialogPrimitive.Popup>
      </DialogPortal>
    </Dialog>
  );
}
