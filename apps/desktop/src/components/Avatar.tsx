import { useState, useEffect, useMemo, useRef } from 'react'
import { pauseAnimationsOffscreen } from '@gugu/session-shared/animation-visibility'
import { useTranslation } from 'react-i18next'
import { colorOfDisplayStatus, labelOfDisplayStatus } from '@gugu/core/shared/ui/agentConversationStatusModels'
import type { AgentStatusLabel } from '@gugu/core/shared/agentStatusPresentation'
import { normalizeAvatarUrl, reportInvalidAvatarUrl } from '@gugu/core/shared/ui/avatarUrl'
import type { AgentDisplayStatus } from '@gugu/core/shared/types/chat'
import { GROUP_AVATAR_CORNER, groupAvatarColor, groupAvatarDefaultText, groupAvatarSvg } from '@gugu/core/shared/ui/groupAvatar'
import { dicebearAvatarDataUri } from '../lib/dicebearAvatar'
import { AgentNeedsUserGlyph } from './AgentNeedsUserGlyph'
import { AgentHarnessBadge } from './AgentHarnessIdentity'
import { BoringAgentAvatar } from './BoringAgentAvatar'
import { AssistantDefaultAvatar } from './assistant/AssistantDefaultAvatar'
import { useAvatarIdentity, useIsAssistantAvatar } from '../lib/avatarIdentity'
import { isBuiltinAgentAvatarUrl, parseAgentLook } from './agentAvatar/look'
import { agentLookPoster } from './agentAvatar/posters'

export interface AvatarProps {
  name: string
  avatarUrl?: string | null
  // @@@2470 没有自定义头像时的默认脸按这个**稳定身份 key** 生成（调用方传的 id：同一身份永远同一张脸、
  // 改名不变）。姓名**永远不得**当 seed；未传 key 就不造脸，进可诊断空态。
  seed?: string
  // @@@avatar-xs (#1102) - 18px 超小号,用于「运行中」内联指示器(设计稿 .typing .tav)。
  // @@@1323-m6 兼收数字 px：少数对齐 SSOT 的一次性尺寸(如账户头像 46×46，命名档无 46)，向后兼容。
  size?: 'xs' | 'sm' | 'md' | 'lg' | number
  isAgent?: boolean
  // Runtime status is separate from the persistent bottom-right harness identity.
  agentStatus?: AgentDisplayStatus
  // The assistant expresses the precise status with its 3D figure; other agents use the status badge.
  statusLabel?: AgentStatusLabel
  // 右下角的 harness 品牌小图标。默认画;单聊头部那只大头像不画(头栏那句「状态 · 位置 · 引擎」已经说了引擎)。
  harnessBadge?: boolean
  // 鼠标移上去小鸟就被拍一拍(只对会动的小鸟生效;照片 / 真人 / 群不变)。单聊头栏那只大头像用。
  hoverPoke?: boolean
  /** Extra drawing room for the assistant figure; layout and custom-photo size stay unchanged. */
  canvasPaddingX?: number
  // The assistant can use its still poster in dense rows. Ordinary agents are always static SVGs.
  still?: boolean
  // A group or a project: `seed` is its id (the project group's chat id; a project with no group yet, its own). With no
  // picture of its own it shows the default face: that id's colour around the first characters of `name`.
  variant?: 'default' | 'group'
  imageMatteColor?: string
}

const SIZE_MAP = { xs: 18, sm: 32, md: 40, lg: 64 } as const
const AVATAR_STATUS_DOT_CLASS = 'av-status__dot relative motion-reduce:animate-none'
const AVATAR_STATUS_PULSE_CLASS = 'av-status__pulse pointer-events-none absolute -inset-0.5 rounded-full border-2 border-solid animate-[av-status-pulse_1.4s_steps(14,end)_infinite] motion-reduce:animate-none'
const AVATAR_STATUS_PULSE_DELAY_CLASS = `${AVATAR_STATUS_PULSE_CLASS} av-status__pulse--delay [animation-delay:0.7s]`

