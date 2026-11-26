import type { ComponentProps } from 'react'
import { ChevronDown } from '@/lib/icons'
import './settings.css'

export function SettingsSelect(props: Omit<ComponentProps<'select'>, 'className'>) {
  return (
    <span className="gg-settings-select-wrap">
      <select {...props} className="gg-settings-select" />
      <ChevronDown size={16} className="gg-settings-select-icon" aria-hidden />
    </span>
  )
}
