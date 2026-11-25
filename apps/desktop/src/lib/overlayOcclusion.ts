import { useCallback, useRef } from 'react'
import { rendererLogger } from './log'

/**
 * @@@overlay-occlusion (#3857) — an overlay that opened must be the thing under the pointer at its own center.
 * Owner, over and over: 「弹窗被遮住了没法选」. Each cause looked different (a z-index, a stacking context, a portal into
 * a hidden layer, a clipped container) and each was fixed where it showed up; the symptom is one, so the check is one:
 * once the opening animation has settled, `elementFromPoint` at the popup's center must land inside the popup.
 *
 * Development and tests: throws, so the browser test that opened it fails. Production: one local log line, nothing shown.
 * Skipped when the popup cannot be hit-tested by design (pointer-events: none), has no box, or its center is outside the
 * viewport (a positioner flipped or collided it there — not occlusion).
 */
export type Occlusion = { owner: string; hit: string; covered: string }

const label = (node: Element) => node.getAttribute('data-testid') ?? node.getAttribute('data-slot') ?? node.getAttribute('role')

/** `button[ask] < dialog-content < market-detail-dialog`: the element and up to three labelled ancestors. */
const describe = (el: Element | null): string => {
  if (!el) return 'nothing'
  const parts = [`${el.tagName.toLowerCase()}${label(el) ? `[${label(el)}]` : ''}`]
  for (let node = el.parentElement; node && parts.length < 4; node = node.parentElement) {
    const name = label(node)
    if (name) parts.push(name)
  }
  return parts.join(' < ')
}

// Open order of the probed popups: a popup covered by one opened AFTER it is stacked as designed (a menu or a nested
// dialog opened from it); covered by one opened BEFORE it is the bug.
const openedAt = new WeakMap<Element, number>()
let opened = 0

const coveredByLater = (popup: Element, hit: Element) => {
  const mine = openedAt.get(popup) ?? 0
  for (let node: Element | null = hit; node; node = node.parentElement) {
    const at = openedAt.get(node)
    if (at !== undefined) return at > mine
  }
  return false
}

/** null = on top (or not testable); otherwise who covers it. */
export function findOcclusion(popup: HTMLElement, owner: string): Occlusion | null {
  if (!popup.isConnected) return null
  const doc = popup.ownerDocument
  const view = doc.defaultView
  // A DOM without layout (unit tests' jsdom) cannot hit-test: nothing to judge.
  if (!view || typeof doc.elementFromPoint !== 'function') return null
  const style = view.getComputedStyle(popup)
  if (style.pointerEvents === 'none' || style.display === 'none') return null
  const rect = popup.getBoundingClientRect()
  if (rect.width < 1 || rect.height < 1) return null
  const x = rect.left + rect.width / 2
  const y = rect.top + rect.height / 2
  if (x < 0 || y < 0 || x > view.innerWidth || y > view.innerHeight) return null
  const hit = doc.elementFromPoint(x, y)
  if (hit && popup.contains(hit)) return null
  // A dialog nested in it (Base UI marks the parent) or any overlay opened after it is on top by design.
  if (popup.hasAttribute('data-nested-dialog-open') || (hit && coveredByLater(popup, hit))) return null
  if (style.visibility === 'hidden') return { owner, hit: describe(hit), covered: 'visibility:hidden' }
  return { owner, hit: describe(hit), covered: describe(popup) }
}

const settled = async (el: HTMLElement) => {
  const view = el.ownerDocument.defaultView
  const frame = () => new Promise<void>((resolve) => (view ? view.requestAnimationFrame(() => resolve()) : resolve()))
  // Base UI drops data-starting-style on the next frame; the transition starts only then.
  await frame(); await frame()
  // The popup's own enter animation only (a spinner inside it never finishes); capped so a stuck one cannot hang the probe.
  const animations = typeof el.getAnimations === 'function' ? el.getAnimations() : []
  const finite = animations.filter((animation) => animation.effect?.getTiming().iterations !== Infinity)
  await Promise.race([
    Promise.allSettled(finite.map((animation) => animation.finished)),
    new Promise((resolve) => setTimeout(resolve, 1000)),
  ])
  await frame()
}

let captured: Occlusion[] | null = null

/** Tests that open an overlay underneath on purpose collect the reports instead of failing; `stop()` ends it. */
export function captureOcclusions(): { found: Occlusion[]; stop: () => void } {
  const found: Occlusion[] = []
  captured = found
  return { found, stop: () => { if (captured === found) captured = null } }
}

export function reportOcclusion(found: Occlusion): void {
  if (captured) { captured.push(found); return }
  const message = `Overlay "${found.owner}" opened underneath ${found.hit} (${found.covered}). An overlay must open above the surface it was opened from — see @@@modal-surface / useUiPopupZIndex.`
  if (import.meta.env.DEV) throw new Error(message)
  rendererLogger('overlay/occlusion').warn({ owner: found.owner, hit: found.hit, covered: found.covered }, 'overlay opened underneath another element')
}

/** Checks `popup` once it has settled after opening. */
export async function probeOverlay(popup: HTMLElement, owner: string): Promise<void> {
  let found: Occlusion | null = null
  try {
    await settled(popup)
    // Closed (or closing) while settling: nothing to judge.
    if (!popup.isConnected || popup.hasAttribute('data-closed') || popup.hasAttribute('data-ending-style')) return
    found = findOcclusion(popup, owner)
  } catch (error) {
    // The probe itself failing is never the overlay's fault and never reaches the user: one local line, no throw.
    rendererLogger('overlay/occlusion').warn({ owner, error: String(error) }, 'overlay probe could not measure')
    return
  }
  // Only an overlay that really opened underneath throws (development and tests).
  if (found) reportOcclusion(found)
}

/**
 * Ref for an overlay popup: probes each time a new popup element mounts (Base UI mounts the popup on open). Compose
 * with an existing ref via `mergeRefs`-style callback at the call site.
 */
export function useOverlayOcclusionProbe(owner: string) {
  const last = useRef<HTMLElement | null>(null)
  return useCallback((el: HTMLElement | null) => {
    if (!el || el === last.current) { last.current = el; return }
    last.current = el
    opened += 1
    openedAt.set(el, opened)
    void probeOverlay(el, owner)
  }, [owner])
}

type AnyRef<T> = ((el: T | null) => void) | { current: T | null } | null | undefined

/** The probe composed with the ref a primitive was handed. */
export function useProbedRef<T extends HTMLElement>(owner: string, ref?: AnyRef<T>) {
  const probe = useOverlayOcclusionProbe(owner)
  return useCallback((el: T | null) => {
    probe(el)
    if (typeof ref === 'function') ref(el)
    else if (ref) ref.current = el
  }, [probe, ref])
}