// @@@avatar-status-badge - top-right status indicator. Color and words come from the shared presentation
// (packages/core/src/shared/agentStatusPresentation.ts — one table for the session page, chat and phone). Motion uses
// Tailwind animation utilities plus global keyframes. working = solid dot + two staggered pulse rings; parked = the
// same color, still; needs_user = Solar exclamation glyph; idle/offline/removed = static dot.
function AgentStatusBadge({ status, size }: { status: AgentDisplayStatus; size: number }) {
  const { t } = useTranslation('common')
  const color = colorOfDisplayStatus(status) ?? 'transparent'
  const label = t(`agentStatus.${labelOfDisplayStatus(status)}`)
  const running = status === 'working'
  // Pulses on avatars scrolled out of the message list stop; the ones on screen keep pulsing.
  const badge = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (running && badge.current) return pauseAnimationsOffscreen(badge.current)
  }, [running])
  return (
    <div
      ref={badge}
      className={`av-status av-status--${status}`}
      role="img"
      aria-label={label}
      title={label}
      style={{
        position: 'absolute',
        top: -2,
        right: -2,
        width: size,
        height: size,
        borderRadius: 'var(--radius-circle)',
        background: 'transparent',
        border: '1.5px solid transparent',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: Math.max(2, Math.round(size * 0.14)),
        boxSizing: 'border-box',
      }}
    >
      {status === 'needs_user' ? (
        <AgentNeedsUserGlyph size={Math.max(8, size)} />
      ) : (
        <span
          className={AVATAR_STATUS_DOT_CLASS}
          style={{ width: '100%', height: '100%', borderRadius: 'var(--radius-circle)', background: color }}
        >
          {running && (
            <>
              <span className={AVATAR_STATUS_PULSE_CLASS} style={{ borderColor: color }} />
              <span className={AVATAR_STATUS_PULSE_DELAY_CLASS} style={{ borderColor: color }} />
            </>
          )}
        </span>
      )}
    </div>
  )
}

