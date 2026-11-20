import { registerLocaleNamespace } from '@/i18n/runtime'

registerLocaleNamespace('connections',{
  'zh-CN': { device: '设备',allDevices: '全部设备',chooseDevice: '请先选择一台设备，再连接此应用。',platform: '平台',accounts: '账号',disconnect: '断开连接',disconnectTitle: '断开 {{name}}？',
    authorizationUnknown: '状态待确认',disconnectionUnknown: '状态待确认',confirmingAuthorization: '正在确认授权',confirmingDisconnect: '正在确认断开',authorizationFailed: '授权未完成',disconnectionFailed: '断开未完成',connectFailed: '{{name}}连接失败，请重新授权。',
    readUnavailable: '暂时无法读取连接应用，系统将继续尝试，请稍后查看。',
    disconnectFailed: '{{name}}断开失败，请稍后查看连接状态。',defaultFailed: '{{name}}的默认账号设置失败，请稍后重新设置。',
    chooseAppDevice: '{{name}}需要一台设备，请先选择设备再授权。',
    cliPrepareFailed: '{{name}}的授权工具准备失败，请稍后重新连接。',
    authorizationPageFailed: '无法打开{{name}}的授权页，请稍后重试。',copyAuthorizationFailed: '{{name}}的授权链接复制失败，请重试。',
    disconnectBody: '此账号将从{{where}}断开。',defaultAccount: '默认账号',makeDefault: '设为默认',
    onDevice: '此账号保存在 {{device}}',onPlatform: '凭据由平台保管，可在你的设备间使用。' },
  'en-US': { device: 'Device',allDevices: 'All devices',chooseDevice: 'Choose a device before connecting this app.',platform: 'Platform',accounts: 'Accounts',disconnect: 'Disconnect',disconnectTitle: 'Disconnect {{name}}?',
    authorizationUnknown: 'Status unconfirmed',disconnectionUnknown: 'Status unconfirmed',confirmingAuthorization: 'Confirming authorization',confirmingDisconnect: 'Confirming disconnection',authorizationFailed: 'Authorization failed',disconnectionFailed: 'Disconnection failed',connectFailed: '{{name}} could not connect. Authorize it again.',
    readUnavailable: 'Connection apps are unavailable. Gugu will keep trying. Check again later.',
    disconnectFailed: '{{name}} could not disconnect. Check its connection status shortly.',defaultFailed: '{{name}} could not change the default account. Try setting it again shortly.',
    chooseAppDevice: '{{name}} needs a device. Choose one before authorizing.',
    cliPrepareFailed: '{{name}} could not prepare its authorization tool. Try connecting again shortly.',
    authorizationPageFailed: 'Could not open the {{name}} authorization page. Try again later.',copyAuthorizationFailed: '{{name}} could not copy its authorization link. Try copying it again.',
    disconnectBody: 'This account will be disconnected from {{where}}.',defaultAccount: 'Default account',makeDefault: 'Make default',
    onDevice: 'This account is stored on {{device}}',onPlatform: 'The platform keeps this credential for use across your devices.' },
})
