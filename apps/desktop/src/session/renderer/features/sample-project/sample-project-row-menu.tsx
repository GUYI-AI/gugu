import { useRef, useState, type ReactNode } from 'react';
import { Menu, MenuItem } from '@/components/ui/Menu';
import { useRowContextMenu } from '@/hooks/useRowContextMenu';
import { Trash } from '@/lib/icons';
import { dismissSampleProject } from '@/lib/sampleProject';
import { messageForUser } from '@/lib/userFacingError';
import { toast } from '@renderer/lib/hooks/use-toast';
import { useSessionMessages } from '@renderer/localization/use-session-messages';

/** Same row gesture as ordinary projects; removing bundled content only saves its account key. */
export function SampleProjectRowMenu({ userId, children }: { userId: string; children: ReactNode }) {
  const { translate } = useSessionMessages();
  const menu = useRowContextMenu();
  const row = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);
  const remove = async () => {
    menu.closeMenu();
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
  return <div ref={row} onContextMenu={menu.onContextMenu} aria-busy={busy || undefined}>
    {children}
    {menu.menuPos && <Menu anchor={row} onClose={menu.closeMenu}>
      <MenuItem icon={<Trash size={15} aria-hidden />} danger disabled={busy} onClick={() => void remove()}>
        {translate('projects.sample.remove')}
      </MenuItem>
    </Menu>}
  </div>;
}
