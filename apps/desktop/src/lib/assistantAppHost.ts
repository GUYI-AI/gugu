// #1925 「助理」搬进一个装上的 App(App id gugu-assistant)之后,壳这一侧替它做的三件小事(主进程先验过权,见
// electron/.../app-assistant-binding.ts):
//   · 打开壳自己的那几屏(关闭 / 形象 / 模型 / 设备)—— 每一个都走它现成的入口,❌ 另画一份;开通、资料(搬家在里面)、
//     连接应用是它自己的页,画在 App 的面板上(app-host-layer.tsx),❌ 设置里(owner 11-12:设置里不该有咕咕设置);
//   · 把壳发布的快照(lib/assistantShellBridge.ts)按 App 能看的那几项交给主进程 —— ❌ 任何 id、路径、令牌;
//   · App 自己画的开通后两步(连应用 → 一切就绪 → 走完)往下走一步,走的是内置视图同一个 advanceSetup。
// 开通、搬家、关闭的编排(身份、租约、凭据、清理)一律留在壳里,App 只能叫开那一屏,人在那一屏里自己做。
import type { ActiveSection } from '@gugu/core/shared/enums/settingsSectionModels'
import {
  NAME_MAX,
  isAssistantFace,
  isFailureClass,
  renameCheck,
  setupAdvanceAllowed,
  type AssistantScreen,
  type AssistantSetupAdvance,
  type PushedAssistantStatus,
  type ShownAssistant,
} from '@shared/extensions/assistant-binding'
import { requestAssistantClose } from './assistantClose'
import { assistantTintHue } from './assistantTint'
import { readAssistantShellBridge, type AssistantShellActions, type AssistantShellBridge, type AssistantShellSnapshot } from './assistantShellBridge'
import { UI_EVENTS } from './uiEvents'

function openSettings(section: ActiveSection): void {
  window.dispatchEvent(new CustomEvent(UI_EVENTS.openSettings, { detail: { section } }))
}

/** 主进程验的是哪个账号,窗口此刻就得还是那个账号;换了号 = 不做。 */
function shellOf(ownerId: string): AssistantShellBridge {
  const bridge = readAssistantShellBridge()
  if (!bridge || bridge.getSnapshot()?.ownerId !== ownerId) throw new Error('This window does not show that account\'s assistant now')
  return bridge
}

function actionsOf(bridge: AssistantShellBridge): AssistantShellActions {
  const actions = bridge.getActions()
  if (!actions) throw new Error('The assistant\'s settings are not ready in this window yet')
  return actions
}

/**
 * 每一屏现成的入口:关闭 = 那一份唯一的确认(AssistantCloseHost);形象 = 它的 agent 设置(只有形象);模型 = App 资料页的模型那一屏;
 * 设备 = 设置里那一格。
 */
export function openAssistantScreen(screen: AssistantScreen, ownerId: string): void {
  const bridge = shellOf(ownerId)
  switch (screen) {
    case 'close':
      return requestAssistantClose()
    case 'look':
      return actionsOf(bridge).openLook()
    case 'model':
      return actionsOf(bridge).openModel()
    case 'devices':
      return openSettings('devices')
  }
  // setup / settings / move / connected-apps / projects / capabilities are the assistant's own pages: drawn over the App's
  // panel (app-host-layer.tsx), not here and not in Settings.
  throw new Error(`Not one of the shell's assistant screens: ${String(screen)}`)
}

/**
 * App 给它改名:内置名字栏同一条规矩(去首尾空白、不能空、≤ 30 字,同名不存)在这扇窗再验一遍,走壳同一个 renameAssistant
 * (内置资料页的名字栏就调它)。这扇窗此刻没认到它 = 抛(主进程答 `failed`)。
 */
export async function renameAssistantFor(text: string, ownerId: string): Promise<void> {
  const bridge = shellOf(ownerId)
  const snapshot = bridge.getSnapshot()
  if (snapshot?.assistantState !== 'found' || !snapshot.assistant) throw new Error('This window does not show the assistant now')
  const check = renameCheck(text, snapshot.assistant.display_name)
  if ('result' in check) {
    if (check.result === 'unchanged') return
    throw new Error(`Not a name the assistant can take: ${check.result}`)
  }
  await actionsOf(bridge).renameAssistant(check.name)
}

/** App 画的那两步往下走:按这扇窗记着的那一步再验一遍(与主进程同一条规矩),走内置视图同一个 advanceSetup。 */
export function advanceAssistantSetup(next: AssistantSetupAdvance, ownerId: string): void {
  const bridge = shellOf(ownerId)
  const from = bridge.getSnapshot()?.setup ?? null
  if (!setupAdvanceAllowed(from, next)) throw new Error(`Setup is ${from ?? 'not under way'}: it cannot go to ${next}`)
  actionsOf(bridge).advanceSetup(next === 'done' ? null : next)
}

