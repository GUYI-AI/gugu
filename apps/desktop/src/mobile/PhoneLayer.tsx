import type { ReactNode } from 'react'
import { RETAINED_SURFACE_HIDDEN_STYLE } from '@/lib/retainedSurface'

/**
 * 手机上推在「消息 / 伙伴」首页上的一层(咕咕、项目、我的;owner 10-26,OpenDCAI/gugu#446):整屏盖住分页器、没有底栏,
 * 返回回到推它之前那一格。不在最上面时常驻只藏(lib/retainedSurface.ts):草稿、滚动位置、各自往下钻的层级都在,
 * 同从前它们是分页器里的一页。
 *
 * #1751 藏着的层整层 inert(根与后代):不参与选区、焦点、点击和无障碍树,打开这一层才解除。
 * 只靠 RETAINED_SURFACE_HIDDEN_STYLE 时被跳过的只是后代,根 DIV 自己仍是可选的空块,手机上拖选区手柄时
 * Chromium 把它的 offset 0 当成落点(真机 102 条采样 19 条落在 mobile-settings-layer),文字跳。
 * retainedSurface.ts 里「❌ inert」的代价是继承开关逼整棵子树重算样式(可见的 7482 元素树单独切 inert,
 * headless Chromium 实测 21.6–23.6 ms);这里 inert 与 content-visibility:hidden 同一次提交切换,被锁住的子树
 * 不随之重算,打开时的子树样式/布局本来就由 content-visibility 解锁付掉:同法实测 7485 元素
 * 收起 1.0–1.2 ms、打开 4.2–7.1 ms,与不加 inert 的 0.9–1.3 / 4.7–5.4 ms 在噪声内。
 */
export function PhoneLayer({ open, testId, children }: { open: boolean; testId?: string; children: ReactNode }) {
  return (
    <div data-phone-layer="" data-open={open || undefined} data-testid={testId} inert={!open} style={open ? undefined : RETAINED_SURFACE_HIDDEN_STYLE}>
      {children}
    </div>
  )
}
