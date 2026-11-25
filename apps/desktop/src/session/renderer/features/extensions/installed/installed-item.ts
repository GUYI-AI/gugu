import type { ReactNode } from 'react'

export type InstalledSection = 'agents' | 'apps' | 'connectors'
export type InstalledItem = {
  id: string
  name: string
  version?: string | null
  icon: (size: number) => ReactNode
  open?: () => void
  enabled?: boolean
  setEnabled?: (value: boolean) => void | Promise<void>
  update?: () => void | Promise<void | boolean>
  remove?: () => void | Promise<void>
  updateVersion?: string
  updateError?: string
  busyLabel?: string
  busy?: boolean
}
