import { noopLogger, type Logger } from '@gugu/session-shared/logger';
import { CONPTY_SPAWN_OPTIONS, releaseConoutWorkerOnExit } from './conpty';
import {
  normalizeSignal,
  PosixPtyTerminator,
  type PtyProcess,
  type PtySignal,
  type PtySpawner,
  type PtySpawnSpec,
} from '../index';

const MIN_COLS = 2;
const MIN_ROWS = 1;

type NodePtyModule = {
  spawn(
    command: string,
    args: string[],
    options: {
      name: string;
      cols: number;
      rows: number;
      cwd: string;
      env: Record<string, string>;
      useConptyDll?: boolean;
    }
  ): NodePtyLike;
};

type NodePtyLike = {
  pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  onData(handler: (data: string) => void): void;
  onExit(
    handler: (event: { exitCode: number; signal?: number | string | null }) => void
  ): void;
  on?: (event: 'error', handler: (error: NodeJS.ErrnoException) => void) => void;
};

let nodePtyPromise: Promise<NodePtyModule> | null = null;

export class NodePtySpawner implements PtySpawner {
  async spawn(spec: PtySpawnSpec): Promise<NodePtyProcess> {
    return spawnNodePty(await loadNodePty(), spec);
  }
}

/**
 * The one place a local pty is started. Synchronous, so a caller that subscribes right after it sees the
 * first byte. node-pty ≥ 1.2 marks every inherited fd close-on-exec in the forked child before exec, so the
 * pty's program gets only its own terminal (Windows: ConPTY's CreateProcessW passes bInheritHandles=false).
 */
export function spawnNodePty(
  nodePty: NodePtyModule,
  spec: PtySpawnSpec,
  logger: Logger = noopLogger
): NodePtyProcess {
  try {
    const proc = nodePty.spawn(spec.command, spec.args, {
      name: 'xterm-256color',
      cols: spec.cols,
      rows: spec.rows,
      cwd: spec.cwd,
      env: spec.env,
      ...CONPTY_SPAWN_OPTIONS,
    });
    suppressExpectedNodePtyErrors(proc, logger);
    releaseConoutWorkerOnExit(proc);
    return new NodePtyProcess(proc, new PosixPtyTerminator(logger), logger);
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    throw new Error(`Failed to spawn PTY: ${message}`);
  }
}

export class NodePtyProcess implements PtyProcess {
  private killed = false;

  constructor(
    private readonly proc: NodePtyLike,
    private readonly posixTerminator: Pick<PosixPtyTerminator, 'kill' | 'markExited'>,
    private readonly logger: Logger = noopLogger
  ) {
    this.proc.onExit(() => this.posixTerminator.markExited());
  }

  write(data: string): void {
    this.proc.write(data);
  }

  resize(cols: number, rows: number): void {
    const c = Number.isFinite(cols) ? Math.max(MIN_COLS, Math.floor(cols)) : MIN_COLS;
    const r = Number.isFinite(rows) ? Math.max(MIN_ROWS, Math.floor(rows)) : MIN_ROWS;
    try {
      this.proc.resize(c, r);
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      if (/EBADF|ENOTTY|ioctl\(2\) failed|not open|Napi::Error/.test(message)) return;
      this.logger.error('NodePtyProcess: resize failed', { cols: c, rows: r, error: message });
    }
  }

  kill(): void {
    if (this.killed) return;
    this.killed = true;

    const pid = this.proc.pid;
    if (process.platform === 'win32' || !Number.isInteger(pid) || pid <= 0) {
      this.killPty();
      return;
    }

    this.posixTerminator.kill(pid, () => this.killPty());
  }

  onData(handler: (data: string) => void): void {
    this.proc.onData(handler);
  }

  /** node-pty always has a code; the signal is left out when there was none (what desktop `Pty` expects). */
  onExit(handler: (info: { exitCode: number; signal?: PtySignal }) => void): void {
    this.proc.onExit(({ exitCode, signal }) => handler({ exitCode, signal: normalizeSignal(signal) }));
  }

  getPid(): number {
    return this.proc.pid;
  }

  private killPty(): void {
    try {
      this.proc.kill();
    } catch {}
  }
}

async function loadNodePty(): Promise<NodePtyModule> {
  nodePtyPromise ??= import('node-pty').then((mod) => mod as NodePtyModule);
  return nodePtyPromise;
}

function suppressExpectedNodePtyErrors(
  proc: NodePtyLike,
  logger: Logger,
  platform: NodeJS.Platform = process.platform
): void {
  if (platform !== 'win32') return;
  proc.on?.('error', (error) => {
    if (error.code === 'EPIPE' || error.code === 'EIO') return;
    logger.warn('node-pty: unexpected PTY error', { code: error.code, message: error.message });
  });
}
