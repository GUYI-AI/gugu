import type { HTMLAttributes, ReactNode } from 'react'
import { cn } from '@/lib/cn'

/**
 * @@@ui-ruler SectionLabel — 分区标签的唯一实现(「Agent / 个人 / 群组」「通用」「用量窗口」……)。
 * 原来通讯录用 --text-secondary、设置用 --faint-fg、积分面板用 --text-tertiary,字距 .03/.04em 各自拍;
 * 现在全 app 一种:caption 12/18 medium、muted-fg、字距 0(几何在 tokens.css .gg-section-label)。
 * 面板里分区只有一层,计数放 trailing(右端),折叠的 chevron 也放 trailing —— 分区名留在面板的左边线上。
 * 可折叠分区把 chevron 放 leading、加号放 trailing;点击折叠由调用方挂 onClick + interactive。
 */
export interface SectionLabelProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode
  leading?: ReactNode
  trailing?: ReactNode
  interactive?: boolean
  className?: string
}

export function SectionLabel({ children, leading, trailing, interactive, className, ...rest }: SectionLabelProps) {
  return (
    <div
      {...rest}
      data-slot="section-label"
      data-interactive={interactive || undefined}
      className={cn('gg-section-label', className)}
    >
      {leading}
      <span style={{ flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{children}</span>
      {trailing}
    </div>
  )
}
