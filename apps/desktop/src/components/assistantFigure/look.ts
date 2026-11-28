/**
 * look.ts —— 个人助理的「形象」:小鸟的具体取值(身体颜色 + 休息表情 + 装扮),存进助理自己的头像字段。
 * 只有助理画小鸟;普通 agent 的脸由 lib/identityFace.ts 决定(Boring beam),它头像位上就算存着形象地址也不画小鸟。
 *
 * 存法:头像字段放一个形象地址 `https://<存储>/storage/v1/object/public/avatars/agent-look/v1/<颜色>.webp?rest=<表情>&wear=<装扮>`。
 *  · wear = 逗号分隔的 `<装扮 id>.<配色序号>`(engine/outfitCatalog.ts):掷骰子 / DIY 之后存下的那一身;`wear=` 为空 = 明确选了不戴;
 *    没有 wear 参数 = 不戴装扮;只有用户掷骰子或 DIY 后保存的 wear 才穿上。
 *    认不出的 id(更新的版本加的)跳过这一件,冲突的留先出现的;
 *  · 新客户端认出这个地址 → 画会动的小鸟(颜色、休息表情按地址),不去加载那张图;
 *  · 老客户端 / 别的消费方只当它是一张普通头像图 → 那个颜色的小鸟定格图(存储里一色一张,共用);
 *  · 只认路径尾巴 `/agent-look/v1/<颜色>.webp`,不认主机:同一个形象在哪套环境都读得出来。
 *    `agent-look/v1` 是已存进库、老客户端也在读的路径,不随这个模块改名。
 */
import { rendererLogger } from '@/lib/log'
import { BODY_COLORS, REST_FACES, agentIdentity, type AgentIdentity } from './engine/identity'
import { OUTFIT_BY_ID, clashes, wearKey, type WearItem } from './engine/outfitCatalog'
import { ROLL_RULES, pickWear } from './engine/outfitPick'
import { EXPRESSIONS, type ExpressionId } from './engine/spec'

/** wear 不给或 [] = 不戴装扮;非空数组 = 用户保存的装扮 */
export type AssistantLook = AgentIdentity & { wear?: readonly WearItem[] }

/** 个人助理未自定义时：奶油色、平静、不戴装扮。 */
export const DEFAULT_ASSISTANT_LOOK: AssistantLook = { color: 0, rest: 'neutral' }

const log = rendererLogger('agents/look')

/** avatars 桶里放共用形象定格图的根目录:这下面的东西(任何版本)都不归某一只 agent 所有。 */
export const LOOK_ROOT = 'agent-look'

/** 存储里形象定格图所在的目录(avatars 桶下)。v1 = 当前这只小鸟;换了形象体系就开 v2,旧地址照样读得出。 */
export const LOOK_DIR = `${LOOK_ROOT}/v1`

/** 手选可用的全部 16 种休息表情(顺序 = 术语表顺序)。自动分配只用其中 6 种日常的(REST_FACES)。 */
export const ALL_REST_FACES: readonly ExpressionId[] = EXPRESSIONS.map((e) => e.id)

/** 16 种里除了日常 6 种之外的 10 种:个性强,在列表里很显眼(一直抖、跳、冒特效,或读成出事 / 睡着)。 */
export const BOLD_REST_FACES: readonly ExpressionId[] = ALL_REST_FACES.filter((id) => !REST_FACES.includes(id))

export function colorSlug(color: number): string {
  return BODY_COLORS[color].en.toLowerCase()
}

/** 这个颜色的定格图在 avatars 桶里的对象路径。 */
export function lookObjectPath(color: number): string {
  return `${LOOK_DIR}/${colorSlug(color)}.webp`
}

/** 拼形象地址:那张定格图的公开地址 + 休息表情 + 装扮(没有 wear = 老形象,不写这个参数)。 */
export function buildLookUrl(posterPublicUrl: string, rest: ExpressionId, wear?: readonly WearItem[]): string {
  const base = `${posterPublicUrl.split('?')[0]}?rest=${rest}`
  return wear ? `${base}&wear=${wearKey(wear)}` : base
}

