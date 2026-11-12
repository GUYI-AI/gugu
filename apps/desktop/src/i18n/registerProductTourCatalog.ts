import enUSProductTour from './locales/en-US/productTour'
import zhCNProductTour from './locales/zh-CN/productTour'
import { registerLocaleNamespace } from './runtime'

registerLocaleNamespace('productTour', {
  'zh-CN': zhCNProductTour,
  'en-US': enUSProductTour,
})
