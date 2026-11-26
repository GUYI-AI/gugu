import { createContext, lazy, Suspense, useCallback, useContext, useRef, useState, type ReactNode } from 'react';
import { modalStore } from './modal-store';
import { wrapArgs, type ModalId, type UserArgs } from './modal-provider';

/**
 * @@@modal-surface (#3857) — a registered modal asked for from inside an overlay opens **inside that overlay**: as a
 * React child of it, i.e. a Base UI nested dialog. Base UI then owns everything a stacked dialog needs — it sits one
 * layer above its parent, the parent does not treat a press in it as an outside press, focus stays in it, Escape closes
 * it first.
 *
 * Why not the global store (`useShowModal`): it opens wherever the last `modalStore.setPortalContainer` pointed, a
 * document-level "last writer wins" answer to a question that belongs to the tree (same disease as @@@4321). From the
 * App market's agent details the confirmation opened inside the page-modal sheet (5000) while the details dialog sat
 * above the sheet (5001): it was drawn, focused and invisible.
 *
 * Every overlay primitive provides a surface (lib/ui/dialog.tsx DialogContent, the global ModalRenderer). Outside any
 * surface `useSurfaceModal` falls back to the global store, so a component used both on a page and inside a dialog
 * (ManagedVersionsRow: Settings › Agents and the market details) needs one call.
 */
type SurfaceRequest = { id: ModalId; args: Record<string, any>; key: number };
type Show = (id: ModalId, args: Record<string, any>) => void;

const ModalSurfaceContext = createContext<Show | null>(null);

// The renderer imports the modal registry (the task page's dialogs): pulled only when a surface first opens one.
const SurfaceModal = lazy(() => import('./surface-modal-renderer').then((m) => ({ default: m.SurfaceModalRenderer })));

export function ModalSurfaceProvider({ children }: { children: ReactNode }) {
  const [request, setRequest] = useState<SurfaceRequest | null>(null);
  const counter = useRef(0);
  const show = useCallback<Show>((id, args) => {
    counter.current += 1;
    setRequest({ id, args, key: counter.current });
  }, []);
  const closed = useCallback((key: number) => setRequest((current) => (current?.key === key ? null : current)), []);
  return (
    <ModalSurfaceContext.Provider value={show}>
      {children}
      {request ? (
        <Suspense fallback={null}>
          <SurfaceModal key={request.key} id={request.id} args={request.args} onClosed={() => closed(request.key)} />
        </Suspense>
      ) : null}
    </ModalSurfaceContext.Provider>
  );
}

/** Same call as `useShowModal(id)`; opens in the overlay the caller is rendered in, else in the global store. */
export function useSurfaceModal<MId extends ModalId>(id: MId) {
  const surface = useContext(ModalSurfaceContext);
  return useCallback(
    (args: UserArgs<MId>) => {
      if (surface) surface(id, args as Record<string, any>);
      else modalStore.setModal(id, wrapArgs(args));
    },
    [surface, id]
  );
}

/** The destructive/neutral confirmation (confirmActionModal), opened where the caller is. */
export function useConfirm() {
  return useSurfaceModal('confirmActionModal');
}