/** wear 参数 → 这一身:认不出的 id / 配色跳过这一件(记一条),和前面已戴的冲突的跳过 */
function parseWear(raw: string): WearItem[] {
  const out: WearItem[] = []
  for (const token of raw.split(',')) {
    if (!token) continue
    const m = /^([a-z][a-z0-9-]*)\.(\d+)$/.exec(token)
    const def = m ? OUTFIT_BY_ID.get(m[1]) : undefined
    const cw = m ? Number(m[2]) : -1
    if (!def || cw >= def.colorways.length) {
      log.warn({ token }, 'skipping unknown outfit in agent look')
      continue
    }
    if (out.some((w) => clashes(OUTFIT_BY_ID.get(w.id)!, def))) {
      log.warn({ token }, 'skipping clashing outfit in agent look')
      continue
    }
    out.push({ id: def.id, cw })
  }
  return out
}

const LOOK_TAIL = /\/agent-look\/v1\/([a-z]+)\.webp(?:\?([^#]*))?(?:#.*)?$/

/** All built-in v1 looks, including older URLs without expression parameters. Custom images stay custom. */
export function isLookAvatarUrl(avatar: string | null | undefined): boolean {
  if (!avatar) return false
  try {
    const url = new URL(avatar)
    return (url.protocol === 'https:' || url.protocol === 'http:') && /\/agent-look\/v1\/[^/]+$/.test(url.pathname)
  } catch {
    return false
  }
}

/** 头像地址 → 形象;不是形象地址(照片 / null / 认不出的颜色或表情)= null。 */
export function parseAssistantLook(avatar: string | null | undefined): AssistantLook | null {
  if (!avatar) return null
  const m = LOOK_TAIL.exec(avatar.trim())
  if (!m) return null
  const color = BODY_COLORS.findIndex((c) => c.en.toLowerCase() === m[1])
  if (color < 0) return null
  const params = new URLSearchParams(m[2] ?? '')
  const rest = params.get('rest') as ExpressionId | null
  if (!rest || !ALL_REST_FACES.includes(rest)) return null
  const wear = params.get('wear')
  return wear === null ? { color, rest } : { color, rest, wear: parseWear(wear) }
}

/** 小鸟该长什么样:存了形象就是形象,否则按 id 推。(传了照片的助理画照片,不走这里。) */
export function resolveAssistantLook(id: string | null | undefined, avatar: string | null | undefined): AssistantLook {
  return parseAssistantLook(avatar) ?? agentIdentity(id)
}

/** 实际穿着:有保存就按保存的,缺省或空数组都不戴装扮 */
export function wornOf(look: AssistantLook): readonly WearItem[] {
  return look.wear ?? []
}

export function sameLook(a: AssistantLook | null | undefined, b: AssistantLook | null | undefined): boolean {
  return !!a && !!b && a.color === b.color && a.rest === b.rest && (a.wear === undefined) === (b.wear === undefined) && wearKey(a.wear) === wearKey(b.wear)
}

type Rng = () => number

function pickOne<T>(items: readonly T[], rng: Rng): T {
  return items[Math.min(items.length - 1, Math.floor(rng() * items.length))]
}

/**
 * 掷骰子:换一个颜色、一种日常休息表情(都避开眼下 avoid 那一格,保证骰子一定换个样),再抽一身装扮(engine/outfitPick.ts)。
 * 结果带着明确的 wear,存下去就是这一身。
 */
export function rollLook(avoid: AssistantLook | null, rng: Rng, month = new Date().getMonth()): AssistantLook {
  const color = pickOne(BODY_COLORS.map((_, i) => i).filter((i) => i !== avoid?.color), rng)
  const rest = pickOne(REST_FACES.filter((f) => f !== avoid?.rest), rng)
  return { color, rest, wear: rollWear(color, rng, month) }
}

/** 只换装扮(DIY 页签里的骰子):颜色、表情不动 */
export function rollWear(color: number, rng: Rng, month = new Date().getMonth()): WearItem[] {
  return pickWear(color, rng, ROLL_RULES, { month })
}
