import { createRPCController } from '@shared/lib/ipc/rpc';
import { createTerminal } from './createTerminal';
import { deleteTerminal } from './deleteTerminal';
import { getTerminalsForSession } from './getTerminalsForSession';
import { getTerminalShellAvailability } from './getTerminalShellAvailability';
import { hydrateTerminal } from './hydrateTerminal';
import { renameTerminal } from './renameTerminal';

export const terminalsController = createRPCController({
  createTerminal,
  deleteTerminal,
  getTerminalShellAvailability,
  hydrateTerminal,
  renameTerminal,
  getTerminalsForSession,
});
