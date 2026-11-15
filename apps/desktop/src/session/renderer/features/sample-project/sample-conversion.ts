import { observable, runInAction } from 'mobx';
import { joinPath } from '@/components/remoteFolderPath';
import type { SampleProjectState } from '@/lib/sampleProject';

/**
 * #2569 发出示例里的第一句 = 示例变成这个人自己的项目:建项目(和「新建项目」同一条路,放在默认项目目录下)→ 示例的三份文件
 * 写进去 → 项目群 → 侧栏里有了它那一行 → 打开它,这一句交给它的新任务框发出去(和项目里开新任务同一条路)→ 示例从账号上删掉(墓碑)。
 *
 * 状态放在这里,❌ 放在示例那一块的组件里:换成项目那一刻那一块就卸了,后面几步还要接着走。状态跟着发的那个账号(`owner`):
 * 同一个窗口换了账号,上一个账号的进度、失败、建过的项目都不算数。哪一步没成都停在那一步、说出原因;写好的话一直在示例的框里。
 * 再按一次发送从账号上记着的那一步接着做(这台电脑上的 `projectId`;哪台电脑都认得的是项目群 `chatId`),❌ 另建一个项目。
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

export type SampleConversionProgress = {
  status: 'idle' | 'working' | 'handed-off';
  failure: SampleConversionFailure | null;
  /**
   * 示例变成的那个项目的群,建好那一刻就有:它的那一行一画出来,示例那一行、那一块就让给它(同一次绘制,use-sample-project),
   * 赶在账号上记好之前。
   */
  chatId: string | null;
};

export type SampleConversionState = SampleConversionProgress & {
  /** 这一份是哪个账号的;别的账号看到的是 {@link sampleConversionOf} 给的「还没开始」。 */
  owner: string | null;
};

export const sampleConversion: SampleConversionState = observable(
  { owner: null, status: 'idle', failure: null, chatId: null } as SampleConversionState,
  { failure: observable.ref },
);

const NOT_STARTED: SampleConversionProgress = { status: 'idle', failure: null, chatId: null };

/** 这个账号的示例变到哪了(observer 里读,跟着变)。 */
export function sampleConversionOf(owner: string | null): SampleConversionProgress {
  return owner !== null && sampleConversion.owner === owner ? sampleConversion : NOT_STARTED;
}

export type SampleConversionDeps = {
  /** 发的是哪个账号的示例。 */
  owner: string;
  /** 这个账号还是这里登录着的那一个;换了、登出了 = 这一遍就此停下,❌ 把它的项目交给下一个账号的窗口。 */
  signedIn: () => boolean;
  /** 账号上这个键此刻的样子(重新读,❌ 用屏上那一份:别的窗口、别的电脑可能已经走了几步)。 */
  readKey: () => Promise<SampleProjectState | null>;
  recordProject: (projectId: string) => Promise<void>;
  recordGroup: (projectId: string, chatId: string) => Promise<void>;
  dismiss: () => Promise<void>;
  /** 项目已经交出去了、示例却没能从账号上删掉:要说出来(日志之外)。 */
  dismissFailed: (error: unknown) => void;
  /** 这个项目在这台电脑的项目表里。 */
  projectExists: (projectId: string) => boolean;
  /** 默认项目目录;没设 = ''。 */
  defaultDirectory: () => Promise<string>;
  /** 这个路径上已经有东西(文件夹、文件、项目)。 */
  pathTaken: (path: string) => Promise<boolean>;
  createProject: (path: string, name: string) => Promise<string>;
  /** 挂上这个项目,交回它的文件夹(仓库工作区)。 */
  projectFolder: (projectId: string) => Promise<string>;
  writeFile: (projectId: string, workspaceId: string, name: string, text: string) => Promise<void>;
  ensureGroup: (projectId: string) => Promise<string>;
  /**
   * 这个项目群的那一行一画进左侧列表,就在画它的同一次更新里调 `open`(❌ 晚一步:那一刻示例已经让位了,项目却还没打开)。
   * `nudge` = 这是人按的重试,可以叫项目表再读一次。false = 等不到;`open` 抛的原样抛出。
   */
  whenRowShown: (chatId: string, nudge: boolean, open: () => void) => Promise<boolean>;
  /** 打开这台电脑上的这个项目,把这一句交给它的新任务框。 */
  handOff: (projectId: string) => void;
  /** 项目在别的电脑上:打开它的项目群,这一句带进群里的新任务框。 */
  handOffToGroup: (chatId: string) => void;
  logError: (message: string, error: unknown) => void;
};

