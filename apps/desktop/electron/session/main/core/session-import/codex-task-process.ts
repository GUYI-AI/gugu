import { fork } from '@gugu/core/local/childProcess';
import type { CodexTaskScan, CodexTaskSourceRow } from '@shared/core/session-import/codex-tasks';
import { desktopWorkerPath } from '../../worker-manifest';
import { log } from '@main/lib/logger';
import { importError } from '@shared/core/session-import/import-error-code';

function validScan(value: unknown): value is CodexTaskScan {
  if (!value || typeof value !== 'object') return false;
  const scan = value as CodexTaskScan;
  return ['ready', 'unavailable'].includes(scan.status) && [scan.indexed, scan.missing, scan.invalid].every(Number.isSafeInteger)
    && Array.isArray(scan.blocked) && Array.isArray(scan.rows) && scan.rows.every(row => row && typeof row.id === 'string' && typeof row.title === 'string'
      && typeof row.cwd === 'string' && typeof row.relativePath === 'string' && typeof row.revision === 'string'
      && Number.isFinite(row.updatedAt) && Number.isSafeInteger(row.sizeBytes) && Array.isArray(row.files)
      && row.files.every(file => typeof file.relativePath === 'string' && typeof file.nativeId === 'string' && typeof file.cwd === 'string'));
}

export function readCodexTasks(sourceRoot: string, signal: AbortSignal): Promise<CodexTaskScan> {
  return run({ sourceRoot }, signal, validScan);
}

export async function verifyCodexTaskFiles(sourceRoot: string, rows: CodexTaskSourceRow[], signal: AbortSignal): Promise<void> {
  await run({ sourceRoot, verify: rows }, signal, (value): value is { verified: true } =>
    !!value && typeof value === 'object' && (value as { verified?: unknown }).verified === true);
}

function run<T>(request: { sourceRoot: string; verify?: CodexTaskSourceRow[] }, signal: AbortSignal, validate: (value: unknown) => value is T): Promise<T> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = fork(desktopWorkerPath('codex-task-scan'), [], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, execArgv: [],
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'], serialization: 'advanced',
    });
    let reply: unknown;
    let failure: unknown;
    child.stderr?.resume();
    const abort = () => { failure = signal.reason ?? new Error('Import cancelled'); child.kill('SIGKILL'); };
    signal.addEventListener('abort', abort, { once: true });
    child.on('error', error => { failure = error; });
    child.on('message', message => { reply = message; });
    child.once('close', code => {
      signal.removeEventListener('abort', abort);
      if (signal.aborted) reject(signal.reason);
      else if (failure || code !== 0 || !validate(reply)) {
        log.warn('[codex-task-import] Source worker failed', { sourceRoot: request.sourceRoot, error: failure, exitCode: code });
        reject(importError('codex-import-source-unreadable'));
      }
      else resolve(reply);
    });
    child.send(request, error => { if (error) { failure = error; child.kill('SIGKILL'); } });
    if (signal.aborted) abort();
  });
}
