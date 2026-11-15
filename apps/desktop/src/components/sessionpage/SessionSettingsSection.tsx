import { lazy, Suspense } from 'react'
import { useUiPortalContainer } from '@gugu/session-ui/react/primitives'
import { useTheme } from '@/store/theme'
import type {
  SessionSettingsContext,
  SessionSettingsSection as Section,
} from '@/session/renderer/features/settings/components/SettingsPage'
import { sessionSkinClassName } from './sessionSkin'
import { SessionUiTheme } from './SessionUiTheme'

// 会话页的设置组件是会话页那一份 14MB 渲染层的一部分:用到才拉(与 EmdashSessionFrame 同一个 chunk 图,
// 会话页常驻预热时它早已在内存里)。
const SessionSettingsContent = lazy(() =>
  import('@/session/renderer/features/settings/components/SettingsPage').then((m) => ({ default: m.SessionSettingsContent })),
)

/**
 * 设置弹窗里由会话页画的那几格(product spec)。壳与会话页同一次构建、同一份模块实例,
 * 所以这里直接渲染会话页的组件,❌ portal、❌ 交接对象。
 * 内容放在带会话页皮肤的元素里(`.gugu-skin` + emlight/emdark,会话页的全局规则收窄在这上面);
 * 这几格的浮层(下拉、提示、确认框)落在 SessionUiTheme 给的那一层 —— 在弹窗**里面**(弹窗的焦点圈、
 * 点外面关、inert 都按 DOM 包含关系判),固定定位、零尺寸,不被设置正文的滚动区裁掉。
 */
export function SessionSettingsSection({ section, context }: { section: Section; context?: SessionSettingsContext }) {
  const { theme } = useTheme()
  return (
    <SessionUiTheme theme={theme} skin>
      <div className={sessionSkinClassName(theme)} data-session-settings-section={section}>
        <Suspense fallback={null}>
          <SectionContent section={section} context={context} />
        </Suspense>
      </div>
    </SessionUiTheme>
  )
}

function SectionContent({ section, context }: { section: Section; context?: SessionSettingsContext }) {
  const layer = useUiPortalContainer()
  return layer ? <SessionSettingsContent section={section} portalContainer={layer} context={context} /> : null
}
