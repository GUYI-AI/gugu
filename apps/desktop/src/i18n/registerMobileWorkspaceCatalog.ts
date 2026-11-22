import enUSMobileWorkspace from './locales/en-US/mobileWorkspace'
import zhCNMobileWorkspace from './locales/zh-CN/mobileWorkspace'
import { i18n, registerLocaleNamespace } from './runtime'

registerLocaleNamespace('mobileWorkspace', {
  'zh-CN': zhCNMobileWorkspace,
  'en-US': enUSMobileWorkspace,
})

/** Copy for mobile modules outside React; importing this file registers the namespace. */
export const mobileWorkspaceText = (key: string, values: Record<string, string | number> = {}): string =>
  i18n.t(key, { ns: 'mobileWorkspace', ...values })
