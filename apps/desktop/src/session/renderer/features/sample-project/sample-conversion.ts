import { observable, runInAction } from 'mobx';
import type { SampleProjectState } from '@/lib/sampleProject';

/**
 * #2569 发出示例里的第一句 = 示例变成这个人自己的项目:建项目(和「新建项目」同一条路,放在默认项目目录下)→ 示例的三份文件
 * 写进去 → 项目群 → 侧栏里有了它那一行 → 打开它,这一句交给它的新任务框发出去(和项目里开新任务同一条路)→ 任务建好了,
 * 示例才从账号上删掉(墓碑)。
 *
 * 状态放在这里,❌ 放在示例那一块的组件里:换成项目那一刻那一块就卸了,后面几步还要接着走。哪一步没成都停在那一步、说出原因;
 * 写好的话一直在示例的框里。再按一次发送从账号上记着的那一步接着做(`projectId`、`chatId`),❌ 另建一个项目。
 */
export type SampleConversionFailure =
  | { kind: 'no-default-directory' }
  /** 默认项目目录里这个名字(和加了编号的那些)都被占了。 */
  | { kind: 'no-free-folder'; name: string }
  | { kind: 'create'; error: unknown }
  | { kind: 'files'; error: unknown }
  | { kind: 'group'; error: unknown }
  /** 项目群建好了,但这个项目一直没出现在账号的项目表里(侧栏那一行就是它)。 */
  | { kind: 'row' }
  /** 账号上这个键读不到、或走到哪一步没能记上(记不上,别的窗口、重启之后就不知道已经建过)。 */
  | { kind: 'record'; error: unknown }
  /** 项目好了,但没能打开它、把这一句交给它的新任务框。 */
  | { kind: 'open'; error: unknown };

export type SampleConversionState = {
  status: 'idle' | 'working' | 'handed-off';
  failure: SampleConversionFailure | null;
  /** 示例变成的那个项目的群:它一出现在项目表里,示例那一行、那一块就让给它(同一个窗口里,赶在账号上记好之前)。 */
  chatId: string | null;
};

export const sampleConversion: SampleConversionState = observable(
  { status: 'idle', failure: null, chatId: null } as SampleConversionState,
  { failure: observable.ref },
);

export type SampleConversionDeps = {
  /** 账号上这个键此刻的样子(重新读,❌ 用屏上那一份:别的窗口可能已经走了几步)。 */
  readKey: () => Promise<SampleProjectState | null>;
  recordProject: (projectId: string) => Promise<void>;
  recordGroup: (projectId: string, chatId: string) => Promise<void>;
  dismiss: () => Promise<void>;
  /** 这个项目还在这台电脑的项目表里。 */
  projectExists: (projectId: string) => boolean;
  /** 默认项目目录;没设 = ''。 */
  defaultDirectory: () => Promise<string>;
  /** 这个路径上已经有东西(文件夹、项目)。 */
  pathTaken: (path: string) => Promise<boolean>;
  createProject: (path: string, name: string) => Promise<string>;
  /** 挂上这个项目,交回它的文件夹(仓库工作区)。 */
  projectFolder: (projectId: string) => Promise<string>;
  writeFile: (projectId: string, workspaceId: string, name: string, text: string) => Promise<void>;
  ensureGroup: (projectId: string) => Promise<string>;
  /** 等这个项目出现在账号的项目表里;`nudge` = 这是人按的重试,可以叫项目表再读一次。false = 等不到。 */
  rowShown: (projectId: string, nudge: boolean) => Promise<boolean>;
  /** 打开这个项目,把这一句交给它的新任务框;任务建好了调 `onCreated`。 */
  handOff: (projectId: string, onCreated: () => void) => void;
  logError: (message: string, error: unknown) => void;
};

export type SampleProjectSeed = { name: string; files: readonly { name: string; text: string }[] };

const MAX_NUMBERED_NAME = 99;
/** 这个窗口建出来的那个项目(账号上还没记上时,重试靠它 ❌ 另建一个)。 */
let madeHere: string | null = null;

class StepFailed extends Error {
  constructor(readonly failure: SampleConversionFailure) {
    super(failure.kind);
  }
}

async function step<T>(work: () => Promise<T>, failure: (error: unknown) => SampleConversionFailure): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof StepFailed) throw error;
    throw new StepFailed(failure(error));
  }
}

