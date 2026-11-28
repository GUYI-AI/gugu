// The face of an identity — the one place that decides it. `identityFace` says which face someone shows; `<Avatar>`
// draws that face, and every surface that can only hold an image (share poster, delivery cards, App pages, OS
// notifications) takes `faceImageUrl` of the same face, so one identity has one face everywhere.
//   · picture   — an uploaded picture: the picture is the identity.
//   · human     — no picture: DiceBear Notionists (CC0, local, offline) seeded by the stable id (#961).
//   · agent     — no picture, or a stored assistant-look address: Boring Avatars' beam seeded by the stable id. Looks
//                 belong to the assistant alone; an ordinary agent never draws the bird.
//   · assistant — the viewer's assistant with no picture: the bird (components/assistantFigure), its look from the
//                 avatar field, else derived from the id.
//   · group     — a group or project with no picture: groupAvatarSvg (Avatar draws it inline, with live theme colours).
//   · unavailable — a dirty sentinel avatar ("undefined"/"null"), a missing id, or an identity whose type is not
//                 known yet: an explicit empty slot, never a stand-in face over an upstream bug.
// @@@2470 The seed is always the stable id — never the name: a rename must not change the face, and namesakes must not
// share one.
import { createAvatar } from '@dicebear/core'
import { notionists } from '@dicebear/collection'
import { AVATAR_FEATURE_COLOR, AVATAR_PALETTE, avatarColorIndex, type AvatarTheme } from '@gugu/core/shared/ui/avatarPalette'
import { normalizeAvatarUrl, reportInvalidAvatarUrl } from '@gugu/core/shared/ui/avatarUrl'
import { isLookAvatarUrl, resolveAssistantLook } from '../components/assistantFigure/look'
import { assistantPoster } from '../components/assistantFigure/posters'
import { isAssistantAvatar } from './avatarIdentity'
import { readAvatarTheme } from './avatarTheme'
import { withoutBlend } from './notionistsBlend'

export type FaceIdentity = {
  id: string | null | undefined
  avatar: string | null | undefined
  /** undefined = the directory has not said yet. */
  type: 'human' | 'agent' | 'group' | undefined
  /** Whether this agent is the viewer's assistant; React callers pass `useIsAssistantAvatar`, others read the bridge. */
  assistant?: boolean
}

export type Face =
  | { kind: 'picture'; url: string }
  | { kind: 'human'; id: string }
  | { kind: 'agent'; id: string }
  | { kind: 'assistant'; id: string; avatar: string | null }
  | { kind: 'group'; id: string }
  | { kind: 'unavailable'; reason: 'invalid' | 'missing-id' | 'unknown-type'; avatar: string | null | undefined }

export function identityFace({ id: rawId, avatar: raw, type, assistant }: FaceIdentity): Face {
  const id = (rawId ?? '').trim()
  const avatar = normalizeAvatarUrl(raw)
  if (raw != null && avatar == null) return { kind: 'unavailable', reason: 'invalid', avatar: raw }
  // A look address is the assistant's figure, not a picture to load — except on a human, where it is just an image.
  if (avatar && (type === 'human' || type === 'group' || !isLookAvatarUrl(avatar))) return { kind: 'picture', url: avatar }
  if (!id) return { kind: 'unavailable', reason: 'missing-id', avatar: raw }
  if (type === 'human') return { kind: 'human', id }
  if (type === 'group') return { kind: 'group', id }
  if (type === 'agent') return (assistant ?? isAssistantAvatar(id)) ? { kind: 'assistant', id, avatar } : { kind: 'agent', id }
  return { kind: 'unavailable', reason: 'unknown-type', avatar: raw }
}

/**
 * The face as one image URL, for `<img>` and for surfaces that hold only an image. Null = unavailable, logged under
 * `surface`. A group's default face is drawn by its surface (`groupAvatarSvg`), whose colours come from the page's theme.
 */
