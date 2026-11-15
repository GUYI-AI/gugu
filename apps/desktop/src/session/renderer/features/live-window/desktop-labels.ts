import { registerLocaleNamespace } from '@/i18n/runtime';
import { useTranslation } from 'react-i18next';

registerLocaleNamespace('liveWindow', {
  'en-US': { enlarge: 'Enlarge', minimize: 'Back to small window', tab: 'Open as tab', closeSmall: 'Close small window and keep as tab', web: 'Web', computer: 'Computer', sources: 'Sources' },
  'zh-CN': { enlarge: '放大', minimize: '回到小窗', tab: '放大为页签', closeSmall: '关闭小窗，放进页签', web: '网页', computer: '电脑', sources: '画面来源' },
});
export function useLiveWindowLabels() { return useTranslation('liveWindow').t; }
