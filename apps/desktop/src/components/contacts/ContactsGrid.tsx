import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'

// 通讯录右侧(分组页、搜索结果)唯一的一套列轨:最多 4 列等宽,列数按正文自己的宽度 4→3→2→1(容器查询,
// ❌ 按窗口宽度:左栏收放、窗口大小都只经正文宽度起作用)。人行、群行、agent 家族与单个 agent 都排在它上面,同一页上的
// 竖线因此是同一组。断点 = 每列至少约 220px、列缝 40px:2 列 ≥ 480px,3 列 ≥ 740px,4 列 ≥ 1000px。列数只写在 --c-cols 一处。
// fill(agent 家族):同一套列宽当起点,一行没排满时把剩下的宽度分给这一行的格子 —— 家族是缩进的大纲,名字要用到正文还空着的宽度,
// 排满的行与网格一样落在列线上。
// gg-c-grid:屏幕外的人行 / 群行跳过布局与绘制,见 tokens.css @@@contacts-offscreen-rows。
export function ContactsGrid({ className, fill, children }: { className?: string; fill?: boolean; children: ReactNode }) {
  return (
    <div className="@container">
      <div className={cn('gg-c-grid gap-x-10 [--c-cols:1] @min-[480px]:[--c-cols:2] @min-[740px]:[--c-cols:3] @min-[1000px]:[--c-cols:4]', fill
        ? 'flex flex-wrap *:min-w-0 *:grow *:basis-[calc((100%-(var(--c-cols)-1)*2.5rem)/var(--c-cols))]'
        : 'grid grid-cols-[repeat(var(--c-cols),minmax(0,1fr))]', className)}>
        {children}
      </div>
    </div>
  )
}