export type SampleProjectSeed = { name: string; files: readonly { name: string; text: string }[] };

const MAX_NUMBERED_NAME = 99;
/** 每个账号在这个窗口建出来的那个项目(账号上还没记上时,重试靠它 ❌ 另建一个;❌ 给别的账号接着用)。 */
const madeHere = new Map<string, string>();
/** 最近一遍的编号:换了账号又发、登出,之前那一遍就不再往下走。 */
let runs = 0;

class StepFailed extends Error {
  constructor(readonly failure: SampleConversionFailure) {
    super(failure.kind);
  }
}

/** 这一遍不再是这里该走的那一遍了(换了账号、登出)。 */
class Superseded extends Error {}

function set(next: Partial<SampleConversionState>): void {
  runInAction(() => Object.assign(sampleConversion, next));
}

/** 默认项目目录下第一个空着的名字:「周末去杭州」、「周末去杭州 2」……(路径按那台电脑的写法拼) */
async function freeFolder(deps: SampleConversionDeps, directory: string, name: string): Promise<{ path: string; name: string }> {
  for (let n = 1; n <= MAX_NUMBERED_NAME; n++) {
    const candidate = n === 1 ? name : `${name} ${n}`;
    const path = joinPath(directory, candidate);
    if (!(await deps.pathTaken(path))) return { path, name: candidate };
  }
  throw new StepFailed({ kind: 'no-free-folder', name });
}

/**
 * 跑一遍(或从上次停下的那一步接着跑)。这个账号正在跑、或已经交给项目的新任务框了:什么都不做 —— 连按两下、两个地方同时按,
 * 只建一个项目。不抛:失败落在 `sampleConversion.failure`。
 */