export function faceImageUrl(face: Face, surface: string, theme: AvatarTheme = readAvatarTheme()): string | null {
  switch (face.kind) {
    case 'picture': return face.url
    case 'human': return cached(`h:${theme}:${face.id}`, () => svgUri(withNotionists(face.id, theme)))
    case 'agent': return cached(`a:${theme}:${face.id}`, () => svgUri(beamSvg(face.id, theme)))
    case 'assistant': return assistantPoster(resolveAssistantLook(face.id, face.avatar))
    case 'group': throw new Error(`[Avatar] a default group face is drawn with the page's theme colours, not as an image (${surface})`)
    case 'unavailable':
      if (face.reason === 'invalid') reportInvalidAvatarUrl(face.avatar, surface)
      if (face.reason === 'missing-id') console.error(`[Avatar] missing identity key at ${surface} — a generated default face needs a stable id; display name must never seed it`)
      return null
  }
}

const faces = new Map<string, string>()
function cached(key: string, make: () => string): string {
  let uri = faces.get(key)
  if (!uri) faces.set(key, uri = make())
  return uri
}

const svgUri = (svg: string) => `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`

function withNotionists(id: string, theme: AvatarTheme): string {
  const { svg, extra } = createAvatar(notionists, { seed: id, backgroundColor: [AVATAR_PALETTE[avatarColorIndex(id)][theme].human.slice(1)] }).toJson()
  return withoutBlend(svg, String(extra.body))
}

// Boring Avatars' beam variant (MIT, boringdesigners/boring-avatars 2.0.4; see THIRD_PARTY_NOTICES.md), ported so the
// face takes the identity's own colour: geometry and hashing are unchanged, so every agent keeps its shape.
const BEAM = 36
const digit = (n: number, place: number) => Math.floor((n / 10 ** place) % 10)
const unit = (n: number, range: number, place?: number) => (place && digit(n, place) % 2 === 0 ? -(n % range) : n % range)

function beamSvg(id: string, theme: AvatarTheme): string {
  let n = 0
  for (let i = 0; i < id.length; i++) n = ((n << 5) - n + id.charCodeAt(i)) | 0
  n = Math.abs(n)
  const { body, background } = AVATAR_PALETTE[avatarColorIndex(id)][theme]
  const ink = AVATAR_FEATURE_COLOR
  const x0 = unit(n, 10, 1), y0 = unit(n, 10, 2)
  const x = x0 < 5 ? x0 + BEAM / 9 : x0, y = y0 < 5 ? y0 + BEAM / 9 : y0
  const mouthSpread = unit(n, 3), eyeSpread = unit(n, 5)
  const mouth = !(digit(n, 2) % 2)
    ? `<path d="M15 ${19 + mouthSpread}c2 1 4 1 6 0" stroke="${ink}" fill="none" stroke-linecap="round"/>`
    : `<path d="M13,${19 + mouthSpread} a1,0.75 0 0,0 10,0" fill="${ink}"/>`
  // The mask is luminance: opaque white keeps the face, whatever the theme.
  return `<svg viewBox="0 0 ${BEAM} ${BEAM}" fill="none" xmlns="http://www.w3.org/2000/svg" width="256" height="256">`
    + `<mask id="m" maskUnits="userSpaceOnUse" x="0" y="0" width="${BEAM}" height="${BEAM}"><rect width="${BEAM}" height="${BEAM}" rx="${BEAM * 2}" fill="#FFFFFF"/></mask>`
    + `<g mask="url(#m)"><rect width="${BEAM}" height="${BEAM}" fill="${background}"/>`
    + `<rect x="0" y="0" width="${BEAM}" height="${BEAM}" transform="translate(${x} ${y}) rotate(${unit(n, 360)} ${BEAM / 2} ${BEAM / 2}) scale(${1 + unit(n, BEAM / 12) / 10})" fill="${body}" rx="${!(digit(n, 1) % 2) ? BEAM : BEAM / 6}"/>`
    + `<g transform="translate(${x > BEAM / 6 ? x / 2 : unit(n, 8, 1)} ${y > BEAM / 6 ? y / 2 : unit(n, 7, 2)}) rotate(${unit(n, 10, 3)} ${BEAM / 2} ${BEAM / 2})">`
    + `${mouth}<rect x="${14 - eyeSpread}" y="14" width="1.5" height="2" rx="1" stroke="none" fill="${ink}"/><rect x="${20 + eyeSpread}" y="14" width="1.5" height="2" rx="1" stroke="none" fill="${ink}"/>`
    + `</g></g></svg>`
}
