import { registerPlugin } from '@capacitor/core'

export interface NativeTextSelectionRequest {
  id: string
  text: string
  start: number
  end: number
  title: string
  closeLabel: string
  dark: boolean
}

export interface NativeTextSelection {
  /** Resolves when the native page closes. Copying stays entirely with the OS. */
  open(request: NativeTextSelectionRequest): Promise<void>
  close(request: { id: string }): Promise<void>
}

export const nativeTextSelection = registerPlugin<NativeTextSelection>('GuguTextSelection')
