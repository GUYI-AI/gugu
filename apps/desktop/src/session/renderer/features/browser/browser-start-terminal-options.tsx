import { useState } from 'react';
import { Ellipsis } from '@/lib/icons';
import { useReplica } from '@/lib/replica';
import type { TerminalShellId } from '@shared/core/terminals/terminal-settings';
import { Button } from '@renderer/lib/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuTrigger } from '@renderer/lib/ui/dropdown-menu';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { workspaceBackend } from '../sessions/workspace-backend/workspace-backend';
import { shellAvailability } from '../sessions/terminals/terminal-shell-availability';

export function BrowserStartTerminalOptions({ projectId, launch }: {
  projectId: string;
  launch: (shell?: TerminalShellId) => void;
}) {
  const { translate } = useSessionMessages();
  const [open, setOpen] = useState(false);
  const useDeviceShells = workspaceBackend(projectId).terminal.persistent;
  const shells = useReplica(shellAvailability, open && useDeviceShells ? [] : null);
  const label = translate('browser.workspaceTerminalOptions');
  return <DropdownMenu open={open} onOpenChange={setOpen}>
    <DropdownMenuTrigger render={<Button size="icon-sm" variant="ghost" aria-label={label} title={label} />}>
      <Ellipsis className="size-4" />
    </DropdownMenuTrigger>
    <DropdownMenuContent align="end">
      <DropdownMenuItem onClick={() => launch()}>{translate('browser.workspaceDefaultTerminal')}</DropdownMenuItem>
      {shells.state === 'value' && shells.value.filter((shell) => shell.available && shell.id !== 'system')
        .map((shell) => <DropdownMenuItem key={shell.id} onClick={() => launch(shell.id)}>{shell.label}</DropdownMenuItem>)}
      {shells.state === 'error' && <DropdownMenuGroup label={translate('terminal.shellsLoadFailed')} />}
    </DropdownMenuContent>
  </DropdownMenu>;
}
