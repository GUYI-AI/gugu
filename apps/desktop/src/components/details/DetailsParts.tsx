import type { ReactNode } from 'react'
import { ChevronRight } from '@/lib/icons'

/**
 * The 详情 page's parts (第 16 版设计稿 .det / .hero / .chip / .qa / .gt / .dl / .li / .seg): one look for my agent's
 * details and a chat's. Only layout and look; every row's action is its caller's existing one.
 */
export function DetailsPage({ children, testId }: { children: ReactNode; testId?: string }) {
  return <div data-testid={testId} className="@container/details flex min-h-0 flex-1 flex-col overflow-y-auto px-[26px] py-[22px]">{children}</div>
}

/** Centered: the avatar, the name (its own editor), one line under it. */
export function DetailsHero({ avatar, name, sub }: { avatar: ReactNode; name: ReactNode; sub?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-1.5 pt-1.5 pb-[18px]">
      {avatar}
      <div className="flex max-w-full min-w-0 justify-center text-[19px] font-semibold">{name}</div>
      {sub ? <div className="flex items-center gap-1.5 text-[12.5px] leading-[18px] text-[var(--muted-fg)]">{sub}</div> : null}
    </div>
  )
}

/** The name: click to rename (#40), a faint pencil after it. */
export function DetailsName({ name, onEdit, testId }: { name: string; onEdit?: () => void; testId?: string }) {
  return (
    <button type="button" data-testid={testId} disabled={!onEdit} onClick={onEdit}
      className="flex max-w-full min-w-0 items-center gap-1.5 rounded-md px-1 leading-[26px] enabled:cursor-text enabled:hover:bg-row-hover">
      <span className="min-w-0 truncate">{name}</span>
      {onEdit ? <PencilMark /> : null}
    </button>
  )
}

function PencilMark() {
  return <svg aria-hidden viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-[var(--faint-fg)]"><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 1 1 3 3L7 19l-4 1 1-4Z" /></svg>
}

export function DetailsChip({ children, onClick, title }: { children: ReactNode; onClick?: () => void; title?: string }) {
  return <span title={title} onClick={onClick} className={`inline-flex h-[22px] items-center gap-[5px] rounded-full bg-[var(--muted)] px-2 text-[12px] text-[var(--muted-fg)] ${onClick ? 'cursor-pointer' : ''}`}>{children}</span>
}

export function DetailsTiles({ children }: { children: ReactNode }) {
  return <div data-testid="details-tiles" className="mb-5 grid grid-cols-4 gap-2">{children}</div>
}

export function DetailsTile({ icon, label, testId, ...props }: { icon: ReactNode; label: string; testId?: string } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type="button" data-testid={testId} {...props}
      className="flex h-[62px] min-w-0 cursor-pointer flex-col items-center justify-center gap-[5px] rounded-xl bg-[var(--muted)] text-[12px] text-[var(--fg)] hover:bg-[color-mix(in_oklab,var(--fg)_6%,var(--muted))]">
      <span className="flex shrink-0 [&_svg]:size-[18px]">{icon}</span><span className="line-clamp-2 max-w-full px-0.5 text-center leading-[14px] break-words [text-wrap:balance]">{label}</span>
    </button>
  )
}

export function DetailsGroupTitle({ children }: { children: ReactNode }) {
  return <div className="px-1 pb-1 text-[12px] text-[var(--faint-fg)]">{children}</div>
}

export function DetailsList({ children }: { children: ReactNode }) {
  return <div className="mb-4 [&>*:last-child]:border-b-0">{children}</div>
}

/**
 * One row: icon, words, what sits at its end (a value, a switch, the segmented control, a count with ›). The words stay
 * whole: a text value gives way first (truncates); a control that does not fit beside them wraps under them.
 */
export function DetailsRow({ icon, label, end, chevron, onClick, danger, testId, disabled }: {
  icon: ReactNode; label: string; end?: ReactNode; chevron?: boolean; onClick?: () => void; danger?: boolean; testId?: string; disabled?: boolean
}) {
  const text = typeof end === 'string' || typeof end === 'number'
  return (
    <div role={onClick ? 'button' : undefined} tabIndex={onClick && !disabled ? 0 : undefined} data-testid={testId} aria-disabled={disabled || undefined}
      onClick={disabled ? undefined : onClick}
      onKeyDown={onClick && !disabled ? (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onClick() } } : undefined}
      className={`flex min-h-10 items-center gap-x-[11px] border-b border-[var(--border)] px-1 text-[13.5px] ${text ? '' : 'flex-wrap py-[5px]'} ${onClick && !disabled ? 'cursor-pointer' : ''} ${disabled ? 'opacity-50' : ''} ${danger ? 'border-b-0 text-[var(--danger-fg)]' : ''}`}>
      <span className={`flex shrink-0 [&_svg]:size-4 ${danger ? '' : 'text-[var(--muted-fg)]'}`}>{icon}</span>
      <span className="shrink-0 whitespace-nowrap">{label}</span>
      {end !== undefined && end !== null || chevron ? (
        <span className={`ms-auto flex items-center justify-end gap-1 text-[12.5px] text-[var(--faint-fg)] ${text ? 'min-w-0 flex-1' : 'shrink-0'}`}>
          {text ? <span className="min-w-0 truncate" title={String(end)}>{end}</span> : end}
          {chevron ? <ChevronRight className="size-3.5 shrink-0" /> : null}
        </span>
      ) : null}
    </div>
  )
}

/** The design's switch (.sw): 30×18, black when on. */
export function DetailsSwitch({ on, onChange, label, testId }: { on: boolean; onChange: (on: boolean) => void; label: string; testId?: string }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} data-testid={testId}
      onClick={(event) => { event.stopPropagation(); onChange(!on) }}
      className={`relative h-[18px] w-[30px] shrink-0 rounded-[9px] transition-colors ${on ? 'bg-[var(--fg)]' : 'bg-[var(--border-strong)]'}`}>
      <span className={`absolute top-[2px] size-[14px] rounded-full bg-[var(--bg)] transition-[right] ${on ? 'right-[2px]' : 'right-[14px]'}`} />
    </button>
  )
}

/** The design's three-way control (.seg). */
export function DetailsSegmented<T extends string>({ options, value, onChange }: { options: readonly { value: T; label: string }[]; value: T; onChange: (value: T) => void }) {
  return (
    <span role="radiogroup" className="flex gap-0.5 rounded-lg bg-[var(--muted)] p-0.5" onClick={(event) => event.stopPropagation()}>
      {options.map((option) => (
        <button key={option.value} type="button" role="radio" aria-checked={option.value === value} onClick={() => onChange(option.value)}
          className={`rounded-md px-2 py-[3px] text-[12px] whitespace-nowrap @max-[340px]/details:px-1 @max-[340px]/details:tracking-tight ${option.value === value ? 'bg-[var(--bg)] text-[var(--fg)] shadow-xs' : 'text-[var(--muted-fg)]'}`}>
          {option.label}
        </button>
      ))}
    </span>
  )
}
