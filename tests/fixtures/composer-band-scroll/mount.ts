import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { registerSessionLocaleResources } from '@renderer/localization/locale-store'
import { Frame, type FrameOptions } from './frame'

export function mountComposerBandFrame(host: HTMLElement, options: FrameOptions = {}) {
  registerSessionLocaleResources()
  const root = createRoot(host)
  root.render(createElement(Frame, options))
  return { render: (next: FrameOptions) => root.render(createElement(Frame, next)), dispose: () => root.unmount() }
}
