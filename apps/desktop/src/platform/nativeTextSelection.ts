import { registerPlugin } from '@capacitor/core'
import type { NativeRichText } from './nativeRichText'

export interface NativeTextSelectionRequest extends NativeRichText {
  id: string
  title: string
  closeLabel: string
  /** Comment, beside the OS's own Copy, in the person's language: pressed, the page closes and hands back the words. */
  commentLabel?: string
  dark: boolean
  appearance: NativeTextSelectionAppearance
}

export interface NativeTextSelectionAppearance {
  x: number
  y: number
  width: number
  height: number
  viewportWidth: number
  fontSize: number
  lineHeight: number
  color: string
}

export interface NativeTextSelection {
  /** Resolves when the native selection closes, with the selected words when Comment closed it. Copying stays entirely with the OS. */
  open(request: NativeTextSelectionRequest): Promise<{ comment?: string } | undefined>
  close(request: { id: string }): Promise<void>
}

export const nativeTextSelection = registerPlugin<NativeTextSelection>('GuguTextSelection')
