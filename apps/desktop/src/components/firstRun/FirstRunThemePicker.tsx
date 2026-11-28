import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Dialog } from '@/components/ui/Dialog'
import { Button } from '@/components/ui/Button'
import { SegmentedTabs } from '@/components/ui/SegmentedTabs'
import { useTheme, type ThemePreference } from '@/store/theme'
import { writeThemePreference } from '@renderer/lib/theme/host-theme'
import { readThemePackChoice, restoreThemePackChoice, type ThemePackChoice } from '@renderer/lib/theme/theme-pack-store'
import { SessionSettingsSection } from '../sessionpage/SessionSettingsSection'

const APPEARANCE: readonly ThemePreference[] = ['light', 'dark', 'system']

/**
 * 新用户第一次进主界面时挑一次主题(owner 11-26)。卡片就是设置 → 界面里那一份(FirstRunThemePackGrid),
 * 点一张整个窗口立刻换成那族 —— 背后的真界面就是预览,所以弹窗里 ❌ 另画预览、❌ 弹撤销提示。
 * 明暗默认「跟随系统」(owner 11-26 21:13):一打开就切过去,弹窗里看到的就是什么都不点得到的样子。
 * 「完成」留下当下的选择;「跳过」/ Esc / 点外面 = 回到打开时的样子(默认的 GitHub + 跟随系统)。
 */
export function FirstRunThemePicker({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation('main')
  const { preference, setTheme } = useTheme()
  const [opened] = useState<ThemePackChoice>(() => ({ ...readThemePackChoice(), preference: 'system' }))
  useEffect(() => { writeThemePreference('system') }, [])
  const skip = () => {
    restoreThemePackChoice(opened)
    onClose()
  }
  return <Dialog.Root open onOpenChange={(open) => { if (!open) skip() }}>
    <Dialog.Portal>
      <Dialog.Backdrop className="fixed inset-0 z-[var(--z-modal)] bg-[var(--bg-overlay-soft)]" />
      <Dialog.Viewport className="pointer-events-none fixed inset-0 z-[var(--z-modal)] flex items-center justify-center p-6">
        <Dialog.Popup data-testid="first-run-theme" className="pointer-events-auto flex max-h-full w-full max-w-[720px] flex-col overflow-hidden rounded-[var(--radius-dialog)] border border-[var(--border)] bg-[var(--card)] text-[length:var(--font-body)] text-[var(--text-primary)] shadow-[var(--shadow-dialog)] outline-none">
          <div className="flex items-start gap-4 px-6 pt-6 pb-4">
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <Dialog.Title className="text-[length:var(--font-title)] font-medium">{t('firstRun.themeTitle')}</Dialog.Title>
              <Dialog.Description className="text-[var(--text-secondary)]">{t('firstRun.themeSub')}</Dialog.Description>
            </div>
            <SegmentedTabs ariaLabel={t('settings.general.theme')} value={preference} onChange={setTheme}
              items={APPEARANCE.map((value) => ({ value, label: t(`settings.general.${value}`) }))} />
          </div>
          {/* 这一格由会话页画,自带页面底色(.gugu-skin):弹窗底是 --card,深色下会多出一块深底 —— 透明,和设置里同一做法。 */}
          <div className="min-h-0 overflow-y-auto px-6 [&_[data-session-settings-section]]:bg-transparent">
            <SessionSettingsSection section="theme-packs-first-run" />
          </div>
          <div className="flex justify-end gap-2 px-6 pt-4 pb-6">
            <Button variant="ghost" onClick={skip} data-testid="first-run-theme-skip">{t('firstRun.themeSkip')}</Button>
            <Button variant="primary" onClick={onClose} data-testid="first-run-theme-done">{t('firstRun.themeDone')}</Button>
          </div>
        </Dialog.Popup>
      </Dialog.Viewport>
    </Dialog.Portal>
  </Dialog.Root>
}
