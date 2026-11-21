import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'

// 通讯录右侧(分组页、搜索结果)唯一的一套列轨:最多 4 列等宽,列数按正文自己的宽度 4→3→2→1(容器查询 ——
// 右边抽屉开着时正文变窄,列数跟着少,❌ 按窗口宽度)。人行、群行、agent 家族与单个 agent 都排在它上面,同一页上的
// 竖线因此是同一组。断点 = 每列至少约 220px、列缝 40px:2 列 ≥ 480px,3 列 ≥ 740px,4 列 ≥ 1000px。
// gg-c-grid:屏幕外的人行 / 群行跳过布局与绘制,见 tokens.css @@@contacts-offscreen-rows。
export function ContactsGrid({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div className="@container">
      <div className={cn('gg-c-grid grid grid-cols-1 gap-x-10 @min-[480px]:grid-cols-2 @min-[740px]:grid-cols-3 @min-[1000px]:grid-cols-4', className)}>
        {children}
      </div>
    </div>
  )
}
