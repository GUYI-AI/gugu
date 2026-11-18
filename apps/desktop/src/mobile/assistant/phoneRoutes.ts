/** The assistant's own pages share one phone layer and declare their immediate parent here. */
export type PhoneParentRoute<T extends string = string> = { tab: T; sub?: string }

export function phoneParentRoute<T extends string>(route: PhoneParentRoute<T>): PhoneParentRoute<T> | null {
  const sub = route.sub
  if (!sub) return null
  if (sub.startsWith('settings:')) {
    const parent = phoneParentRoute({ tab: route.tab, sub: sub.slice('settings:'.length) })
    return { tab: route.tab, sub: parent?.sub ? `settings:${parent.sub}` : 'settings' }
  }
  if (sub.startsWith('devices:')) return { tab: route.tab, sub: 'devices' }
  return { tab: route.tab }
}
