import { appendFile, chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import lockfile from 'proper-lockfile';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bundledMisePath, launcherRelease, managedLauncher, miseEnvironment, miseToolSlug, readManagedLauncherRelease, runMiseOperation } from './mise-installer';
import { managedMiseBinDir } from './managed-agent-home';
import * as progressMeter from './install-progress-meter';
import * as selectionModule from './install-source-race';
import { PlatformBuildMissingError } from './mise-distribution';

const mocks = vi.hoisted(() => ({ appRoot: '', run: vi.fn(), exec: vi.fn(), resolve: vi.fn(), info: vi.fn(), env: {} as NodeJS.ProcessEnv }));
vi.mock('@main/lib/logger', () => ({ log: { info: mocks.info, warn: vi.fn() } }));
vi.mock('@main/core/pty/pty-env', () => ({ buildAgentEnv: () => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY|SSL_CERT_FILE|SSL_CERT_DIR)$/i.test(key))),
  ...mocks.env,
}) }));
vi.mock('@gugu/session-core/exec', async (original) => {
  const real = await original<typeof import('@gugu/session-core/exec')>();
  return { ...real, execInProcessGroup: mocks.exec };
});
vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => mocks.appRoot } }));
vi.mock('./mise-process', async (original) => ({ ...(await original<typeof import('./mise-process')>()), runMiseProcess: mocks.run }));
vi.mock('./mise-distribution', async (original) => ({ ...(await original<typeof import('./mise-distribution')>()), resolveMiseDistribution: mocks.resolve }));
let home: string;
let entries: Array<{ version: string; install_path: string; installed: boolean }>;
const target = {
  kind: 'mise' as const,
  package: '@vendor/agent',
  binary: 'agent',
  backend: { kind: 'platform-archive' as const, executables: {} },
};
const npmTarget = {
  kind: 'mise' as const,
  package: '@vendor/js-agent',
  binary: 'agent',
  backend: { kind: 'npm' as const, node: '24.21.0' },
};
const tool = 'http:gugu-agent';
const version = '1.2.3-official-content';
const launcher = () => path.join(managedMiseBinDir(), process.platform === 'win32' ? 'agent.cmd' : 'agent');
let abort: AbortController | undefined;

const automatic = { kind: 'automatic' as const, fallbackRegistry: 'official', registries: ['official', 'npmmirror', 'huawei'] };