export function Avatar({
  name,
  avatarUrl,
  seed,
  size = 'md',
  isAgent,
  agentStatus,
  statusLabel,
  harnessBadge = true,
  hoverPoke = false,
  canvasPaddingX = 0,
  still = false,
  variant = 'default',
  imageMatteColor,
}: AvatarProps) {
  const [imgFailed, setImgFailed] = useState(false)
  const identityKey = (seed ?? '').trim()
  const identity = useAvatarIdentity(isAgent === undefined && variant !== 'group' ? identityKey : '')
  const agent = isAgent ?? (identity ? identity.type === 'agent' : undefined)
  const assistant = useIsAssistantAvatar(identityKey)
  // @@@1482 规范化：字符串 "undefined"/"null"/空 视作无头像；不渲染破图。
  const normalized = normalizeAvatarUrl(avatarUrl)
  // @@@agent-look 形象地址(agentAvatar/look.ts:颜色 + 休息表情)不是一张要去加载的图 —— agent 画会动的小鸟、
  // 按它说的颜色与表情;真人的头像位上万一出现形象地址,画那个颜色的定格(人的头像不会变成会动的小鸟)。
  const look = parseAgentLook(normalized)
  const url = agent !== false && isBuiltinAgentAvatarUrl(normalized) ? null
    : look ? (agent ? null : agentLookPoster(look)) : normalized
  // @@@1482 url 变化时在 render 期重置加载失败态（React 官方「按 prop 变化调整 state」模式，非 useEffect）：
  // useEffect 在 render 之后才跑，下方 DEV throw 守卫会在同一帧用旧 imgFailed 对新有效 url 误抛。
  // render 期重置确保新 url 进来即 imgFailed=false，throw 守卫不会对有效新头像误触。
  const [trackedUrl, setTrackedUrl] = useState(url)
  if (url !== trackedUrl) {
    setTrackedUrl(url)
    setImgFailed(false)
  }
  const px = typeof size === 'number' ? size : SIZE_MAP[size]
  // A person or an agent is round; a group is a rounded square, whether it shows its default face or its own picture.
  const radius = variant === 'group' ? `${Math.round(px * GROUP_AVATAR_CORNER)}px` : '50%'

  // Missing/null and failed canonical URLs stay local explicit empty states; onError records the diagnostic.
  useEffect(() => {
    reportInvalidAvatarUrl(avatarUrl, `main avatar "${name || 'unknown'}"`)
  }, [avatarUrl, name])

  const badgeSize = Math.max(8, Math.min(16, Math.round(px * 0.3)))

  const base: React.CSSProperties = {
    position: 'relative',
    width: px,
    height: px,
    flexShrink: 0,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
  }

  const imgStyle: React.CSSProperties = {
    width: px,
    height: px,
    borderRadius: radius,
    objectFit: 'cover',
    flexShrink: 0,
    display: 'block',
  }

  const matteStyle: React.CSSProperties = {
    width: px,
    height: px,
    borderRadius: radius,
    background: imageMatteColor,
    flexShrink: 0,
    display: 'inline-flex',
    overflow: 'hidden',
  }

  const emptyStyle: React.CSSProperties = {
    width: px,
    height: px,
    borderRadius: radius,
    background: 'var(--bg-elevated)',
    border: '1px solid var(--border-subtle)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    userSelect: 'none',
  }

  const hasInvalidExplicit = avatarUrl != null && normalized == null
  const showImg = !!url && !imgFailed
  // 自定义头像坏掉（加载失败 / 非法串）才是错误；没设置头像不是错误。
  const avatarError = imgFailed || hasInvalidExplicit
  const wantsGeneratedFace = !showImg && !avatarError
  // The default group face stands for an unset group picture, never for one that failed to load.
  const groupFace = variant === 'group' && wantsGeneratedFace && !!identityKey
  // One object per face: a new `__html` object makes React write the markup again, and a press that spans that write
  // loses its click.
  const groupFaceMarkup = useMemo(() => (groupFace ? { __html: groupAvatarSvg({ color: groupAvatarColor(identityKey), text: groupAvatarDefaultText(name), fill: 'var(--card)', px, label: name }) } : undefined), [groupFace, identityKey, name, px])
  const agentDefault = variant !== 'group' && agent === true && wantsGeneratedFace && !!identityKey
  const animatedAssistant = agentDefault && assistant && !still
  const generatedUrl = variant !== 'group' && wantsGeneratedFace && agent === false && identityKey ? dicebearAvatarDataUri(identityKey) : null
  const missingIdentityKey = wantsGeneratedFace && !identityKey
  useEffect(() => {
    if (!missingIdentityKey) return
    console.error(`[Avatar] missing identity key for "${name}" — a generated default face needs a stable id; display name must never seed it`)
  }, [missingIdentityKey, name])

  // 脸(上传图 / 默认脸 / 空态)一律不挂原生 title:头像常被放进别人的悬停浮层(账号 Hint、
  // 运行中 agent 的预览卡),名字由外层自己说,挂了就是两个浮层叠在一起。读屏的名字在 alt / aria-label。
  return (
    <div style={base} data-agent={agent ? '' : undefined}>
      {showImg ? (
        imageMatteColor ? (
          <span data-avatar-matte style={matteStyle}>
            <img
              src={url!}
              alt={name}
              style={imgStyle}
              onError={() => { console.error(`[Avatar] failed to load canonical avatar for "${name || 'unknown'}"`); setImgFailed(true) }}
            />
          </span>
        ) : (
          <img
            src={url!}
            alt={name}
            style={imgStyle}
            onError={() => { console.error(`[Avatar] failed to load canonical avatar for "${name || 'unknown'}"`); setImgFailed(true) }}
          />
        )
      ) : groupFace ? (
        <span data-group-face style={{ width: px, height: px, flexShrink: 0, display: 'block' }}
          dangerouslySetInnerHTML={groupFaceMarkup} />
      ) : agentDefault ? (
        assistant ? (
          <AssistantDefaultAvatar id={identityKey} avatar={normalized} name={name} size={px} still={still} hoverPoke={hoverPoke} canvasPaddingX={canvasPaddingX}
            state={statusLabel ?? (agentStatus ? labelOfDisplayStatus(agentStatus) : null)} />
        ) : <BoringAgentAvatar id={identityKey} name={name} size={px} />
      ) : generatedUrl ? (
        // @@@2470 生成默认脸（#961 Notionists，CC0/本地生成/离线）：这个身份还没设置头像。
        // 它诚实表达「系统派生」而非冒充某人挑过的作品，且组合空间足够大 → 不同身份不撞脸。
        <img
          src={generatedUrl}
          alt={name}
          aria-label={name}
          draggable={false}
          style={imgStyle}
        />
      ) : (
        <span
          data-avatar-empty
          data-avatar-error={avatarError ? '' : undefined}
          aria-label={`${name || 'Avatar'} unavailable`}
          style={emptyStyle}
        />
      )}
      {agent && harnessBadge && variant !== 'group' ? <AgentHarnessBadge agentId={seed} avatarSize={px} /> : null}
      {agentStatus && !animatedAssistant ? (
        <AgentStatusBadge status={agentStatus} size={badgeSize} />
      ) : null}
    </div>
  )
}
