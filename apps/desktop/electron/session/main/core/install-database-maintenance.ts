import { statSync } from 'node:fs';
import { powerMonitor } from 'electron';
import { acpAgentStatusBridge } from './acp/agent-status-bridge';
import { acpAtRest } from './sessions/install-idle-reclaim';
import { databaseRequestsActive, databaseQuietFor } from '../db/maintenance-activity';
import { DATABASE_IDLE_MS } from '../db/maintenance';
import { RECLAIM_MIN_BYTES } from '../db/reclaim';
import { createDatabaseMaintenance } from '../db/maintenance';
import { physicalDatabaseBinding } from '../db/physical-connection';
import { sessionDatabaseConnection } from '../db/client';
import { takeDatabaseSpaceChanges } from '../db/space';
import { sessionIndexPath } from './session-index/store';
import { sessionLife } from './sessions/session-life';
import { ptySessionRegistry } from './pty/pty-session-registry';
import { hasAgentInstallsInProgress } from './agents/install-progress-ledger';
import { log } from '../lib/logger';

export function installDatabaseMaintenance(browserFeatures: boolean) {
  const maintenance = createDatabaseMaintenance({
    // Desktop input has its own OS idle clock: completed background RPC polls
    // must not starve maintenance forever. Pending requests always block it.
    // Without an OS clock, a headless host conservatively requires RPC quiet.
    quiet: () => !databaseRequestsActive() && (browserFeatures || databaseQuietFor(DATABASE_IDLE_MS)),
    idle: () => {
      // Ready ACP engines can remain open at rest. Unknown/busy engines and
      // native terminals fail closed; native idle time also covers local input.
      const summaries = acpAgentStatusBridge.current();
      if (sessionLife().running().some(({ sessionId }) => !acpAtRest(summaries.get(sessionId)))
        || ptySessionRegistry.listActiveSessions().length || hasAgentInstallsInProgress()) return false;
      return !browserFeatures || (typeof powerMonitor?.getSystemIdleTime === 'function' && powerMonitor.getSystemIdleTime() >= 60);
    },
    targets: () => {
      const connection = sessionDatabaseConnection();
      for (const change of takeDatabaseSpaceChanges(connection)) {
        // Large newly freed regions must remain diagnosable at the default warn
        // log level; routine small/new-schema readings remain debug diagnostics.
        const freed = (change.after.freelistCount - change.before.freelistCount) * change.after.pageSize;
        if (freed >= RECLAIM_MIN_BYTES) log.warn('database maintenance: migration freed a large region', change);
        else log.info('database maintenance: migration space', change);
      }
      const main = physicalDatabaseBinding(connection);
      const targets = [{ path: main.path, identity: main.identity }];
      const path = sessionIndexPath(main.path);
      try { const stat = statSync(path, { bigint: true }); targets.push({ path, identity: `${stat.dev}:${stat.ino}` }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      return targets;
    },
    report: readings => {
      for (const reading of readings) {
        if (reading.error) log.warn('database maintenance: idle pass failed', reading);
        else if (reading.result?.state === 'reclaimed' || reading.result?.reclaimedPages) log.info('database maintenance: idle pass', reading);
      }
    },
  });
  maintenance.start();
  return () => maintenance.stop();
}
