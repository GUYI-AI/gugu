import { createElement } from 'react'
import { readAvatarTheme } from './avatarTheme'
import type { AvatarTheme } from '@gugu/core/shared/ui/avatarPalette'
import { renderToStaticMarkup } from 'react-dom/server'
import { BoringAgentAvatar } from '../components/BoringAgentAvatar'

/** Image-only consumers use the same official SVG component; no rasterization or remote service. */
export function boringAgentAvatarDataUri(id: string, theme: AvatarTheme = readAvatarTheme()): string {
  const svg = renderToStaticMarkup(createElement(BoringAgentAvatar, { id, name: id, size: 256, theme }))
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`
}
