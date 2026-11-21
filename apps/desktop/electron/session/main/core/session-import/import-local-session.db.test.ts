// 导入本机会话：落点解析与会话绑定。
// 关心的是「导入进来的会话是不是原来那条」——绑错 id 就会开出一个空会话，而界面上看不出来。
import { openFixture } from '@tooling/utils/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDb } from '@main/db/client';
import type { CreateSessionParams } from '@shared/core/sessions/create-session';
import type { ImportLocalSessionParams } from '@shared/core/session-import/session-import';

const mocks = vi.hoisted(() => ({
  db: undefined as AppDb | undefined,
  createSession: vi.fn(),
  createLocalProject: vi.fn(),
  ensureRepositoryWorkspace: vi.fn(() => 'workspace-repo-1'),
  openProject: vi.fn(),
  preview: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('@main/db/client', () => ({
  get db() {
    if (!mocks.db) throw new Error('Test database not initialized');
    return mocks.db;
  },
}));
vi.mock('@main/core/sessions/session-service', () => ({
  sessionService: { createSession: mocks.createSession },
}));
vi.mock('@main/core/projects/operations/create-local-project', () => ({
  createLocalProject: mocks.createLocalProject,
}));
vi.mock('@main/core/projects/operations/ensure-repository-workspace', () => ({
  ensureRepositoryWorkspace: mocks.ensureRepositoryWorkspace,
}));
vi.mock('@main/core/projects/operations/openProject', () => ({
  openProject: mocks.openProject,
}));
vi.mock('@main/lib/logger', () => ({ log: { warn: mocks.warn } }));
vi.mock('./host-source', () => ({
  getLocalSessionSource: () => ({ preview: mocks.preview }),
}));

import { bindLocalSession, importLocalSession } from './import-local-session';
import { humanizeRpcError } from '@renderer/features/session-import/humanize-error';
import { localizeImportError } from '@renderer/features/session-import/import-error-copy';
import { enUSSessionWorkflowMessages, zhCNSessionWorkflowMessages } from '@renderer/localization/messages-session-workflows';

/**
 * 这条错到用户界面上说的那句:本机 IPC 的外壳 + 渲染层按当前语言查词条(真词条表,{name}/{reason} 插值)。
 * 用它断言「界面上有本地化的原因」,而不是只看主进程抛了什么码。
 */
function uiSays(error: Error, locale: 'en' | 'zh'): string {
  const catalog = (locale === 'en' ? enUSSessionWorkflowMessages : zhCNSessionWorkflowMessages) as Record<string, string>;
  const translate = ((key: string, values?: Record<string, unknown>) =>
    (catalog[key] ?? key).replace(/\{(\w+)\}/g, (_, name: string) => String(values?.[name] ?? ''))) as never;
  const wrapped = new Error(`Error invoking remote method 'sessionImport.importLocalSession': Error: ${error.message}`);
  return localizeImportError(humanizeRpcError(wrapped, 'unknown'), translate);
}

const CLAUDE_SESSION = '11111111-2222-3333-4444-555555555555';
const CODEX_SESSION = '019fa62b-9ddb-7373-a1b8-807548106894';

function previewOf(overrides: Partial<{ providerSessionId: string; cwd: string | null; title: string }>) {
  return {
    providerSessionId: overrides.providerSessionId ?? CLAUDE_SESSION,
    title: overrides.title ?? '把登录页按钮改成设计稿的颜色',
    cwd: overrides.cwd === undefined ? '/work/webapp' : overrides.cwd,
    turnCount: 12,
    head: [],
    tail: [],
  };
}

function lastCreateSessionParams(): CreateSessionParams {
  return mocks.createSession.mock.calls.at(-1)?.[0] as CreateSessionParams;
}

/**
 * 导入是**另一个动词**(spec session-resume):provider 自己的会话 id 挂在 origin 上,
 * 而不是「新建时顺手多带一个字段」—— 后者曾经让「导入」与「新建」共用同一条路。
 */
function importedProviderSessionId(params: CreateSessionParams): string | undefined {
  const origin = params.sessionConfig.initialSession?.origin;
  return origin?.kind === 'import' ? origin.providerSessionId : undefined;
}

describe('importLocalSession', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;

  beforeEach(async () => {
    fixture = await openFixture('empty');
    mocks.db = fixture.db;
    mocks.createSession.mockReset();
    mocks.createSession.mockResolvedValue({ success: true, data: {} });
    mocks.createLocalProject.mockReset();
    mocks.createLocalProject.mockResolvedValue({
      success: true,
      data: {
        type: 'local',
        id: 'project-new',
        name: 'webapp',
        path: '/work/webapp',
        baseRef: null,
        repositoryWorkspaceId: 'workspace-repo-1',
        createdAt: '',
        updatedAt: '',
      },
    });
    mocks.openProject.mockReset();
    mocks.openProject.mockResolvedValue({ success: true, data: { repositoryWorkspaceId: null } });
    mocks.preview.mockReset();
    mocks.preview.mockResolvedValue(previewOf({}));
    mocks.warn.mockReset();
  });

  afterEach(() => {
    fixture.close();
    mocks.db = undefined;
  });

  describe('会话绑定', () => {
    it('claude 会话用原会话 id 当 conversation id（claude CLI 就是拿它 resume 的）', async () => {
      const result = await importLocalSession({
        engine: 'claude-code',
        providerSessionId: CLAUDE_SESSION,
        filePath: '/home/u/.claude/projects/-work-webapp/session.jsonl',
        title: '标题',
        cwd: '/work/webapp',
      });

      expect(result.sessionId).toBe(CLAUDE_SESSION);
      expect(importedProviderSessionId(lastCreateSessionParams())).toBe(CLAUDE_SESSION);
    });

    it('codex 会话把原会话 id 放在 sessionId 上，conversation id 另取（codex 靠 sessionId resume）', async () => {
      mocks.preview.mockResolvedValue(previewOf({ providerSessionId: CODEX_SESSION }));

      const result = await importLocalSession({
        engine: 'codex',
        providerSessionId: CODEX_SESSION,
        filePath: '/home/u/.codex/sessions/2026/07/30/rollout-x.jsonl',
        title: '标题',
        cwd: '/work/webapp',
      });

      expect(result.sessionId).not.toBe(CODEX_SESSION);
      expect(importedProviderSessionId(lastCreateSessionParams())).toBe(CODEX_SESSION);
    });

    it('默认和显式通用都进聊天腿,显式终端照常走终端腿,续的仍是原会话 id', async () => {
      const params = {
        engine: 'claude-code' as const,
        providerSessionId: CLAUDE_SESSION,
        filePath: '/f.jsonl',
        title: '标题',
        cwd: '/work/webapp',
      };
      await importLocalSession(params);
      expect(lastCreateSessionParams().sessionConfig.initialSession?.type).toBe('acp');

      await importLocalSession({ ...params, sessionView: 'general' });
      expect(lastCreateSessionParams().sessionConfig.initialSession?.type).toBe('acp');
      expect(importedProviderSessionId(lastCreateSessionParams())).toBe(CLAUDE_SESSION);
      await importLocalSession({ ...params, sessionView: 'code' });
      expect(lastCreateSessionParams().sessionConfig.initialSession?.type).toBe('pty');
    });

    it('provider 按引擎映射到会话页的 agent id', async () => {
      await importLocalSession({
        engine: 'claude-code',
        providerSessionId: CLAUDE_SESSION,
        filePath: '/f.jsonl',
        title: '标题',
        cwd: '/work/webapp',
      });

      expect(lastCreateSessionParams().sessionConfig.initialSession?.provider).toBe('claude');
    });

    it('以原件里的会话 id 为准，不信渲染层传来的那个', async () => {
      mocks.preview.mockResolvedValue(previewOf({ providerSessionId: CLAUDE_SESSION }));

      await importLocalSession({
        engine: 'claude-code',
        providerSessionId: '渲染层传来的过期 id',
        filePath: '/f.jsonl',
        title: '标题',
        cwd: '/work/webapp',
      });

      expect(importedProviderSessionId(lastCreateSessionParams())).toBe(CLAUDE_SESSION);
    });
  });

  describe('落点', () => {
    it('会话跑在原来的工作目录，不另开 worktree', async () => {
      await importLocalSession({
        engine: 'claude-code',
        providerSessionId: CLAUDE_SESSION,
        filePath: '/f.jsonl',
        title: '标题',
        cwd: '/work/webapp',
      });

      expect(lastCreateSessionParams().workspaceConfig).toMatchObject({
        workspace: { kind: 'repository-instance', workspaceId: 'workspace-repo-1' },
      });
    });

    it('这个目录已经是某个项目时直接用它，不再建一个', async () => {
      fixture.sqlite.exec(`
        INSERT INTO projects (id, name, path, repository_workspace_id)
          VALUES ('project-existing', 'webapp', '/work/webapp', 'workspace-existing');
      `);

      const result = await importLocalSession({
        engine: 'claude-code',
        providerSessionId: CLAUDE_SESSION,
        filePath: '/f.jsonl',
        title: '标题',
        cwd: '/work/webapp',
      });

      expect(result.projectId).toBe('project-existing');
      expect(mocks.createLocalProject).not.toHaveBeenCalled();
    });

    it('目录不是仓库根时按原目录建项目（不归一化到仓库根，否则 resume 找不到原会话）', async () => {
      await importLocalSession({
        engine: 'claude-code',
        providerSessionId: CLAUDE_SESSION,
        filePath: '/f.jsonl',
        title: '标题',
        cwd: '/work/webapp',
      });

      expect(mocks.createLocalProject).toHaveBeenCalledWith(
        expect.objectContaining({ path: '/work/webapp', exactPath: true })
      );
    });

    it('目录还不是项目时把它加成项目，且放行非 git 目录', async () => {
      await importLocalSession({
        engine: 'claude-code',
        providerSessionId: CLAUDE_SESSION,
        filePath: '/f.jsonl',
        title: '标题',
        cwd: '/work/webapp',
      });

      expect(mocks.createLocalProject).toHaveBeenCalledWith(
        // #609 导入是替人登记的:在 ~ 里跑的会话导进来是 workspace,❌ 多出一个「~」项目。
        expect.objectContaining({ path: '/work/webapp', allowNonGit: true, reuseExisting: true, automatic: true })
      );
    });
  });

  // 真机实测抓到的：项目在库里建出来了，但没挂进 projectManager，建任务就报 project-not-found
  // ——一个指向错误方向的报错（项目明明在）。复用既有项目那条路尤其致命：重试永远走它，永久失败。
  describe('落点项目必须挂载', () => {
    it('新建的项目要挂载', async () => {
      await importLocalSession({
        engine: 'claude-code',
        providerSessionId: CLAUDE_SESSION,
        filePath: '/f.jsonl',
        title: '标题',
        cwd: '/work/webapp',
      });

      expect(mocks.openProject).toHaveBeenCalledWith('project-new');
    });

    it('复用已存在的项目时同样要挂载（否则重试永远失败）', async () => {
      fixture.sqlite.exec(`
        INSERT INTO projects (id, name, path, repository_workspace_id)
          VALUES ('project-existing', 'webapp', '/work/webapp', 'workspace-existing');
      `);

      await importLocalSession({
        engine: 'claude-code',
        providerSessionId: CLAUDE_SESSION,
        filePath: '/f.jsonl',
        title: '标题',
        cwd: '/work/webapp',
      });

      expect(mocks.openProject).toHaveBeenCalledWith('project-existing');
      expect(mocks.createLocalProject).not.toHaveBeenCalled();
    });

    it('挂不上就停下，界面上有本地化的原因（不是只剩一句打不开），原始报错进日志，不留一个建不了任务的项目', async () => {
      const gitSays = 'fatal: not a git repository (or any of the parent directories): .git';
      mocks.openProject.mockResolvedValue({ success: false, error: { type: 'error', message: gitSays } });

      const failure = await importLocalSession({
        engine: 'claude-code',
        providerSessionId: CLAUDE_SESSION,
        filePath: '/f.jsonl',
        title: '标题',
        cwd: '/work/webapp',
      }).catch((error: Error) => error);

      expect((failure as Error).message).toBe('project-not-git:webapp');
      expect(uiSays(failure as Error, 'en')).toBe('The folder webapp could not be opened as a project: it is not a Git repository');
      expect(uiSays(failure as Error, 'zh')).toBe('无法把文件夹 webapp 作为项目打开：它不是 Git 仓库');
      // 原始报错(git 的输出)与完整目录只进日志。
      expect(mocks.warn).toHaveBeenCalledWith(
        '[session-import] import failed: project-not-git',
        expect.objectContaining({ directory: '/work/webapp', message: gitSays }),
      );
      expect(mocks.createSession).not.toHaveBeenCalled();
    });
  });

  describe('重复导入', () => {
    it('同一条会话再导入一次就回到已有的那个，不建第二个', async () => {
      fixture.sqlite.exec(`
        INSERT INTO projects (id, name, path) VALUES ('project-1', 'webapp', '/work/webapp');
        INSERT INTO sessions (id, project_id, provider, runtime, provider_session_id)
          VALUES ('conv-1', 'project-1', 'claude', 'pty', '${CLAUDE_SESSION}');
      `);

      const result = await importLocalSession({
        engine: 'claude-code',
        providerSessionId: CLAUDE_SESSION,
        filePath: '/f.jsonl',
        title: '标题',
        cwd: '/work/webapp',
      });

      expect(result).toMatchObject({
        alreadyImported: true,
        sessionId: 'conv-1',
        projectId: 'project-1',
      });
      expect(mocks.createSession).not.toHaveBeenCalled();
    });
  });

  describe('宿主原子认领', () => {
    const engines = [
      { engine: 'codex' as const, provider: 'codex', nativeId: CODEX_SESSION },
      { engine: 'claude-code' as const, provider: 'claude', nativeId: CLAUDE_SESSION },
    ];

    function persistImportedSession(params: CreateSessionParams) {
      const session = params.sessionConfig.initialSession!;
      fixture.sqlite.prepare(
        'INSERT INTO sessions (id, project_id, provider, runtime, provider_session_id) VALUES (?, ?, ?, ?, ?)'
      ).run(session.id, params.projectId, session.provider, session.type, importedProviderSessionId(params));
      return { success: true, data: {} };
    }

    function importRequest(engine: 'codex' | 'claude-code'): ImportLocalSessionParams {
      return { engine, providerSessionId: engine === 'codex' ? CODEX_SESSION : CLAUDE_SESSION,
        filePath: '/f.jsonl', title: 'import race', cwd: '/work/webapp' };
    }

    beforeEach(() => {
      fixture.sqlite.exec("INSERT INTO projects (id, name, path) VALUES ('project-race', 'race', '/work/webapp')");
      mocks.createSession.mockImplementation(async (params: CreateSessionParams) => persistImportedSession(params));
    });

    it.each(engines)('concurrent $engine imports return one persisted task', async ({ engine, provider, nativeId }) => {
      let previews = 0;
      let release!: () => void;
      const bothPreviews = new Promise<void>((resolve) => { release = resolve; });
      mocks.preview.mockImplementation(async () => {
        if (++previews === 2) release();
        await bothPreviews;
        return previewOf({ providerSessionId: nativeId });
      });

      const results = await Promise.all([
        importLocalSession(importRequest(engine)),
        importLocalSession(importRequest(engine)),
      ]);

      expect(previews).toBe(2);
      expect(results[0].sessionId).toBe(results[1].sessionId);
      expect(results.map(result => result.projectId)).toEqual(['project-race', 'project-race']);
      expect(results.map(result => result.alreadyImported).sort()).toEqual([false, true]);
      expect(mocks.createSession).toHaveBeenCalledTimes(1);
      expect(fixture.sqlite.prepare(
        'SELECT id, project_id FROM sessions WHERE provider = ? AND provider_session_id = ?'
      ).all(provider, nativeId)).toEqual([{ id: results[0].sessionId, project_id: 'project-race' }]);
    });

    it.each(engines)('sequential $engine imports still reuse the original task', async ({ engine, nativeId }) => {
      mocks.preview.mockResolvedValue(previewOf({ providerSessionId: nativeId }));
      const first = await importLocalSession(importRequest(engine));
      const second = await importLocalSession(importRequest(engine));
      expect(first.alreadyImported).toBe(false);
      expect(second).toEqual({ ...first, alreadyImported: true });
      expect(mocks.createSession).toHaveBeenCalledTimes(1);
    });

    it('the same native ID in different engines belongs to different tasks', async () => {
      mocks.preview.mockResolvedValue(previewOf({ providerSessionId: CLAUDE_SESSION }));
      const claude = await importLocalSession(importRequest('claude-code'));
      const codex = await importLocalSession(importRequest('codex'));
      expect(codex.alreadyImported).toBe(false);
      expect(codex.sessionId).not.toBe(claude.sessionId);
      expect((await importLocalSession(importRequest('claude-code'))).sessionId).toBe(claude.sessionId);
      expect((await importLocalSession(importRequest('codex'))).sessionId).toBe(codex.sessionId);
      expect(mocks.createSession).toHaveBeenCalledTimes(2);
    });

    it('different native IDs can be created concurrently', async () => {
      let arrived = 0;
      let release!: () => void;
      const bothCreates = new Promise<void>((resolve) => { release = resolve; });
      mocks.preview.mockImplementation(async ({ filePath }: { filePath: string }) =>
        previewOf({ providerSessionId: filePath === '/first.jsonl' ? CODEX_SESSION : CLAUDE_SESSION }));
      mocks.createSession.mockImplementation(async (params: CreateSessionParams) => {
        if (++arrived === 2) release();
        await bothCreates;
        return persistImportedSession(params);
      });

      const results = await Promise.all([
        importLocalSession({ ...importRequest('codex'), filePath: '/first.jsonl' }),
        importLocalSession({ ...importRequest('codex'), filePath: '/second.jsonl' }),
      ]);
      expect(new Set(results.map(result => result.sessionId)).size).toBe(2);
      expect(results.every(result => !result.alreadyImported)).toBe(true);
    });

    it('a failed create releases the claim for the next request', async () => {
      mocks.preview.mockResolvedValue(previewOf({ providerSessionId: CODEX_SESSION }));
      mocks.createSession.mockRejectedValueOnce(new Error('create failed'));
      const results = await Promise.allSettled([
        importLocalSession(importRequest('codex')),
        importLocalSession(importRequest('codex')),
      ]);
      expect(results[0]).toMatchObject({ status: 'rejected', reason: new Error('create failed') });
      expect(results[1]).toMatchObject({ status: 'fulfilled', value: { alreadyImported: false } });
      const existing = await importLocalSession(importRequest('codex'));
      expect(existing.alreadyImported).toBe(true);
      expect(mocks.createSession).toHaveBeenCalledTimes(2);
    });
  });

  describe('读不出来就报错停', () => {
    it('原件里没有工作目录 → 明确报错，不落到别的目录去跑', async () => {
      mocks.preview.mockResolvedValue(previewOf({ cwd: null }));

      await expect(
        importLocalSession({
          engine: 'claude-code',
          providerSessionId: CLAUDE_SESSION,
          filePath: '/f.jsonl',
          title: '标题',
          cwd: null,
        })
      ).rejects.toThrow('session-no-cwd:');
      expect(mocks.createSession).not.toHaveBeenCalled();
    });

    it('原件里没有会话 id → 明确报错，不建一个恢复不了的空会话', async () => {
      mocks.preview.mockResolvedValue(previewOf({ providerSessionId: '  ' }));

      await expect(
        importLocalSession({
          engine: 'claude-code',
          providerSessionId: CLAUDE_SESSION,
          filePath: '/f.jsonl',
          title: '标题',
          cwd: '/work/webapp',
        })
      ).rejects.toThrow('session-no-id:');
      expect(mocks.createSession).not.toHaveBeenCalled();
    });

    it('建任务失败就把错误抛出去，不假装导入成功', async () => {
      mocks.createSession.mockResolvedValue({ success: false, error: { type: 'project-not-found' } });

      await expect(
        importLocalSession({
          engine: 'claude-code',
          providerSessionId: CLAUDE_SESSION,
          filePath: '/f.jsonl',
          title: '标题',
          cwd: '/work/webapp',
        })
      ).rejects.toThrow('session-create-failed:');
      // 界面只说「无法创建」;内部类型留给日志排查,不进 message。
      expect(mocks.warn).toHaveBeenCalledWith('[session-import] import failed: session-create-failed', {
        engine: 'claude-code',
        type: 'project-not-found',
      });
    });
  });

  describe('项目落点失败:界面说本地化的原因，message 只带码和文件夹名，完整目录与原始报错进日志', () => {
    const params = {
      engine: 'claude-code' as const,
      providerSessionId: CLAUDE_SESSION,
      filePath: '/f.jsonl',
      title: '标题',
      cwd: '/work/webapp',
    };
    const PREFIX_EN = 'The folder webapp could not be opened as a project';
    const PREFIX_ZH = '无法把文件夹 webapp 作为项目打开';
    // [场景, 谁失败, 失败内容, 码, 英文原因, 中文原因]
    const cases = [
      ['建项目:不是目录/不存在', 'create', { type: 'invalid-directory', path: '/work/webapp', message: 'Invalid directory' }, 'project-not-found', 'it no longer exists, was moved, or is not a folder', '它已不存在、被移走了，或不是文件夹'],
      ['建项目:读不了(EACCES)', 'create', { type: 'inspect-failed', path: '/work/webapp', message: "EACCES: permission denied, stat '/work/webapp'" }, 'project-permission-denied', 'Gugu does not have permission to read it', '咕咕没有读取它的权限'],
      ['建项目:读不了(ENOENT)', 'create', { type: 'inspect-failed', path: '/work/webapp', message: "ENOENT: no such file or directory, stat '/work/webapp'" }, 'project-not-found', 'it no longer exists, was moved, or is not a folder', '它已不存在、被移走了，或不是文件夹'],
      ['建项目:打不开仓库(不是 git 仓库)', 'create', { type: 'open-repository-failed', path: '/work/webapp', message: 'fatal: not a git repository (or any of the parent directories): .git' }, 'project-not-git', 'it is not a Git repository', '它不是 Git 仓库'],
      ['挂载:目录已不在', 'open', { type: 'path-not-found', path: '/work/webapp' }, 'project-not-found', 'it no longer exists, was moved, or is not a folder', '它已不存在、被移走了，或不是文件夹'],
      ['挂载:macOS 权限弹窗未答', 'open', { type: 'path-access-blocked', path: '/work/webapp' }, 'project-permission-denied', 'Gugu does not have permission to read it', '咕咕没有读取它的权限'],
      ['挂载:git 说没权限', 'open', { type: 'error', message: "fatal: cannot change to '/work/webapp': Permission denied" }, 'project-permission-denied', 'Gugu does not have permission to read it', '咕咕没有读取它的权限'],
    ] as const;

    it.each(cases)('%s → %s 的原因', async (_name, stage, failure, code, reasonEn, reasonZh) => {
      if (stage === 'create') mocks.createLocalProject.mockResolvedValue({ success: false, error: failure });
      else mocks.openProject.mockResolvedValue({ success: false, error: failure });

      const thrown = await importLocalSession(params).catch((error: Error) => error);

      expect(thrown).toMatchObject({ message: `${code}:webapp`, code });
      expect((thrown as Error).message).not.toContain('/work');
      expect(uiSays(thrown as Error, 'en')).toBe(`${PREFIX_EN}: ${reasonEn}`);
      expect(uiSays(thrown as Error, 'zh')).toBe(`${PREFIX_ZH}：${reasonZh}`);
      expect(mocks.warn).toHaveBeenCalledWith(
        `[session-import] import failed: ${code}`,
        expect.objectContaining({ directory: '/work/webapp', type: failure.type }),
      );
      expect(mocks.createSession).not.toHaveBeenCalled();
    });

    it('认不出的原因 → 界面一句通用的本地化文案，原始报错只进日志', async () => {
      const raw = 'UNIQUE constraint failed: projects.path';
      mocks.createLocalProject.mockResolvedValue({ success: false, error: { type: 'init-failed', path: '/work/webapp', message: raw } });

      const thrown = await importLocalSession(params).catch((error: Error) => error);

      expect((thrown as Error).message).toBe('project-open-failed:webapp');
      expect(uiSays(thrown as Error, 'en')).toBe(`${PREFIX_EN}. See the Gugu log for details.`);
      expect(uiSays(thrown as Error, 'zh')).toBe(`${PREFIX_ZH}，详情见咕咕日志。`);
      expect(uiSays(thrown as Error, 'en')).not.toContain('UNIQUE');
      expect(mocks.warn).toHaveBeenCalledWith('[session-import] import failed: project-open-failed', expect.objectContaining({ message: raw }));
    });
  });
});

it('binds only host-validated managed metadata without reading an entire original transcript in the main process', async () => {
  const fixture = await openFixture('empty'); mocks.db = fixture.db;
  try {
    mocks.preview.mockReset();
    mocks.createSession.mockResolvedValue({ success: true, data: {} });
    mocks.openProject.mockResolvedValue({ success: true, data: {} });
    mocks.createLocalProject.mockResolvedValue({ success: true, data: { id: 'project', path: '/work/webapp', repositoryWorkspaceId: 'ws' } });
    const result = await bindLocalSession({ engine: 'codex', providerSessionId: CODEX_SESSION, filePath: '/managed/session.jsonl',
      title: 'Task', cwd: '/work/webapp', sessionView: 'general' },
    { providerSessionId: CODEX_SESSION, title: 'Task', cwd: '/work/webapp' });
    expect(mocks.preview).not.toHaveBeenCalled();
    expect(result.workingDirectory).toBe('/work/webapp');
    expect(importedProviderSessionId(lastCreateSessionParams())).toBe(CODEX_SESSION);
    expect(lastCreateSessionParams().sessionConfig.initialSession?.type).toBe('acp');
  } finally { fixture.close(); mocks.db = undefined; }
});
