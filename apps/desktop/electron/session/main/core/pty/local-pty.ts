import * as nodePty from 'node-pty';
import { spawnNodePty, type NodePtyProcess } from '@gugu/session-core/pty/node';
import { log } from '@main/lib/logger';
import type { PtyDimensions } from './pty';

export interface LocalSpawnOptions extends PtyDimensions {
  id: string;
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}

type OwnedLocalPty = Pick<NodePtyProcess, 'kill' | 'onExit'>;

export class LocalPtyOwner {
  private readonly sessions = new Set<OwnedLocalPty>();
  private disposing = false;

  assertAccepting(): void {
    if (this.disposing) throw new Error('Local PTY owner is disposing');
  }

  own<T extends OwnedLocalPty>(session: T): T {
    this.assertAccepting();
    this.sessions.add(session);
    session.onExit(() => this.sessions.delete(session));
    return session;
  }

  dispose(): void {
    if (this.disposing) return;
    this.disposing = true;
    const failures: unknown[] = [];
    for (const session of this.sessions) {
      try {
        session.kill();
      } catch (error) {
        failures.push(error);
      }
    }
    this.sessions.clear();
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, 'Local PTY cleanup failed');
  }
}

const localPtyOwner = new LocalPtyOwner();

export function spawnLocalPty(options: LocalSpawnOptions): NodePtyProcess {
  const { id, command, args, cwd, cols, rows } = options;
  log.info('LocalPtySession:spawn', { id, command, args, cwd, cols, rows });
  localPtyOwner.assertAccepting();
  return localPtyOwner.own(spawnNodePty(nodePty, options, log));
}

export function disposeLocalPtySessions(): void {
  localPtyOwner.dispose();
}