export async function convertSampleProject(deps: SampleConversionDeps, seed: SampleProjectSeed): Promise<void> {
  const { owner } = deps;
  if (sampleConversion.owner === owner && sampleConversion.status !== 'idle') return;
  const retry = sampleConversion.owner === owner && sampleConversion.failure !== null;
  const run = ++runs;
  set({ owner, status: 'working', failure: null, chatId: null });
  const step = async <T>(work: () => Promise<T>, failure: (error: unknown) => SampleConversionFailure): Promise<T> => {
    let value: T;
    try {
      value = await work();
    } catch (error) {
      if (error instanceof StepFailed || error instanceof Superseded) throw error;
      throw new StepFailed(failure(error));
    }
    if (run !== runs || !deps.signedIn()) throw new Superseded();
    return value;
  };
  // 那一行画出来的那一刻打开项目、交出这一句(在 whenRowShown 的那次更新里跑);换了账号、登出了就不交。
  const handOverWhenShown = async (chatId: string, open: () => void): Promise<void> => {
    let shown: boolean;
    try {
      shown = await deps.whenRowShown(chatId, retry, () => {
        if (run !== runs || !deps.signedIn()) throw new Superseded();
        try {
          open();
        } catch (error) {
          throw new StepFailed({ kind: 'open', error });
        }
        set({ status: 'handed-off' });
      });
    } catch (error) {
      if (error instanceof StepFailed || error instanceof Superseded) throw error;
      throw new StepFailed({ kind: 'open', error });
    }
    if (!shown) throw new StepFailed({ kind: 'row' });
  };
  try {
    const key = await step(deps.readKey, (error) => ({ kind: 'record', error }));
    // 别处已经把它变成项目、删掉了:这里没什么要做的,示例跟着账号上的键收掉。
    if (!key || key.dismissed) {
      set({ status: 'idle' });
      return;
    }
    const here = key.version === 2 && deps.projectExists(key.projectId) ? key : null;
    if (key.version === 2 && key.chatId && !here) {
      // 键上记着群、项目却不在这台电脑上:别的电脑已经把示例变成了账号上的项目。这台电脑 ❌ 再建一个:它那一行画出来的那一刻
      // 打开它的群,这一句带进群里的新任务框。
      const chatId = key.chatId;
      set({ chatId });
      await handOverWhenShown(chatId, () => deps.handOffToGroup(chatId));
      await dismissHandedOver(deps);
      return;
    }
    // 记着的项目没有群、又不在这台电脑上 = 别的电脑建到一半,还没成为账号上的项目:这里自己建。
    // 账号上没记上(上次记的那一下失败了):这个窗口给这个账号建过的那一个照样接着用。
    const made = madeHere.get(owner);
    let projectId = here?.projectId ?? (made && deps.projectExists(made) ? made : null);
    if (!projectId) {
      const directory = await step(deps.defaultDirectory, (error) => ({ kind: 'create', error }));
      if (!directory) throw new StepFailed({ kind: 'no-default-directory' });
      const folder = await step(() => freeFolder(deps, directory, seed.name), (error) => ({ kind: 'create', error }));
      projectId = await step(() => deps.createProject(folder.path, folder.name), (error) => ({ kind: 'create', error }));
      madeHere.set(owner, projectId);
    }
    const id = projectId;
    if (!here) await step(() => deps.recordProject(id), (error) => ({ kind: 'record', error }));
    // 群是在文件写好之后才建、才记的:记着群 = 文件已经在了,❌ 再写一遍盖掉他可能已经改过的。
    if (!here?.chatId) {
      await step(async () => {
        const workspaceId = await deps.projectFolder(id);
        for (const file of seed.files) await deps.writeFile(id, workspaceId, file.name, file.text);
      }, (error) => ({ kind: 'files', error }));
    }
    const chatId = await step(() => deps.ensureGroup(id), (error) => ({ kind: 'group', error }));
    // 群有了:从这一刻起,它那一行一画出来,示例就在同一次绘制里让给它、项目同时打开(❌ 一刻两行都在,❌ 一刻两行都不在)。
    // 那一行什么时候画出来不由这里定(聊天列表、账号的项目表各自到),所以先挂上,再去账号上记群 —— 记的那一下慢,❌ 让两行并存。
    set({ chatId });
    const handedOver = handOverWhenShown(chatId, () => deps.handOff(id));
    const recorded = here?.chatId === chatId
      ? Promise.resolve(null)
      : deps.recordGroup(id, chatId).then(() => null, (error: unknown) => error ?? new Error('recording the group failed'));
    try {
      await handedOver;
    } finally {
      // 交没交出去,记群没成都要留下原因(没交出去时,下次接着做会重写文件、再记一次)。
      void recorded.then((error) => { if (error) deps.logError('recording the sample\'s project group on the account failed', error); });
    }
    await recorded;
    await dismissHandedOver(deps);
  } catch (error) {
    if (error instanceof Superseded) {
      // 换了账号:新的那一遍自己管状态。登出:回到还没开始,同一个账号回来时重新按。
      if (run === runs) set({ status: 'idle', failure: null });
      return;
    }
    const failure = error instanceof StepFailed ? error.failure : ({ kind: 'open', error } as const);
    deps.logError(`turning the sample into a project stopped at ${failure.kind}`, 'error' in failure ? failure.error : failure.kind);
    set({ status: 'idle', failure });
  }
}

/**
 * 交出去那一刻就从账号上删掉示例(❌ 等任务建好:窗口一重载、任务没建成,示例就删不掉了,项目一移走它又回来)。
 * 删不掉:日志 + 说出来;读键的那一侧(use-sample-project)看到「变成的项目已在项目表里、键还没删」会再删。
 */
async function dismissHandedOver(deps: SampleConversionDeps): Promise<void> {
  try {
    await deps.dismiss();
  } catch (error) {
    deps.logError('dismissing the sample after it became a project failed', error);
    deps.dismissFailed(error);
  }
}

/** 测试与换账号用:回到还没开始的样子。 */
export function resetSampleConversion(): void {
  runs++;
  madeHere.clear();
  set({ owner: null, status: 'idle', failure: null, chatId: null });
}
