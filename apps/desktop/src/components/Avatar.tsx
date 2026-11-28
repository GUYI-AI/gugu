import { useState, useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { labelOfDisplayStatus } from '@gugu/core/shared/ui/agentConversationStatusModels'
import type { AgentStatusLabel } from '@gugu/core/shared/agentStatusPresentation'
import type { AgentDisplayStatus } from '@gugu/core/shared/types/chat'
import { groupAvatarColorIndex, groupAvatarDefaultText, groupAvatarSvg, groupAvatarThemeColors } from '@gugu/core/shared/ui/groupAvatar'
import { faceImageUrl, identityFace } from '../lib/identityFace'
import { useAvatarTheme } from '../lib/avatarTheme'
import { AgentContactStatusMark } from './AgentContactStatusMark'
import { agentStatusHasMark } from '@/lib/agentStatusMark'
import { AssistantDefaultAvatar } from './assistant/AssistantDefaultAvatar'
import { useAvatarIdentity, useIsAssistantAvatar } from '../lib/avatarIdentity'

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
  agentStatus?: AgentDisplayStatus
  // The assistant expresses the precise status with its 3D figure; other agents use the status badge.
  statusLabel?: AgentStatusLabel
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
// @@@avatar-status-corner - an agent's one status mark, in the avatar's bottom-right corner (AgentContactStatusMark).
// The running glyph sits on a small see-through round backing so it covers little of the face; the solid marks
// (needs you, error, offline — AgentMarkGlyph) are opaque shapes and have no backing.
const SOLID_MARKS: ReadonlySet<AgentDisplayStatus> = new Set(['needs_user', 'error', 'offline'])

function AgentStatusCorner({ status, avatarSize }: { status: AgentDisplayStatus; avatarSize: number }) {
  const { t } = useTranslation('common')
  const size = Math.max(8, Math.min(14, Math.round(avatarSize * 0.34)))
  if (!agentStatusHasMark(status)) return null
  const solid = SOLID_MARKS.has(status)
  const text = t(`agentStatus.${labelOfDisplayStatus(status)}`)
  return (
    <span className={`av-status av-status--${status}${solid ? ' av-status--solid' : ''}`} role="img" aria-label={text} title={text} style={{ '--av-status-size': `${size}px` } as React.CSSProperties}>
      <AgentContactStatusMark tone={status} size={size} className={solid ? undefined : 'av-status__glyph'} />
    </span>
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
  hoverPoke = false,
  canvasPaddingX = 0,
  still = false,
  variant = 'default',
  imageMatteColor,
}: AvatarProps) {
  const theme = useAvatarTheme()
  const [imgFailed, setImgFailed] = useState(false)
  const identityKey = (seed ?? '').trim()
  const identity = useAvatarIdentity(isAgent === undefined && variant !== 'group' ? identityKey : '')
  const agent = isAgent ?? (identity ? identity.type === 'agent' : undefined)
  const assistant = useIsAssistantAvatar(identityKey)
  // Which face this is: lib/identityFace.ts decides it for every surface; this component only draws it.
  const face = identityFace({ id: identityKey, avatar: avatarUrl, type: variant === 'group' ? 'group' : agent === undefined ? undefined : agent ? 'agent' : 'human', assistant })
  const url = face.kind === 'picture' || face.kind === 'human' || face.kind === 'agent' ? faceImageUrl(face, 'avatar', theme) : null
  // @@@1482 url 变化时在 render 期重置加载失败态（React 官方「按 prop 变化调整 state」模式，非 useEffect）：
  // 新 url 的第一帧就不带上一张图的失败态，不会先闪一下空态。
  const [trackedUrl, setTrackedUrl] = useState(url)
  if (url !== trackedUrl) {
    setTrackedUrl(url)
    setImgFailed(false)
  }
  const px = typeof size === 'number' ? size : SIZE_MAP[size]
  // Every identity uses the same circular picture, matte and unavailable state.
  const radius = '50%'

  // An unavailable face (dirty sentinel, missing id) is an explicit empty state; faceImageUrl logs why, once per change.
  // A picture that fails to load is logged by onError below.
  const unavailable = face.kind === 'unavailable' ? face.reason : null
  useEffect(() => {
    if (unavailable) faceImageUrl({ kind: 'unavailable', reason: unavailable, avatar: avatarUrl }, `main avatar "${name || 'unknown'}"`)
  }, [unavailable, avatarUrl, name])

  // The frame anchors the corner mark and leaves it room to paint. The portrait below owns any circular crop.
  const frameStyle: React.CSSProperties = {
    position: 'relative',
    overflow: 'visible',
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

  const showImg = !!url && !imgFailed
  // 自定义头像坏掉（加载失败 / 非法串）才是错误；没设置头像不是错误。
  const avatarError = imgFailed || (face.kind === 'unavailable' && face.reason === 'invalid')
  // One object per face: a new `__html` object makes React write the markup again, and a press that spans that write
  // loses its click.
  const groupFace = face.kind === 'group'
  const groupFaceMarkup = useMemo(() => (groupFace ? { __html: groupAvatarSvg({ ...groupAvatarThemeColors(groupAvatarColorIndex(identityKey)), text: groupAvatarDefaultText(name), px, label: name }) } : undefined), [groupFace, identityKey, name, px])
  const animatedAssistant = face.kind === 'assistant' && !still

  // 脸(上传图 / 默认脸 / 空态)一律不挂原生 title:头像常被放进别人的悬停浮层(账号 Hint、
  // 运行中 agent 的预览卡),名字由外层自己说,挂了就是两个浮层叠在一起。读屏的名字在 alt。
  const img = showImg ? (
    <img
      src={url!}
      alt={name}
      draggable={face.kind === 'picture' ? undefined : false}
      data-face={face.kind}
      style={imgStyle}
      onError={() => { console.error(`[Avatar] failed to load canonical avatar for "${name || 'unknown'}"`); setImgFailed(true) }}
    />
  ) : null
  return (
    <div style={frameStyle} data-agent={agent ? '' : undefined}>
      {img ? (
        imageMatteColor && face.kind === 'picture' ? <span data-avatar-matte style={matteStyle}>{img}</span> : img
      ) : groupFace ? (
        <span data-group-face style={{ width: px, height: px, flexShrink: 0, display: 'block' }}
          dangerouslySetInnerHTML={groupFaceMarkup} />
      ) : face.kind === 'assistant' ? (
        <AssistantDefaultAvatar id={face.id} avatar={face.avatar} name={name} size={px} still={still} hoverPoke={hoverPoke} canvasPaddingX={canvasPaddingX}
          state={statusLabel ?? (agentStatus ? labelOfDisplayStatus(agentStatus) : null)} />
      ) : (
        <span
          data-avatar-empty
          data-avatar-error={avatarError ? '' : undefined}
          aria-label={`${name || 'Avatar'} unavailable`}
          style={emptyStyle}
        />
      )}
      {agentStatus && !animatedAssistant ? (
        <AgentStatusCorner status={agentStatus} avatarSize={px} />
      ) : null}
    </div>
  )
}