describe('common automatic installation execution', () => {
  it.each(['install', 'update'] as const)('%s retries one download failure after cleanup and reports the actual mirror', async (operation) => {
    const original = mocks.run.getMockImplementation()!;
    let attempts = 0;
    mocks.run.mockImplementation(async (command, args, options) => {
      if (args[0] === 'install' && attempts++ === 0) throw new Error('source download failed');
      return original(command, args, options);
    });
    const result = await runMiseOperation({ mise: { target, operation, source: automatic } });
    expect(result).toEqual({ success: true, data: { registry: 'npmmirror' } });
    expect(attempts).toBe(2);
    expect(mocks.run.mock.calls.map((c) => c[1][0])).toContain('uninstall');
    const reports = mocks.info.mock.calls.filter((c) => c[0].includes('source selection'));
    expect(reports).toHaveLength(1);
    expect(reports[0][1]).toMatchObject({ selected: 'official', reason: 'no-throughput-sample-use-default-order', candidates: ['official', 'npmmirror', 'huawei'] });
    const reportCall = mocks.info.mock.calls.findIndex((c) => c[0].includes('source selection'));
    const installCall = mocks.run.mock.calls.findIndex((c) => c[1][0] === 'install');
    expect(mocks.info.mock.invocationCallOrder[reportCall]).toBeLessThan(mocks.run.mock.invocationCallOrder[installCall]);
  });
  it('three source candidates still make at most two actual attempts', async () => {
    const original = mocks.run.getMockImplementation()!;
    mocks.run.mockImplementation(async (command, args, options) => {
      if (args[0] === 'install') throw new Error('download failed');
      return original(command, args, options);
    });
    expect((await runMiseOperation({ mise: { target, operation: 'install', source: automatic } })).success).toBe(false);
    expect(mocks.run.mock.calls.filter((c) => c[1][0] === 'install')).toHaveLength(2);
  });
  it.each(['cleanup', 'verification', 'cancel'] as const)('%s failure does not retry', async (failure) => {
    const original = mocks.run.getMockImplementation()!;
    const controller = new AbortController();
    if (failure === 'verification') mocks.exec.mockResolvedValue({ stdout: 'agent 9.9.9', stderr: '' });
    mocks.run.mockImplementation(async (command, args, options) => {
      if (failure === 'cleanup' && ['install', 'uninstall'].includes(args[0])) throw new Error('failed');
      if (failure === 'cancel' && args[0] === 'install') { controller.abort(); throw controller.signal.reason; }
      return original(command, args, options);
    });
    expect((await runMiseOperation({ mise: { target, operation: 'install', source: automatic }, signal: controller.signal })).success).toBe(false);
    expect(mocks.run.mock.calls.filter((c) => c[1][0] === 'install')).toHaveLength(1);
  });
  it('the prepared assistant tree uses the same policy and the exact final proxy environment', async () => {
    const selection = vi.spyOn(selectionModule, 'selectInstallSources');
    mocks.env = { HTTPS_PROXY: 'http://user:secret@127.0.0.1:7897', HTTP_PROXY: 'http://user:secret@127.0.0.1:7897', NO_PROXY: '.internal.test' };
    const preparation = { root: path.join(home, 'prepared/runtime'), launcherDir: path.join(home, 'prepared/entrypoints') };
    const result = await runMiseOperation({ mise: { target, operation: 'install', source: automatic } }, preparation);
    expect(result).toMatchObject({ success: true, data: { registry: 'official' } });
    const childEnv = mocks.run.mock.calls.find((c) => c[1][0] === 'install')![2].env;
    expect(childEnv).toMatchObject(mocks.env);
    expect(selection.mock.calls[0][0].env).toBe(childEnv);
    expect(selection.mock.calls[0][0].env.NO_PROXY).toBe(childEnv.NO_PROXY);
    expect(childEnv.MISE_DATA_DIR).toBe(path.join(preparation.root, 'data'));
    expect(await readFile(launcher(), 'utf8')).toBe('previous launcher');
    expect(JSON.stringify(mocks.info.mock.calls.filter((c) => c[0].includes('source selection')))).not.toMatch(/secret|7897|internal/);
  });
  it('an explicitly chosen source remains one attempt without a race', async () => {
    const original = mocks.run.getMockImplementation()!;
    mocks.run.mockImplementation(async (command, args, options) => { if (args[0] === 'install') throw new Error('download'); return original(command, args, options); });
    await runMiseOperation({ mise: { target, operation: 'install', source: { kind: 'explicit', registry: 'huawei' } } });
    expect(mocks.resolve).toHaveBeenCalledOnce();
    expect(mocks.resolve.mock.calls[0][1]).toBe('huawei');
    expect(mocks.run.mock.calls.filter((c) => c[1][0] === 'install')).toHaveLength(1);
  });
  it('all definite missing sources fail without attempting an incompatible platform package', async () => {
    mocks.resolve.mockRejectedValue(new PlatformBuildMissingError('not published'));
    const result = await runMiseOperation({ mise: { target, operation: 'install', source: automatic } });
    expect(result).toMatchObject({ success: false, error: { output: expect.stringContaining('No compatible platform release') } });
    expect(mocks.run.mock.calls.filter((c) => c[1][0] === 'install')).toHaveLength(0);
  });
  it('single-source and fallback updates cannot downgrade', async () => {
    const result = await runMiseOperation({ mise: { target, operation: 'update', minimumVersion: '9.0.0' } });
    expect(result).toMatchObject({ success: false, error: { output: expect.stringContaining('older release') } });
    expect(mocks.run.mock.calls.filter((c) => c[1][0] === 'install')).toHaveLength(0);
  });
});

beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), 'gugu mise '));
  mocks.appRoot = home;
  vi.stubEnv('GUGU_HOME', home);
  const binary = bundledMisePath();
  await mkdir(path.dirname(binary), { recursive: true });
  await writeFile(binary, 'bundled engine');
  await mkdir(managedMiseBinDir(), { recursive: true });
  await writeFile(launcher(), 'previous launcher');
  entries = [];
  abort = undefined;
  mocks.env = {};
  mocks.info.mockClear();
  mocks.exec.mockReset().mockResolvedValue({ stdout: 'agent 1.2.3', stderr: '' });
  mocks.resolve.mockReset().mockResolvedValue({ kind: 'platform-archive', tool, version: '1.2.3', installVersion: version, executable: 'bin/agent', config: '[tools]\n' });
  mocks.run.mockReset().mockImplementation(async (_command, args, options) => {
    if (args[0] === 'ls') return JSON.stringify(entries);
    if (args[0] === 'install') {
      const install_path = path.join(options.env.MISE_DATA_DIR, 'installs/http-gugu-agent', version);
      await mkdir(path.join(install_path, 'bin'), { recursive: true });
      await writeFile(path.join(install_path, 'bin/agent'), 'actual native program');
      entries.push({ version, install_path, installed: true });
      if (abort) { abort.abort(); options.signal.throwIfAborted(); }
      return '';
    }
    if (args[0] === 'uninstall') {
      for (const entry of entries) await rm(entry.install_path, { recursive: true, force: true });
      entries = [];
      return '';
    }
    throw new Error('Unexpected mise operation: ' + args.join(' '));
  });
});
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); await rm(home, { recursive: true, force: true }); });

