// An App page's member faces (画廊车道 §6): `getContext().chat.members[].avatar` is the face this host already draws for
// someone (`faceImageUrl` of their `identityFace`: their upload, else their default face), made small — 128px, twice the largest App avatar
// (`--em-avatar-lg` 64), WebP for images and the original SVG for Boring defaults — as a `data:` URL, which the App's CSP already lets in (`app-csp.ts` img-src). Drawn
// here, in a renderer: the phone's host calls it, and the desktop's main process asks the window for it.
import { faceImageUrl, identityFace } from './identityFace'
import { resolveAssistantLook } from '../components/assistantFigure/look'
import { settledAssistantPoster } from '../components/assistantFigure/posters'
import { readIdentityDirectoryBridge } from './identityDirectoryBridge'
import { redrawImage } from './redrawImage'
import { readAvatarTheme } from './avatarTheme'

const SIZE = 128
/**
 * How long a face may take. A draw still pending after this is given up on (null) and not kept, so the next one asked for
 * draws again — a promise that never settles, cached, would hold every later notification of this face at "unavailable".
 * Above the agent look still's own wait (runtime.ts STILL_WAIT_MS, 15 s), which is what normally ends a stuck one.
 */
const DRAW_DEADLINE_MS = 20_000

// By id and avatar: a new upload is a new URL, so the URL is the avatar's version; default faces also vary by theme.
const drawn = new Map<string, Promise<string | null>>()

/**
 * Someone's face for an App page: their upload, else their default face from their id (seeded by the id, as every
 * surface seeds it — never the name). Null when it cannot be drawn — an upload that does not load stays a failure, not
 * a default face over it (`identityFace`) — and drawn again the next time it is asked.
 */
export function memberFace(id: string, avatar: string | null): Promise<string | null> {
  const directory = readIdentityDirectoryBridge()
  const identity = directory?.getSnapshot()?.[id]
  if (!identity) { directory?.ensure([id]); return Promise.resolve(null) }
  const who = identityFace({ id, avatar, type: identity.type })
  // The agent default is a few-KB SVG already: nothing to redraw.
  if (who.kind === 'agent') return Promise.resolve(faceImageUrl(who, 'App member face'))
  const key = `${id} ${avatar ?? ''} ${who.kind} ${readAvatarTheme()}`
  const known = drawn.get(key)
  if (known) return known
  // 助理:等引擎把它的定格画好再缩(❌ 缩那张还没画好时顶着的同色图,这里画一次就缓存住了)
  const face = withDeadline(who.kind === 'assistant'
    ? settledAssistantPoster(resolveAssistantLook(who.id, who.avatar), { retryFailed: true }).then(draw, () => null)
    : draw(faceImageUrl(who, 'App member face')))
  drawn.set(key, face)
  // Only this draw's own entry goes: a newer one under the same key stays.
  void face.then((url) => { if (url === null && drawn.get(key) === face) drawn.delete(key) })
  return face
}

/** These people's faces, by id — none for whom one could not be drawn. */
export async function memberFaces(people: readonly { id: string; avatar: string | null }[]): Promise<Record<string, string>> {
  const faces = await Promise.all(people.map(async ({ id, avatar }) => [id, await memberFace(id, avatar)] as const))
  return Object.fromEntries(faces.filter((face): face is readonly [string, string] => face[1] !== null))
}

function withDeadline(face: Promise<string | null>): Promise<string | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), DRAW_DEADLINE_MS)
    const settle = (url: string | null) => { clearTimeout(timer); resolve(url) }
    face.then(settle, () => settle(null))
  })
}

async function draw(src: string | null): Promise<string | null> {
  return src ? redrawImage(src, { size: SIZE, fit: 'cover', type: 'image/webp', quality: 0.8 }) : null
}
