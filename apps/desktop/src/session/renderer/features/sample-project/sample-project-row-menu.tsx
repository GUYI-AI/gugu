import { useRef, useState, type ReactNode } from 'react';
import { Menu, MenuItem } from '@/components/ui/Menu';
import { useRowContextMenu } from '@/hooks/useRowContextMenu';
import { Trash } from '@/lib/icons';
import { dismissSampleProject } from '@/lib/sampleProject';
import { messageForUser } from '@/lib/userFacingError';
import { toast } from '@renderer/lib/hooks/use-toast';
import { useSessionMessages } from '@renderer/localization/use-session-messages';

/**
 * Removing bundled content only saves its account key; a failed save says so and keeps the sample. The row's menu and
 * the inner sidebar's head row (#2548) remove it the same way.
 */
export function useRemoveSampleProject(userId: string): { busy: boolean; remove: () => Promise<void> } {
  const { translate } = useSessionMessages();
  const [busy, setBusy] = useState(false);
  const remove = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await dismissSampleProject(userId);
    } catch (error) {
      toast({ tier: 'error', title: translate('projects.sample.removeFailed'), description: messageForUser(error) });
    } finally {
      setBusy(false);
    }
  };
  return { busy, remove };
}

/** The sample's one menu item: remove it. */
export function SampleProjectRemoveItem({ busy, onRemove }: { busy: boolean; onRemove: () => void }) {
  const { translate } = useSessionMessages();
  return (
    <MenuItem icon={<Trash size={15} aria-hidden />} danger disabled={busy} onClick={onRemove}>
      {translate('projects.sample.remove')}
    </MenuItem>
  );
}

/** Same row gesture as ordinary projects. */
export function SampleProjectRowMenu({ userId, children }: { userId: string; children: ReactNode }) {
  const menu = useRowContextMenu();
  const row = useRef<HTMLDivElement>(null);
  const { busy, remove } = useRemoveSampleProject(userId);
  return <div ref={row} onContextMenu={menu.onContextMenu} aria-busy={busy || undefined}>
    {children}
    {menu.menuPos && <Menu anchor={row} onClose={menu.closeMenu}>
      <SampleProjectRemoveItem busy={busy} onRemove={() => {
        menu.closeMenu();
        void remove();
      }} />
    </Menu>}
  </div>;
}