describe('application-owned mise lifecycle', () => {
  it('prepares in an isolated tree without publishing or changing the active launcher', async () => {
    const preparation = { root: path.join(home, 'prepared/runtime'), launcherDir: path.join(home, 'prepared/entrypoints') };
    const result = await runMiseOperation({ mise: { target, operation: 'install' } }, preparation);
    expect(result.success).toBe(true);
    expect(await readFile(launcher(), 'utf8')).toBe('previous launcher');
    expect(await readFile(path.join(preparation.launcherDir, path.basename(launcher())), 'utf8')).toContain('http-gugu-agent');
    expect(entries[0].install_path.startsWith(preparation.root + path.sep)).toBe(true);
    expect(mocks.run.mock.calls.every(call => call[2].env.MISE_DATA_DIR === path.join(preparation.root, 'data'))).toBe(true);
  });
  it('publishes a stable launcher after verifying the installed executable, then removes through mise', async () => {
    expect((await runMiseOperation({ mise: { target, operation: 'install' } })).success).toBe(true);
    expect(await readFile(launcher(), 'utf8')).toContain('http-gugu-agent');
    expect(mocks.exec.mock.calls[0]![0]).toContain(version);
    expect((await runMiseOperation({ mise: { target, operation: 'uninstall', selectedPath: launcher() } })).success).toBe(true);
    expect(mocks.run.mock.calls.some((call) => JSON.stringify(call[1]) === JSON.stringify(['uninstall', '--all', tool]))).toBe(true);
    await expect(readFile(launcher())).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('an upgrade retains all earlier installed versions, including a long-running older program', async () => {
    const earlier = path.join(home, 'agents/mise/data/installs/http-gugu-agent', '0.9.0');
    await mkdir(path.join(earlier, 'bin'), { recursive: true });
    await writeFile(path.join(earlier, 'bin/agent'), 'long-running old program');
    entries = [{ version: '0.9.0', install_path: earlier, installed: true }];
    expect((await runMiseOperation({ mise: { target, operation: 'update' } })).success).toBe(true);
    expect(mocks.run.mock.calls.some(call => call[1][0] === 'uninstall')).toBe(false);
    expect(await readFile(path.join(earlier, 'bin/agent'), 'utf8')).toBe('long-running old program');
    expect(entries.map(entry => entry.version)).toEqual(['0.9.0', version]);
  });
  // On a clean Windows machine the first launch of the bundled mise.exe waits for Defender to scan it (13 s and 32 s
  // measured), whichever command it is. The old pre-download `--version` + `ls` under a 15 s deadline failed 2 of 3.
  it('runs mise once before the download, and no mise command has a deadline shorter than a first launch', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const commands: Array<{ args: string[]; deadline?: number }> = [];
    const run = mocks.run.getMockImplementation()!;
    mocks.run.mockImplementation(async (command, args, options) => {
      commands.push({ args, deadline: args[0] === 'install' ? undefined : timeout.mock.lastCall?.[0] });
      return run(command, args, options);
    });
    expect((await runMiseOperation({ mise: { target, operation: 'install' } })).success).toBe(true);
    expect((await runMiseOperation({ mise: { target, operation: 'uninstall', selectedPath: launcher() } })).success).toBe(true);
    expect(commands.slice(0, commands.findIndex(c => c.args[0] === 'install')).map(c => c.args)).toEqual([['ls', '--json', tool]]);
    const deadlines = commands.filter(c => c.args[0] !== 'install').map(c => c.deadline);
    expect(deadlines.length).toBeGreaterThan(2);
    expect(deadlines.every(ms => ms !== undefined && ms >= 60_000)).toBe(true);
  });
  // An install the desktop stopped half-way (the mise process group is killed with it, nothing after it runs): the
  // launcher is what makes an agent installed, and it is only published after mise finished and the program verified.
  it('a fresh install has no launcher while mise is still installing', async () => {
    await rm(launcher());
    let launcherDuringInstall: string | null = 'unread';
    const install = mocks.run.getMockImplementation()!;
    mocks.run.mockImplementation(async (command, args, options) => {
      if (args[0] === 'install') launcherDuringInstall = await readFile(launcher(), 'utf8').catch(() => null);
      return install(command, args, options);
    });
    expect((await runMiseOperation({ mise: { target, operation: 'install' } })).success).toBe(true);
    expect(launcherDuringInstall).toBeNull();
    expect(await readFile(launcher(), 'utf8')).toContain('http-gugu-agent');
  });

  // What a killed `mise install` leaves (measured on the bundled mise 2026.9.12, killed while downloading and while
  // installing): the half-written version directory is on disk, and `mise ls` reports it as not installed. The next
  // install runs mise again and publishes, ❌ treating the leftover as an existing installation.
  it('installs again over what a killed install left behind', async () => {
    await rm(launcher());
    const leftover = path.join(home, 'agents/mise/data/installs/http-gugu-agent', version);
    await mkdir(leftover, { recursive: true });
    entries = [{ version, install_path: leftover, installed: false }];
    expect((await runMiseOperation({ mise: { target, operation: 'install' } })).success).toBe(true);
    expect(mocks.run.mock.calls.filter((call) => call[1][0] === 'install')).toHaveLength(1);
    expect(await readFile(launcher(), 'utf8')).toContain('http-gugu-agent');
  });

  /**
   * 换源重试要分得出「取包那一段挂了」与「装完之后才挂」(#6157)。这一层不判断换不换,
   * 只负责如实说这次挂在哪一段 —— 判据在 `isDownloadStageFailure`。
   */
  it('取包那一段挂了要标出来 —— 上层据此换个源再试一次', async () => {
    mocks.resolve.mockRejectedValueOnce(new Error('Package metadata HTTP 502'));
    const result = await runMiseOperation({ mise: { target, operation: 'install', source: { kind: 'explicit', registry: 'npmmirror' } } });
    expect(result).toMatchObject({ success: false, error: { stage: 'download' } });
  });

  it('下载到一半断了:失败里带着停下那一刻的进度(哪一步、已下多少 / 共多少)—— 说得清卡在哪一步(#7199)', async () => {
    mocks.run.mockImplementation(async (_command, args, options) => {
      if (args[0] === 'ls') return JSON.stringify(entries);
      if (args[0] === 'uninstall') return '';
      if (args[0] === 'install') {
        options.onOutput?.(tool + '@' + version + '  downloading  41.0s  45.0/119.5 MB · 1.1 MB/s');
        throw new Error('error sending request: connection reset by peer');
      }
      throw new Error('Unexpected mise operation: ' + args.join(' '));
    });
    const result = await runMiseOperation({ mise: { target, operation: 'install' } });
    expect(result).toMatchObject({ success: false, error: { type: 'command-failed', stage: 'download', lastProgress: { phase: 'downloading' } } });
    const last = !result.success && 'lastProgress' in result.error ? result.error.lastProgress : undefined;
    expect(last?.bytesTotal).toBeGreaterThan(last?.bytesDone ?? 0);
    expect(last?.bytesDone).toBeGreaterThan(0);
  });

  it('还没开始下就挂了(取清单那一步):停在 resolving,❌ 编一个字节数', async () => {
    mocks.resolve.mockRejectedValueOnce(new Error('Package metadata HTTP 502'));
    const result = await runMiseOperation({ mise: { target, operation: 'install' } });
    expect(result).toMatchObject({ success: false, error: { lastProgress: { phase: 'resolving' } } });
    const last = !result.success && 'lastProgress' in result.error ? result.error.lastProgress : undefined;
    expect(last?.bytesDone).toBeUndefined();
  });

  it('阴控:装完之后才挂的失败不带这个标记 —— 换源不会有任何不同', async () => {
    // 装出来的东西自报的版本与选定的发行物对不上。这时换个镜像重来一遍只是把同一件事做两遍。
    mocks.exec.mockResolvedValue({ stdout: 'agent 9.9.9', stderr: '' });
    const result = await runMiseOperation({ mise: { target, operation: 'install' } });
    expect(result.success).toBe(false);
    expect(result).not.toMatchObject({ error: { stage: 'download' } });
  });

  it('rejects the unfiltered inventory shape instead of silently interpreting it as no installations', async () => {
    const run = mocks.run.getMockImplementation()!;
    mocks.run.mockImplementation(async (command, args, options) => args[0] === 'ls' ? '{}' : run(command, args, options));
    const result = await runMiseOperation({ mise: { target, operation: 'install' } });
    expect(result).toMatchObject({ success: false, error: { output: 'Invalid mise installation inventory' } });
    expect(await readFile(launcher(), 'utf8')).toBe('previous launcher');
  });

  it('reports a lock-release failure after publication without hiding that the new entry is active', async () => {
    const lock = lockfile.lock;
    vi.spyOn(lockfile, 'lock').mockImplementationOnce(async (...args) => {
      const release = await lock(...args);
      return async () => { await release(); throw new Error('release failed'); };
    });
    const result = await runMiseOperation({ mise: { target, operation: 'install' } });
    expect(result).toMatchObject({ success: false, error: { type: 'command-failed', output: expect.stringContaining('new installation is active') } });
    expect(await readFile(launcher(), 'utf8')).toContain('http-gugu-agent');
  });

  it('retains the old launcher if mise installs bytes reporting the wrong version', async () => {
    mocks.exec.mockResolvedValue({ stdout: 'agent 0.0.0', stderr: '' });
    const result = await runMiseOperation({ mise: { target, operation: 'update' } });
    expect(result).toMatchObject({ success: false, error: { type: 'command-failed' } });
    expect(await readFile(launcher(), 'utf8')).toBe('previous launcher');
    expect(entries).toEqual([]);
  });
  it('cleans the new version on cancellation and leaves the published entry unchanged', async () => {
    abort = new AbortController();
    const result = await runMiseOperation({ signal: abort.signal, mise: { target, operation: 'install' } });
    expect(result).toMatchObject({ success: false, error: { type: 'cancelled' } });
    expect(await readFile(launcher(), 'utf8')).toBe('previous launcher');
    expect(entries).toEqual([]);
    const cleanup = mocks.run.mock.calls.find((call) => call[1][0] === 'uninstall');
    expect(cleanup?.[2].signal).toBeInstanceOf(AbortSignal);
    expect(cleanup?.[2].signal.aborted).toBe(false);
  });
  /**
   * npm backend —— 纯 JS 的那些家(#6098)。这一组钉三件事:配置里必须钉 node、
   * 安装命令里必须带上 node、发布出去的启动器必须把 node 的 bin 目录前置到 PATH。
   */
  describe('npm 后端', () => {
    const nodeInstall = () => path.join(home, 'agents/mise/data/installs/node/24.21.0');
    const packageInstall = () => path.join(home, 'agents/mise/data/installs/npm-vendor-js-agent/4.5.6');

    beforeEach(() => {
      mocks.resolve.mockResolvedValue({
        kind: 'npm',
        tool: 'npm:@vendor/js-agent',
        version: '4.5.6',
        installVersion: '4.5.6',
        node: '24.21.0',
        config: '[tools]\nnode = "24.21.0"\n"npm:@vendor/js-agent" = "4.5.6"\n',
        env: { NPM_CONFIG_REGISTRY: 'https://registry.npmjs.org' },
      });
      mocks.exec.mockResolvedValue({ stdout: '4.5.6', stderr: '' });
      const run = mocks.run.getMockImplementation()!;
      mocks.run.mockImplementation(async (command, args, options) => {
        if (args[0] === 'ls' && args[2] === 'node') {
          return JSON.stringify([{ version: '24.21.0', install_path: nodeInstall(), installed: true }]);
        }
        if (args[0] === 'install') {
          // aube 落在 `node_modules/.bin/`;mise 的 node 发行包把 node 放在 bin/。
          await mkdir(path.join(packageInstall(), 'node_modules', '.bin'), { recursive: true });
          await writeFile(path.join(packageInstall(), 'node_modules', '.bin', 'agent'), '#!/usr/bin/env node\n');
          await mkdir(path.join(nodeInstall(), 'bin'), { recursive: true });
          await writeFile(path.join(nodeInstall(), 'bin', process.platform === 'win32' ? 'node.exe' : 'node'), 'node');
          entries.push({ version: '4.5.6', install_path: packageInstall(), installed: true });
          return '';
        }
        return run(command, args, options);
      });
    });

    it('npm 的 registry 补充不改变探测和真实子进程的代理/NO_PROXY', async () => {
      const selection = vi.spyOn(selectionModule, 'selectInstallSources');
      mocks.env = { HTTPS_PROXY: 'http://127.0.0.1:7897', HTTP_PROXY: 'http://127.0.0.1:7897', NO_PROXY: '.internal.test' };
      expect((await runMiseOperation({ mise: { target: npmTarget, operation: 'install', source: automatic } })).success).toBe(true);
      const sampledEnv = selection.mock.calls[0][0].env;
      const childEnv = mocks.run.mock.calls.find((call) => call[1][0] === 'install')![2].env;
      expect(sampledEnv).toMatchObject(mocks.env);
      expect(childEnv).toEqual({ ...sampledEnv, NPM_CONFIG_REGISTRY: 'https://registry.npmjs.org' });
    });

    it('node 与包一条命令一起装,下载源经 NPM_CONFIG_REGISTRY 递给 mise', async () => {
      const result = await runMiseOperation({ mise: { target: npmTarget, operation: 'install' } });
      expect(result.success).toBe(true);
      const install = mocks.run.mock.calls.find((call) => call[1][0] === 'install')!;
      // 顺序有意义:mise 把 node 当安装依赖,它没装好就直接拒绝装包(实测)。
      expect(install[1]).toEqual(['install', 'node@24.21.0', 'npm:@vendor/js-agent@4.5.6']);
      expect(install[2].env.NPM_CONFIG_REGISTRY).toBe('https://registry.npmjs.org');
      // 托管配置写下去的就是解析器给的那份(钉着 node)。
      expect(await readFile(path.join(home, 'agents/mise/operations/agent/global.toml'), 'utf8'))
        .toContain('node = "24.21.0"');
    });

    it('启动器把咕咕自己那份 node 前置到 PATH —— 那个壳是 `#!/usr/bin/env node`', async () => {
      // 阴控见 `managedLauncher` 那一组:平台归档那条后端不写 PATH 行。
      expect((await runMiseOperation({ mise: { target: npmTarget, operation: 'install' } })).success).toBe(true);
      const published = await readFile(launcher(), 'utf8');
      expect(published).toContain(path.join('node_modules', '.bin', 'agent'));
      expect(published).toContain(process.platform === 'win32' ? 'set "PATH=' : 'PATH=');
      if (process.platform !== 'win32') expect(published).toContain(path.join(nodeInstall(), 'bin'));
    });

    it('装完验版本交给 execInProcessGroup:包壳由它经 planDirectSpawn 做,超时时整树停(Windows 的 .cmd 入口)', async () => {
      // w1 真机 2026-09-22:从前这里手拼 `'"' + exe + '" --version'` 交给 execFile,Node 把引号再转义一遍,
      // cmd 报「系统找不到指定的路径」,装好的包被回滚 —— Windows 上 npm 那条托管安装全挂。
      // execFile 自带的超时只杀得到 cmd 壳 ⇒ 版本探测交给执行层的进程组那条路,原路径原样交出去。
      expect((await runMiseOperation({ mise: { target: npmTarget, operation: 'install' } })).success).toBe(true);
      const [exe, args, options] = mocks.exec.mock.calls.at(-1)!;
      expect(exe).toContain(path.join('node_modules', '.bin', 'agent'));
      expect(args).toEqual(['--version']);
      expect(options).toMatchObject({ timeout: 15_000 });
    });

    it('mise 没报出那份 node 就判失败 —— ❌ 不发布一个跑不起来的启动器', async () => {
      const run = mocks.run.getMockImplementation()!;
      mocks.run.mockImplementation(async (command, args, options) =>
        args[0] === 'ls' && args[2] === 'node' ? '[]' : run(command, args, options));
      const result = await runMiseOperation({ mise: { target: npmTarget, operation: 'install' } });
      expect(result).toMatchObject({ success: false, error: { output: expect.stringContaining('node runtime') } });
      expect(await readFile(launcher(), 'utf8')).toBe('previous launcher');
    });

    it('包里没有那个名字的可执行文件就响亮报错,❌ 不猜一个路径', async () => {
      const run = mocks.run.getMockImplementation()!;
      mocks.run.mockImplementation(async (command, args, options) => {
        if (args[0] === 'install') {
          await mkdir(path.join(packageInstall(), 'node_modules', '.bin'), { recursive: true });
          entries.push({ version: '4.5.6', install_path: packageInstall(), installed: true });
          return '';
        }
        return run(command, args, options);
      });
      const result = await runMiseOperation({ mise: { target: npmTarget, operation: 'install' } });
      expect(result).toMatchObject({ success: false, error: { output: expect.stringContaining('has no "agent" executable') } });
    });

    it('卸载走 npm 那个工具名', async () => {
      expect((await runMiseOperation({ mise: { target: npmTarget, operation: 'install' } })).success).toBe(true);
      expect((await runMiseOperation({ mise: { target: npmTarget, operation: 'uninstall', selectedPath: launcher() } })).success).toBe(true);
      expect(mocks.run.mock.calls.some((call) => JSON.stringify(call[1]) === JSON.stringify(['uninstall', '--all', 'npm:@vendor/js-agent']))).toBe(true);
    });

    /**
     * 判「卡住」看的是真实进展,不是 mise 出不出声。实测(CodeBuddy 61MB):包边下边解进 aube 的 store,
     * mise 那一整段只刷一行不变的 `fetching … 97/106 pkgs · 5.9 MiB`,installs 目录要到最后才长。
     * 计时器假的(只假 setTimeout / setInterval),量目录的 I/O 是真的:模拟三分钟、一声不出。
     */
    describe('下包那一段 mise 一声不出', () => {
      let sampleCompleted: (() => void) | undefined;
      const files = () => path.join(home, 'agents/mise/cache/npm/aube/store/v1/files');
      /** 别家早先装进 store 的一个文件。 */
      const earlier = () => path.join(files(), 'ab', 'earlier-package-file');
      const silentFetch = (each: 'land' | 'nothing' | 'rewrite-earlier') => {
        const run = mocks.run.getMockImplementation()!;
        mocks.run.mockImplementation(async (command, args, options) => {
          if (args[0] === 'install') {
            const blob = path.join(files(), '.aube-stream-test');
            for (let step = 0; step < 36; step += 1) {
              if (each === 'land') await appendFile(blob, Buffer.alloc(64 * 1024));
              if (each === 'rewrite-earlier') await writeFile(earlier(), Buffer.alloc(64 * 1024));
              const sampled = new Promise<void>((resolve) => { sampleCompleted = resolve; });
              await vi.advanceTimersByTimeAsync(5_000);
              // 等本轮真实 readdir/stat 的结果已交给安装器，再推进假时间。
              await sampled;
              options.signal.throwIfAborted();
            }
          }
          return run(command, args, options);
        });
      };
      beforeEach(async () => {
        sampleCompleted = undefined;
        const start = progressMeter.startInstallProgressMeter;
        vi.spyOn(progressMeter, 'startInstallProgressMeter').mockImplementation((options) => start({
          ...options,
          onSample(sample) {
            options.onSample(sample);
            const completed = sampleCompleted;
            sampleCompleted = undefined;
            completed?.();
          },
        }));
        await mkdir(path.dirname(earlier()), { recursive: true });
        await writeFile(earlier(), Buffer.alloc(64 * 1024));
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
      });
      afterEach(() => { vi.useRealTimers(); });

      it('字节一直落进 aube 的 store:不算卡住,装得完', async () => {
        silentFetch('land');
        expect(await runMiseOperation({ mise: { target: npmTarget, operation: 'install' } })).toMatchObject({ success: true });
      });

      it('阴控:同样一声不出、也没有字节落地 —— 一分钟后判卡住', async () => {
        silentFetch('nothing');
        expect(await runMiseOperation({ mise: { target: npmTarget, operation: 'install' } }))
          .toMatchObject({ success: false, error: { type: 'stalled', stage: 'download' } });
      });

      it('store 里早先就有的文件被反复改写(大小不变):最多涨一次,照样判卡住', async () => {
        silentFetch('rewrite-earlier');
        expect(await runMiseOperation({ mise: { target: npmTarget, operation: 'install' } }))
          .toMatchObject({ success: false, error: { type: 'stalled', stage: 'download' } });
      });
    });
  });

  describe('managedLauncher', () => {
    it('平台归档那条不写 PATH 行 —— 归档里就是一个可直接执行的文件', () => {
      const script = managedLauncher(path.join(managedMiseBinDir(), '..', 'x', 'agent'));
      expect(script).not.toContain('PATH');
    });
    it('注册表给的启动参数排在调用方参数前面', () => {
      const script = managedLauncher('/x/agy_acp_server.par', undefined, '1.2.1', ['--uid=']);
      expect(script.endsWith("exec '/x/agy_acp_server.par' '--uid=' \"$@\"\n")).toBe(true);
    });
    it('发行标记写进启动器,读得回来 —— 不执行它也知道装的是哪个版本(#6335)', () => {
      const script = managedLauncher(path.join(managedMiseBinDir(), '..', 'x', 'agent'), undefined, '1.1.1');
      expect(launcherRelease(script)).toBe('1.1.1');
      expect(launcherRelease('#!/bin/sh\nexec /x "$@"\n')).toBeNull();
      expect(launcherRelease('@echo off\r\nrem gugu-release: 2.0.0-beta.1\r\n"%~dp0x" %*\r\n')).toBe('2.0.0-beta.1');
      expect(launcherRelease('# gugu-release: not-a-version\n')).toBeNull();
    });
  });

  describe('ACP 注册表形态(#6335)', () => {
    const acpTarget = {
      kind: 'mise' as const,
      package: 'antigravity-acp',
      binary: 'agent',
      backend: { kind: 'acp-registry' as const, agentId: 'antigravity-acp' },
    };
    beforeEach(() => {
      mocks.resolve.mockResolvedValue({ kind: 'acp-registry', tool, version: '1.1.1', installVersion: version, executable: 'bin/agent', config: '[tools]\n' });
      const base = mocks.run.getMockImplementation()!;
      mocks.run.mockImplementation(async (command, args, options) => {
        const output = await base(command, args, options);
        if (args[0] === 'install') await chmod(path.join(home, 'agents/mise/data/installs/http-gugu-agent', version, 'bin/agent'), 0o755);
        return output;
      });
    });

    it('❌ 不执行装出来的 ACP 服务验版本;启动器指向 cmd 那个文件并带发行标记', async () => {
      expect((await runMiseOperation({ mise: { target: acpTarget, operation: 'install' } })).success).toBe(true);
      expect(mocks.exec).not.toHaveBeenCalled();
      const published = await readFile(launcher(), 'utf8');
      expect(published).toContain(path.join('http-gugu-agent', version, 'bin', 'agent'));
      expect(launcherRelease(published)).toBe('1.1.1');
      expect(await readManagedLauncherRelease(launcher())).toBe('1.1.1');
    });

    it('cmd 指的文件不在就失败并回滚,❌ 不发布一个指向空处的启动器', async () => {
      mocks.resolve.mockResolvedValue({ kind: 'acp-registry', tool, version: '1.1.1', installVersion: version, executable: 'bin/missing', config: '[tools]\n' });
      const result = await runMiseOperation({ mise: { target: acpTarget, operation: 'install' } });
      expect(result.success).toBe(false);
      expect(await readFile(launcher(), 'utf8')).toBe('previous launcher');
    });

    it('只认咕咕自己 bin 目录里的启动器 —— 别处同名文件不算', async () => {
      const elsewhere = path.join(home, 'agent');
      await writeFile(elsewhere, managedLauncher('/x', undefined, '1.1.1'));
      expect(await readManagedLauncherRelease(elsewhere)).toBeNull();
    });
  });

  describe('miseToolSlug', () => {
    it('照 mise 折目录名的规则来 —— 量进度要按它找目录', () => {
      // 实测(2026-09-22,2026.9.12):这两行就是盘上真实的目录名。
      expect(miseToolSlug('npm:@google/gemini-cli')).toBe('npm-google-gemini-cli');
      expect(miseToolSlug('http:gugu-claude')).toBe('http-gugu-claude');
      // 实测(2026-09-23,同一份 mise):下划线也折成连字符。
      expect(miseToolSlug('http:gugu-agy_acp_server')).toBe('http-gugu-agy-acp-server');
    });
  });

  it('isolates mise configuration while forwarding only required OS and transport inputs', () => {
    const env = miseEnvironment(home, path.join(home, 'owned.toml'), {
      HOME: '/user', PATH: '/bin', HTTPS_PROXY: 'http://proxy:8080', ANTHROPIC_API_KEY: 'not-for-installer', MISE_GLOBAL_CONFIG_FILE: '/user/mise.toml', MISE_NO_CONFIG: '1',
    });
    expect(env.HOME).toBe('/user');
    expect(env.HTTPS_PROXY).toBe('http://proxy:8080');
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.MISE_NO_CONFIG).toBeUndefined();
    expect(env.MISE_GLOBAL_CONFIG_FILE).toBe(path.join(home, 'owned.toml'));
    expect(env.MISE_SYSTEM_CONFIG_DIR).toBe(path.join(home, 'system'));
    // The pinned engine never checks the network for a newer mise of its own.
    expect(env.MISE_DISABLE_UPDATE_WARNING).toBe('1');
  });
});
