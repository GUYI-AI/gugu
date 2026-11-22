import { useLayoutEffect, useState, useSyncExternalStore } from 'react'
import { Toaster } from 'sonner'
import { useTranslation } from 'react-i18next'
import { readEffectiveHostTheme, subscribeToHostTheme } from '@renderer/lib/theme/host-theme'
import { bannerFeed, type Banner } from '@/lib/notices'
import { LoadingIndicator } from '@/lib/loading/LoadingIndicator'
import { AlertTriangle, ChevronLeft, ChevronRight, CheckCircle2, Info, X } from '@/lib/icons'
import { Button } from './ui/Button'
import { IconButton } from './ui/IconButton'
import './notice-host.css'
import { useNoticeComposerBottom } from './notice-host-position'

const CHANGED = 'gugu:notice-host-changed'
let hostSeq = 0

/**
 * 「谁来画」(#137):同一个文档里提示条和横幅位各只有一个在画。认领记在 `<html>` 上而不是模块变量里,
 * 因为主 app 与会话页两个入口各是各的 bundle,模块变量不跨入口。
 *  · 先到先得;画的那个卸载了,留着的接着认领(不然提示凭空消失)。
 *  · 主 app 的比会话页的优先:会话页是主 app 里的一块(平时隐藏在别的页面后面),主 app 重挂(登录 / 登出换了一棵树)时
 *    会话页会先接手,主 app 的新宿主一挂上就从它手里接回来,❌ 让提示留在一个看不见的宿主里。
 *  · 会话页单独成一个文档(没有主 app)时,由它自己画。
 */
function canClaim(holder: string | undefined, embedded: boolean): boolean {
  return !holder || (!embedded && holder.startsWith('embedded:'))
}
function useDocumentClaim(claim: 'noticeHost' | 'noticeBanner', embedded: boolean): boolean {
  // 能认领就在第一次渲染里就画出来:sonner 的提示条只认它挂上之后发的提示(之前发的不补),
  // 晚一拍才画,同一次挂载里子组件发的提示就丢了。认领本身仍在下面的 layout effect 里做,认不到再收回。
  const [owner, setOwner] = useState(() => canClaim(document.documentElement.dataset[claim], embedded))
  useLayoutEffect(() => {
    const root = document.documentElement
    const me = `${embedded ? 'embedded' : 'app'}:${++hostSeq}`
    let owned = false
    const settle = () => {
      const holder = root.dataset[claim]
      if (owned) {
        // 被主 app 的接走了:放手。
        if (holder !== me) {
          owned = false
          setOwner(false)
        }
        return
      }
      if (!canClaim(holder, embedded)) return setOwner(false)
      root.dataset[claim] = me
      owned = true
      setOwner(true)
      document.dispatchEvent(new Event(CHANGED))
    }
    settle()
    document.addEventListener(CHANGED, settle)
    return () => {
      document.removeEventListener(CHANGED, settle)
      if (!owned || root.dataset[claim] !== me) return
      delete root.dataset[claim]
      document.dispatchEvent(new Event(CHANGED))
    }
  }, [claim, embedded])
  return owner
}

/** 转瞬的提示条:composer 上方(看得见 composer / 手机 tab 栏时贴其上沿 8px),一次一条。 */
export function NoticeHost({ closeLabel, embedded = false }: { closeLabel?: string; /** 会话页里的那一份(见上)。 */ embedded?: boolean }) {
  // 主题真值读全局订阅,❌ 读 React 上下文:会话页是另一棵根,拿不到主 app 的 ThemeContext。
  const theme = useSyncExternalStore(subscribeToHostTheme, readEffectiveHostTheme, () => 'light' as const)
  const owner = useDocumentClaim('noticeHost', embedded)
  const composerBottom = useNoticeComposerBottom(owner)
  if (!owner) return null
  return (
    <Toaster
      className={composerBottom === undefined ? 'gugu-notices' : 'gugu-notices gugu-notices-above-composer'}
      position="bottom-right"
      visibleToasts={1}
      offset={composerBottom === undefined ? undefined : { bottom: composerBottom }}
      mobileOffset={composerBottom === undefined ? undefined : { bottom: composerBottom }}
      theme={theme}
      toastOptions={closeLabel ? { closeButtonAriaLabel: closeLabel } : undefined}
    />
  )
}

const TIER_ICON = { error: AlertTriangle, warning: AlertTriangle, success: CheckCircle2, info: Info } as const

/**
 * 常驻的横幅位:页面最上面那一行,占文档流(内容往下让,❌ 浮在内容上),一次露一条,「‹ 1/2 ›」翻其余。
 * 全 app 只挂这一处(MainLayout;会话页单独成文档时由它自己挂,同上的认领规则)。
 */
export function NoticeBannerSlot({ embedded = false }: { embedded?: boolean }) {
  const { t } = useTranslation('common')
  const owner = useDocumentClaim('noticeBanner', embedded)
  const list = useSyncExternalStore(bannerFeed.subscribe, bannerFeed.read, bannerFeed.read)
  const [pick, setPick] = useState<string>()
  if (!owner || list.length === 0) return null
  // 停在用户翻到的那一条;它没了(或还没翻过)就露最新进来的那条。
  const index = Math.max(0, pick === undefined ? list.length - 1 : list.findIndex((banner) => banner.key === pick))
  const shown = list[index]
  const step = (by: number) => setPick(list[(index + by + list.length) % list.length].key)
  return (
    <div className="gugu-notice-banner-slot" data-testid="notice-banner-slot">
      <NoticeBanner banner={shown} closeLabel={t('toast.dismiss')} pager={list.length > 1 && (
        <div className="gugu-notice-banner-pager" aria-label={t('notice.position', { index: index + 1, total: list.length })}>
          <IconButton size="sm" aria-label={t('notice.previous')} onClick={() => step(-1)}><ChevronLeft size={14} /></IconButton>
          <span>{index + 1}/{list.length}</span>
          <IconButton size="sm" aria-label={t('notice.next')} onClick={() => step(1)}><ChevronRight size={14} /></IconButton>
        </div>
      )} />
    </div>
  )
}

function NoticeBanner({ banner, pager, closeLabel }: { banner: Banner; pager: React.ReactNode; closeLabel: string }) {
  const TierIcon = banner.tier ? TIER_ICON[banner.tier] : undefined
  const icon = banner.waiting ? <LoadingIndicator size="inline" /> : banner.icon ?? (TierIcon && <TierIcon size={16} />)
  return (
    <section className="gugu-notice-banner" data-tier={banner.tier} data-notice-key={banner.key}
      role={banner.tier === 'error' || banner.tier === 'warning' ? 'alert' : 'status'}>
      {icon && <div className="gugu-notice-banner-icon">{icon}</div>}
      <div className="gugu-notice-banner-body">
        {banner.title && <div className="gugu-notice-banner-title">{banner.title}</div>}
        {banner.description && <div className="gugu-notice-banner-description">{banner.description}</div>}
      </div>
      {pager}
      {banner.action && <Button size="sm" variant="primary" onClick={banner.action.onClick}>{banner.action.label}</Button>}
      {banner.dismissible !== false && (
        <IconButton size="sm" aria-label={closeLabel} data-notice-close="" onClick={() => bannerFeed.close(banner.key)}><X size={14} /></IconButton>
      )}
    </section>
  )
}
