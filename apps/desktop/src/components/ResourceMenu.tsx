import type { ReactElement } from 'react'
import type { ResourceContext } from '@/session/shared/resource-actions'
import { resourceMenuItems } from '@/lib/resourceActions'
import { ContextMenu, MenuItem } from '@/components/ui/Menu'

/** Whole-row right click and touch long press; nested controls keep their own interaction. */
export function ResourceMenu({ resource, children, allowOnTrigger = false }: {
  resource: ResourceContext
  children: ReactElement
  allowOnTrigger?: boolean
}) {
  return <ContextMenu.Root onOpenChange={(open, details) => {
    const target = details.event?.target
    const control = target instanceof Element ? target.closest('button,input,textarea,select,a,[role="radio"],[role="switch"]') : null
    if (open && control && !control.hasAttribute('data-resource-menu-trigger')) details.cancel()
  }}>
    <ContextMenu.Trigger render={children} data-resource-menu-trigger={allowOnTrigger ? '' : undefined} />
    <ContextMenu.Content onClick={event => event.stopPropagation()}>
      {resourceMenuItems(resource).map(item => <MenuItem key={item.id} onClick={() => void item.click()}>{item.label}</MenuItem>)}
    </ContextMenu.Content>
  </ContextMenu.Root>
}
