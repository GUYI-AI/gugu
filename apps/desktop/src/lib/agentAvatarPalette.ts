import { AVATAR_PALETTE, avatarColorIndex, type AvatarTheme } from '@gugu/core/shared/ui/avatarPalette'

/** Beam's original seed preserves all face geometry; color is the shared identity hue. */
export function boringAvatarAppearance(id: string, theme: AvatarTheme = 'light'): { seed: number; body: string; background: string } {
  let hash = 0
  for (let i = 0; i < id.length; i++) hash = ((hash << 5) - hash + id.charCodeAt(i)) | 0
  const { body, background } = AVATAR_PALETTE[avatarColorIndex(id)][theme]
  return { seed: Math.abs(hash), body, background }
}

/** The circle mask is luminance: opaque white keeps the face, independent of theme. */
export const BORING_MASK_FILL = '#FFFFFF'
