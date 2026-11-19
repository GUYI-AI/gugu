import { action, makeObservable, observable } from 'mobx'

export interface WidgetSlotGeometry { visible: boolean; ratio: number; bottom: number; nearby?: boolean }
interface Slot extends WidgetSlotGeometry { widgetId: string; element: HTMLElement }

/** One chat's widget slots, wherever that chat is shown (two panels of one chat share them). It owns no App pages. */
export class WidgetPresence {
  readonly owners = observable.map<string, number>()
  readonly preloads = observable.map<string, number>()
  private slots = new Map<number, Slot>()
  private nextToken = 0

  /** `emptied` runs when the last slot is released: nothing of this chat is shown, so nothing is kept for it. */
  constructor(private readonly emptied?: () => void) { makeObservable(this, { register: action, update: action, release: action }) }

  register(widgetId: string, element: HTMLElement): number {
    const token = ++this.nextToken
    this.slots.set(token, { widgetId, element, visible: false, ratio: 0, bottom: 0 })
    return token
  }

  update(token: number, geometry: WidgetSlotGeometry): void {
    const slot = this.slots.get(token)
    if (!slot) return
    Object.assign(slot, geometry, { nearby: geometry.nearby ?? false })
    this.choose(slot.widgetId)
  }

  release(token: number): void {
    const slot = this.slots.get(token)
    if (!slot) return
    this.slots.delete(token)
    this.choose(slot.widgetId)
    if (!this.slots.size) this.emptied?.()
  }

  locate(widgetId: string): void { this.slots.get(this.owners.get(widgetId) ?? -1)?.element.scrollIntoView({ block: 'center', behavior: 'smooth' }) }

  private choose(widgetId: string): void {
    const lowest = (pick: (slot: Slot) => boolean | undefined) => [...this.slots].filter(([, slot]) => slot.widgetId === widgetId && pick(slot))
      .sort(([a, x], [b, y]) => y.bottom - x.bottom || a - b)[0]
    const candidate = lowest(slot => slot.visible)
    const ownerId = this.owners.get(widgetId)
    const current = ownerId === undefined ? undefined : this.slots.get(ownerId)
    if (!candidate) {
      this.owners.delete(widgetId)
      const next = lowest(slot => slot.nearby)
      if (next) this.preloads.set(widgetId, next[0])
      else this.preloads.delete(widgetId)
      return
    }
    this.preloads.delete(widgetId)
    if (!current?.visible || candidate[0] === ownerId || candidate[1].ratio >= 0.5) this.owners.set(widgetId, candidate[0])
  }
}

const presences = new Map<string, WidgetPresence>()
/** The chat's one presence: a resident page is one per chat and widget, so is the choice of its slot. */
export function widgetPresenceOf(chatId: string): WidgetPresence {
  let presence = presences.get(chatId)
  if (!presence) {
    const made: WidgetPresence = new WidgetPresence(() => { if (presences.get(chatId) === made) presences.delete(chatId) })
    presences.set(chatId, presence = made)
  }
  return presence
}
