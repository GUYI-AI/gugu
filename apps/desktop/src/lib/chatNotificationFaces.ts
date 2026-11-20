// #3416 The default sources of chatNotificationPresentation: the faces the chat list already draws, as bitmaps an OS
// notification can hold. Nothing here decides whose face it is or invents a look — it reuses `memberFace` (someone's
// picture, else the stable-id default human / agent face), `customAvatarUrl` and the shared group face, and only
// rasterizes what the OS cannot read (SVG).
import { groupAvatarColorIndex, groupAvatarDefaultText, groupAvatarSvg } from '@gugu/core/shared/ui/groupAvatar'
import type { PresentationSources } from './chatNotificationPresentation'
import { customAvatarUrl } from './dicebearAvatar'
import type { DisplayIdentity } from './displayIdentity'
import { readIdentityDirectoryBridge } from './identityDirectoryBridge'
import { memberFace } from './memberFaces'
import { redrawImage } from './redrawImage'

/** Edge of a drawn face, px: sharp as a conversation icon, a few KB as PNG/WebP. */
const FACE_PX = 192
/** How long a missing identity is asked for before it counts as not known. */
const IDENTITY_WAIT_MS = 4000

/**
 * The default group face on a solid disc, colours already resolved: a notification is drawn by the OS over any
 * background, and an SVG loaded as an image cannot see the page's CSS variables. Seeded by the group's id and named by
 * its first characters, exactly as `Avatar variant="group"` draws it.
 */
export function defaultGroupFaceSvg(group: { id: string; name: string }, readVar: (name: string) => string): string {
  const index = groupAvatarColorIndex(group.id) + 1
  const colour = (name: string, fallback: string) => readVar(name).trim() || fallback
  const text = colour(`--avatar-group-text-${index}`, '#d7c198')
  const stroke = colour(`--avatar-group-stroke-${index}`, '#a48c5d')
  const disc = colour('--card', '#191919')
  const face = groupAvatarSvg({ color: text, strokeColor: stroke, text: groupAvatarDefaultText(group.name), px: FACE_PX, label: group.name })
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 208 208" width="${FACE_PX}" height="${FACE_PX}">`
    + `<circle cx="104" cy="104" r="104" fill="${disc}"/>${face}</svg>`
}

const rasterize = (src: string) => redrawImage(src, { size: FACE_PX, fit: 'cover', type: 'image/png' })
const svgUri = (svg: string) => `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`

/** An identity from the host's directory: at hand, else asked for and awaited (bounded). No directory = not known. */
function identityFromDirectory(id: string): Promise<DisplayIdentity | null> {
  const bridge = readIdentityDirectoryBridge()
  if (!bridge) return Promise.resolve(null)
  const read = () => bridge.getSnapshot()?.[id] ?? null
  const known = read()
  if (known) return Promise.resolve(known)
  bridge.ensure([id])
  return new Promise((resolve) => {
    const finish = (identity: ReturnType<typeof read>) => { clearTimeout(timer); stop(); resolve(identity) }
    const stop = bridge.subscribe(() => { const found = read(); if (found) finish(found) })
    const timer = setTimeout(() => finish(read()), IDENTITY_WAIT_MS)
  })
}

export function createNotificationFaceSources(): PresentationSources {
  return {
    identity: identityFromDirectory,
    async userFace(identity) {
      const face = await memberFace(identity.id, identity.avatar)
      // memberFace hands the Boring agent default back as the original SVG; an OS notification cannot read SVG.
      return face && face.startsWith('data:image/svg') ? rasterize(face) : face
    },
    async groupFace({ id, name, avatar }) {
      const custom = customAvatarUrl(avatar, 'chat notification')
      // An explicit picture that is malformed or does not load is the unavailable state, never the default face
      // (same rule as Avatar: the default stands for an unset picture only).
      if (avatar != null) return custom ? rasterize(custom) : null
      const style = getComputedStyle(document.documentElement)
      return rasterize(svgUri(defaultGroupFaceSvg({ id, name }, (variable) => style.getPropertyValue(variable))))
    },
  }
}