function set(next: Partial<SampleConversionState>): void {
  runInAction(() => Object.assign(sampleConversion, next));
}

/** 默认项目目录下第一个空着的名字:「周末去杭州」、「周末去杭州 2」…… */
async function freeFolder(deps: SampleConversionDeps, directory: string, name: string): Promise<{ path: string; name: string }> {
  for (let n = 1; n <= MAX_NUMBERED_NAME; n++) {
    const candidate = n === 1 ? name : `${name} ${n}`;
    const path = `${directory}/${candidate}`;
    if (!(await deps.pathTaken(path))) return { path, name: candidate };
  }
  throw new StepFailed({ kind: 'no-free-folder', name });
}

/**
 * 跑一遍(或从上次停下的那一步接着跑)。正在跑、或已经交给项目的新任务框了:什么都不做 —— 连按两下、两个地方同时按,只建一个项目。
 * 不抛:失败落在 `sampleConversion.failure`。
 */
export async function convertSampleProject(deps: SampleConversionDeps, seed: SampleProjectSeed): Promise<void> {
  if (sampleConversion.status !== 'idle') return;
  const retry = sampleConversion.failure !== null;
  set({ status: 'working', failure: null });
  try {
    const key = await step(deps.readKey, (error) => ({ kind: 'record', error }));
    // 别处已经把它变成项目、删掉了:这里没什么要做的,示例跟着账号上的键收掉。
    if (!key || key.dismissed) {
      set({ status: 'idle' });
      return;
    }
    const recorded = key.version === 2 && deps.projectExists(key.projectId) ? key : null;
    // 账号上没记上(上次记的那一下失败了):这个窗口自己建过的那一个照样接着用。
    let projectId = recorded?.projectId ?? (madeHere && deps.projectExists(madeHere) ? madeHere : null);
    if (!projectId) {
      const directory = await step(deps.defaultDirectory, (error) => ({ kind: 'create', error }));
      if (!directory) throw new StepFailed({ kind: 'no-default-directory' });
      const folder = await step(() => freeFolder(deps, directory, seed.name), (error) => ({ kind: 'create', error }));
      projectId = await step(() => deps.createProject(folder.path, folder.name), (error) => ({ kind: 'create', error }));
      madeHere = projectId;
    }
    const id = projectId;
    if (!recorded) await step(() => deps.recordProject(id), (error) => ({ kind: 'record', error }));
    // 群是在文件写好之后才建、才记的:记着群 = 文件已经在了,❌ 再写一遍盖掉他可能已经改过的。
    if (!recorded?.chatId) {
      await step(async () => {
        const workspaceId = await deps.projectFolder(id);
        for (const file of seed.files) await deps.writeFile(id, workspaceId, file.name, file.text);
      }, (error) => ({ kind: 'files', error }));
    }
    const chatId = await step(() => deps.ensureGroup(id), (error) => ({ kind: 'group', error }));
    if (recorded?.chatId !== chatId) await step(() => deps.recordGroup(id, chatId), (error) => ({ kind: 'record', error }));
    if (!(await step(() => deps.rowShown(id, retry), () => ({ kind: 'row' })))) throw new StepFailed({ kind: 'row' });
    // 那一行在了:同一刻打开它、把这一句交过去、示例让给它(❌ 一刻两行都在,❌ 一刻两行都不在)。任务建好了才删示例:
    // 删不掉只记日志 —— 这一行已经让给项目了,人看不出差别,账号上记着的 chatId 让别的窗口、别的电脑也这样让。
    try {
      deps.handOff(id, () => {
        void deps.dismiss().catch((error: unknown) => deps.logError('dismiss the sample after it became a project failed', error));
      });
    } catch (error) {
      throw new StepFailed({ kind: 'open', error });
    }
    set({ status: 'handed-off', chatId });
  } catch (error) {
    const failure = error instanceof StepFailed ? error.failure : ({ kind: 'open', error } as const);
    deps.logError(`turning the sample into a project stopped at ${failure.kind}`, 'error' in failure ? failure.error : failure.kind);
    set({ status: 'idle', failure });
  }
}

/** 测试与换账号用:回到还没开始的样子。 */
export function resetSampleConversion(): void {
  madeHere = null;
  set({ status: 'idle', failure: null, chatId: null });
}