/** 云上的家「在」= 它此刻答得上话:睡着的会自己醒(owner 10-17:Agent 没有休息这回事),开着、醒着、正在醒都算。 */
const CLOUD_ANSWERS = new Set(['awake', 'asleep', 'waking'])

/**
 * 壳的快照里 App 能看的那几项(assistant-binding.ts 的 AppAssistantStatus):它认到哪一步、名字、头像(`face`:壳画好的
 * data: 图,❌ 存储地址)、住哪一类与在不在、开通到哪一步、是不是正在安家、能不能住云上、会员(读不到 = null,❌ 当成不是)、
 * 读云电脑失败的那一类。❌ 私聊、设备、账号的 id,❌ 路径。
 */
export function appAssistantStatusOf(snapshot: AssistantShellSnapshot, face: string | null): ShownAssistant {
  const found = snapshot.assistantState === 'found' && snapshot.assistant ? snapshot.assistant : null
  const home = snapshot.home
  // 主题色 = 它那只鸟的身体色相(内置视图 `.ta-app` 的 --ta-tint-h 同一个);照片头像没有 = null。
  const tint = found ? assistantTintHue(found.id, found.avatar) ?? null : null
  // 安家途中云上的家正在开 / 没开成:内置视图整页换成宿主的安家流程(进度、失败与重来都在那里说),App 也该照此画安家那一页。
  const cloudBeingMade = home?.kind === 'cloud' && snapshot.setup !== null
    && (snapshot.cloud?.state === 'provisioning' || snapshot.cloud?.state === 'error')
  return {
    assistant: snapshot.assistantState,
    name: found ? found.display_name.slice(0, NAME_MAX) : null,
    avatar: found && face && isAssistantFace(face) ? face : null,
    tint: tint !== null && Number.isFinite(tint) && tint >= 0 && tint <= 360 ? tint : null,
    home: !home ? null
      : home.kind === 'cloud' ? { kind: 'cloud', online: CLOUD_ANSWERS.has(snapshot.cloud?.state ?? ''), label: null }
      : { kind: home.hostKind === 'server' ? 'server' : home.thisDevice ? 'this-computer' : 'other-computer', online: home.online, label: textOrNull(home.label) },
    setup: snapshot.setup,
    preparing: snapshot.preparing || cloudBeingMade,
    cloudAvailable: snapshot.cloudAvailable,
    member: snapshot.member,
    // 失败那一类是个词;万一不是(❌ 原话、❌ 码里带别的),就说「出了问题」那一类。
    loadError: snapshot.loadError === null ? null : isFailureClass(snapshot.loadError) ? snapshot.loadError : 'failed',
    ownerName: textOrNull(snapshot.ownerName),
  }
}

/** A name as a person gave it, trimmed; nothing (or only spaces) = null. */
const textOrNull = (text: string | null | undefined) => text?.trim().slice(0, NAME_MAX) || null

/**
 * 壳的快照一变(或它的头像画好了)就按 App 能看的那几项交给主进程;没变不交。`face` 画头像(lib/memberFaces 的 memberFace),
 * `push` 交出去,`changes` 是头像那一侧的变化(身份目录)。返回停下的那一下。
 */
export function startAssistantAppStatus(deps: {
  shell: AssistantShellBridge
  face: (id: string, avatar: string | null) => Promise<string | null>
  push: (pushed: PushedAssistantStatus) => Promise<unknown>
  changes?: (listener: () => void) => () => void
  warn: (message: string, error: unknown) => void
}): () => void {
  let last = ''
  let run = 0
  let stopped = false
  const update = () => {
    const snapshot = deps.shell.getSnapshot()
    if (!snapshot?.ownerId) return
    const ownerId = snapshot.ownerId
    const mine = ++run
    const assistant = snapshot.assistantState === 'found' ? snapshot.assistant : null
    void (assistant ? deps.face(assistant.id, assistant.avatar).catch(() => null) : Promise.resolve(null)).then((face) => {
      // 等头像的时候来了更新的一份:这一份作废,由那一份交。
      if (stopped || mine !== run) return
      const status = appAssistantStatusOf(snapshot, face)
      const key = JSON.stringify([ownerId, status])
      if (key === last) return
      last = key
      void deps.push({ ownerId, status }).catch((error: unknown) => {
        if (last === key) last = ''
        deps.warn('handing the assistant snapshot to Apps failed', error)
      })
    })
  }
  const offShell = deps.shell.subscribe(update)
  const offChanges = deps.changes?.(update)
  update()
  return () => {
    stopped = true
    offShell()
    offChanges?.()
  }
}
