import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { constants } from 'node:fs';
import { access, chmod, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

type ConversionHarness = 'claude' | 'codex';
type RouterOptions = {
  executable: string;
  scratchRoot: string;
  harness: ConversionHarness;
  upstream: string;
};

export type ConversionRouter = {
  endpoint: string;
  pid: number;
  directory: string;
  closed: Promise<void>;
  stop: () => Promise<void>;
};

const formats = { claude: 'openai_chat', codex: 'chat' } satisfies Record<ConversionHarness, string>;
const placeholderKey = 'gugu-conversion-placeholder';
const startupTimeoutMs = 10_000;
const stopTimeoutMs = 2_000;

function isolatedEnv(directory: string): NodeJS.ProcessEnv {
  return {
    HOME: directory,
    USERPROFILE: directory,
    CC_SWITCH_CONFIG_DIR: join(directory, 'state'),
    CLAUDE_CONFIG_DIR: join(directory, 'claude'),
    CODEX_HOME: join(directory, 'codex'),
    TMPDIR: directory,
    TEMP: directory,
    TMP: directory,
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
  };
}

function observeExit(child: ChildProcess): Promise<number | null> {
  // Spawn failures also emit close. Keep executable details and child output outside launch errors.
  child.on('error', () => {});
  return new Promise((resolve) => child.once('close', resolve));
}

async function within<T>(operation: Promise<T>, ms: number, failure: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(failure)), ms);
  });
  try {
    return await Promise.race([operation, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

async function stopChild(child: ChildProcess, closed: Promise<number | null>): Promise<void> {
  if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGTERM');
    try {
      await within(closed, stopTimeoutMs, 'Conversion router did not stop');
    } catch {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
  }
  await within(closed, stopTimeoutMs, 'Conversion router could not be stopped');
}

function readBoundEndpoint(stdout: NonNullable<ChildProcess['stdout']>): Promise<string> {
  // The child prints this URL after bind(0). Capture only the address and drain the pipe afterwards.
  return new Promise((resolve) => {
    let tail = '';
    const consume = (chunk: string) => {
      tail += chunk;
      const completeLines = tail.lastIndexOf('\n');
      const match = tail.slice(0, Math.max(completeLines, 0))
        .match(/(?:Listening on|监听地址)\s+(http:\/\/127\.0\.0\.1:[1-9]\d{0,4})\b/);
      if (match) {
        stdout.off('data', consume);
        stdout.resume();
        resolve(match[1]!);
      } else {
        tail = tail.slice(completeLines + 1).slice(-128);
      }
    };
    stdout.setEncoding('utf8').on('data', consume);
  });
}

function providerConfigArgs(harness: ConversionHarness, upstream: URL): string[] {
  if (harness === 'claude') return ['--base-url', upstream.href, '--api-key', placeholderKey];
  // Codex's field mode sets a default model that the router would force onto every request.
  const config = [
    'model_provider = "gugu_conversion"',
    '[model_providers.gugu_conversion]',
    'name = "Gugu conversion"',
    `base_url = ${JSON.stringify(upstream.href)}`,
    'wire_api = "responses"',
    'requires_openai_auth = true',
  ].join('\n');
  return ['--config', JSON.stringify({ auth: { OPENAI_API_KEY: placeholderKey }, config })];
}

/**
 * Runs the pinned foreground converter against a local relay in a private directory.
 * The stock binary has no ingress authentication. Only fixture code uses this launcher for now.
 */
export async function launchConversionRouter(options: RouterOptions): Promise<ConversionRouter> {
  const upstream = new URL(options.upstream);
  if (upstream.protocol !== 'http:' || upstream.hostname !== '127.0.0.1' || !upstream.port ||
      upstream.username || upstream.password || upstream.search || upstream.hash) {
    throw new Error('The conversion router requires a local relay');
  }
  if (!isAbsolute(options.executable) || !isAbsolute(options.scratchRoot)) {
    throw new Error('The conversion binary and scratch root require absolute paths');
  }
  await access(options.executable, constants.X_OK);
  await mkdir(options.scratchRoot, { mode: 0o700, recursive: true });
  const directory = await mkdtemp(join(options.scratchRoot, 'router-'));
  const config: SpawnOptions = { cwd: directory, env: isolatedEnv(directory), windowsHide: true };
  const appArgs = ['--app', options.harness];
  let active: { child: ChildProcess; exit: Promise<number | null> } | undefined;
  const configure = async (args: string[]) => {
    const child = spawn(options.executable, [...appArgs, 'provider', ...args], { ...config, stdio: 'ignore' });
    const exit = observeExit(child);
    active = { child, exit };
    try {
      if (await within(exit, startupTimeoutMs, 'Conversion provider setup timed out') !== 0) {
        throw new Error('Conversion provider setup failed');
      }
    } finally {
      await stopChild(child, exit);
      active = undefined;
    }
  };
  try {
    await chmod(directory, 0o700);
    await configure([
      'add', '--id', 'gugu-local', '--name', 'Gugu conversion',
      ...providerConfigArgs(options.harness, upstream),
      '--api-format', formats[options.harness],
    ]);
    await configure(['switch', 'gugu-local']);
    const child = spawn(options.executable, [
      ...appArgs, 'proxy', 'serve', '--listen-address', '127.0.0.1', '--listen-port', '0',
    ], { ...config, stdio: ['ignore', 'pipe', 'ignore'] });
    const exit = observeExit(child);
    active = { child, exit };
    const endpoint = await within(Promise.race([
      readBoundEndpoint(child.stdout),
      exit.then(() => { throw new Error('Conversion router exited during startup'); }),
    ]), startupTimeoutMs, 'Conversion router startup timed out');
    if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) {
      throw new Error('Conversion router exited during startup');
    }
    const closed = exit.then(() => rm(directory, { recursive: true, force: true }));
    // The caller can inspect close failures even if the child exits between requests.
    void closed.catch(() => {});
    return {
      endpoint, pid: child.pid, directory, closed,
      stop: async () => { await stopChild(child, exit); await closed; },
    };
  } catch (error) {
    if (active) await stopChild(active.child, active.exit);
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

type RouterEntry = {
  upstream: string;
  started: Promise<ConversionRouter>;
  users: number;
  idleTimer?: ReturnType<typeof setTimeout>;
  stopping?: Promise<void>;
};

export class ConversionRouterPool {
  private readonly entries = new Map<string, RouterEntry>();
  private readonly installation: Pick<RouterOptions, 'executable' | 'scratchRoot'>;
  private readonly idleMs: number;
  private readonly reportCleanupError: (error: unknown) => void;
  private closing?: Promise<void>;

  constructor(
    installation: Pick<RouterOptions, 'executable' | 'scratchRoot'>,
    idleMs: number,
    reportCleanupError: (error: unknown) => void,
  ) {
    this.installation = installation;
    this.idleMs = idleMs;
    this.reportCleanupError = reportCleanupError;
  }

  async acquire(
    harness: ConversionHarness,
    connectionId: string,
    upstream: string,
  ): Promise<{ router: ConversionRouter; release: () => void }> {
    if (this.closing) throw new Error('The conversion router pool is closing');
    const key = JSON.stringify([harness, connectionId]);
    let entry = this.entries.get(key);
    if (entry?.stopping) {
      await entry.stopping;
      return this.acquire(harness, connectionId, upstream);
    }
    if (entry && entry.upstream !== upstream) {
      throw new Error('The conversion route changed while in use');
    }
    if (!entry) {
      const started = launchConversionRouter({ ...this.installation, harness, upstream });
      entry = { upstream, started, users: 0 };
      this.entries.set(key, entry);
      const created = entry;
      const forget = () => {
        clearTimeout(created.idleTimer);
        if (this.entries.get(key) === created) this.entries.delete(key);
      };
      void started.then((router) => { void router.closed.then(forget, forget); }, forget);
    }
    clearTimeout(entry.idleTimer);
    entry.users++;
    const acquired = entry;
    const router = await acquired.started;
    if (this.closing) throw new Error('The conversion router pool is closing');
    let released = false;
    return {
      router,
      release: () => {
        if (released) return;
        released = true;
        acquired.users--;
        if (!this.closing && acquired.users === 0 && this.entries.get(key) === acquired) {
          acquired.idleTimer = setTimeout(() => {
            void this.stop(acquired).catch(this.reportCleanupError);
          }, this.idleMs);
        }
      },
    };
  }

  close(): Promise<void> {
    this.closing ??= Promise.resolve().then(async () => {
      const results = await Promise.allSettled([...this.entries.values()].map((entry) => this.stop(entry)));
      const failures = results.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
      if (failures.length) throw new AggregateError(failures, 'Could not stop all conversion routers');
    });
    return this.closing;
  }

  private stop(entry: RouterEntry): Promise<void> {
    clearTimeout(entry.idleTimer);
    entry.stopping ??= entry.started.then((router) => router.stop(), () => {});
    return entry.stopping;
  }
}
